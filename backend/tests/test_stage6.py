"""Stage 6: alert evaluation, dedupe, delivery, link codes, scheduler logic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.config import get_settings
from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.base import utcnow
from app.models.checks import ChangeEvent, CheckResult, CheckRun
from app.models.intelligence import Alert
from app.models.product import Competitor, Product, ProductPincode
from app.models.telegram import TelegramLink, TelegramLinkCode
from app.models.user import Subscription, User, UserSettings
from app.services import runner as runner_module
from app.services import scheduler as scheduler_module
from app.services.alerts import (
    _within_quiet_hours,
    default_alert_rules,
    deliver_alerts,
    evaluate_alerts,
)
from app.services.scheduler import build_briefing_text, is_due
from app.services.telegram import (
    build_deeplink,
    create_link_code,
    link_code_problem,
    redeem_link_code,
)

NOW = datetime.now(UTC)
QUERY = "Amul Taaza Toned Milk 500 ml"


async def make_user(name: str = "Riya Sharma", plan: str = "pro") -> User:
    async with SessionLocal() as session:
        user = User(name=name, email=f"{uuid4()}@test.local")
        session.add(user)
        await session.flush()
        session.add(Subscription(user_id=user.id, plan=plan, status="active"))
        await session.commit()
        return user


def app_for(user: User):
    app = create_app()

    async def current_user_override() -> User:
        return user

    app.dependency_overrides[get_current_user] = current_user_override
    return app


async def make_product(
    user_id: str,
    *,
    name: str = QUERY,
    pincodes: list[str] | None = None,
    platforms: list[str] | None = None,
    max_change_pct: float = 10.0,
) -> str:
    pincodes = pincodes or ["110016", "110017"]
    platforms = platforms or ["blinkit"]
    async with SessionLocal() as session:
        product = Product(
            user_id=user_id,
            name=name,
            search_query=name,
            max_change_pct=max_change_pct,
        )
        session.add(product)
        await session.flush()
        session.add(
            Competitor(
                product_id=product.id,
                name="Amul Value Pack",
                platform=platforms[0],
                search_query=name,
                confirmed=True,
            )
        )
        session.add_all(
            ProductPincode(product_id=product.id, pincode=code, platform=platform)
            for code in pincodes
            for platform in platforms
        )
        await session.commit()
        return str(product.id)


async def add_result(
    product_id: str,
    competitor_id: str | None,
    platform: str,
    pincode: str,
    *,
    price: float | None = None,
    in_stock: bool | None = None,
    rating: float | None = None,
) -> None:
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.flush()
        session.add(
            CheckResult(
                run_id=run.id,
                product_id=product_id,
                competitor_id=competitor_id,
                platform=platform,
                pincode=pincode,
                in_stock=in_stock,
                price=price,
                rating=rating,
                status="ok",
                raw={},
                checked_at=NOW - timedelta(minutes=5),
            )
        )
        await session.commit()


async def seed_scenario(
    product_id: str,
    *,
    seller_oos: bool = False,
    seller_rating: float = 4.4,
    seller_price: float = 36.0,
    rival_price: float = 30.0,
) -> None:
    async with SessionLocal() as session:
        competitor = await session.scalar(
            select(Competitor).where(Competitor.product_id == product_id)
        )
        competitor_id = str(competitor.id) if competitor else None
    await add_result(
        product_id,
        None,
        "blinkit",
        "110016",
        price=seller_price,
        in_stock=not seller_oos,
        rating=seller_rating,
    )
    await add_result(
        product_id, None, "blinkit", "110017", price=seller_price, in_stock=True,
        rating=seller_rating,
    )
    if competitor_id:
        await add_result(
            product_id, competitor_id, "blinkit", "110016",
            price=rival_price, in_stock=True, rating=4.2,
        )
        await add_result(
            product_id, competitor_id, "blinkit", "110017",
            price=rival_price, in_stock=True, rating=4.2,
        )


async def get_product(product_id: str) -> Product:
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        assert product is not None
        return product


def test_is_due_rules() -> None:
    now = NOW
    assert is_due(None, 6, now) is True
    assert is_due(now - timedelta(hours=5), 6, now) is False
    assert is_due(now - timedelta(hours=6), 6, now) is True
    assert is_due(now - timedelta(hours=7), 6, now) is True


def test_default_alert_rules_cover_all_kinds() -> None:
    product = Product(user_id="u", name="X", search_query="X", max_change_pct=12.0)
    rules = default_alert_rules(product)
    kinds = {rule["kind"] for rule in rules}
    assert kinds == {"oos_any", "price_change_pct", "rating_below", "price_gap_pct"}
    price_rule = next(rule for rule in rules if rule["kind"] == "price_change_pct")
    assert price_rule["threshold"] == 12.0


def test_quiet_hours_window() -> None:
    settings = UserSettings(
        user_id="u", quiet_hours_start="22:00", quiet_hours_end="07:00"
    )
    assert _within_quiet_hours(settings, NOW.replace(hour=23, minute=30)) is True
    assert _within_quiet_hours(settings, NOW.replace(hour=3, minute=0)) is True
    assert _within_quiet_hours(settings, NOW.replace(hour=12, minute=0)) is False
    same_day = UserSettings(
        user_id="u", quiet_hours_start="13:00", quiet_hours_end="15:00"
    )
    assert _within_quiet_hours(same_day, NOW.replace(hour=14, minute=0)) is True
    assert _within_quiet_hours(None, NOW) is False


@pytest.mark.asyncio
async def test_evaluate_alerts_oos_and_dedupe() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_scenario(product_id, seller_oos=True, seller_price=30.0, rival_price=30.0)
    product = await get_product(product_id)
    async with SessionLocal() as session:
        alerts = await evaluate_alerts(session, product)
        kinds = {alert.kind for alert in alerts}
        assert "oos_any" in kinds
        assert len(alerts) >= 1
        again = await evaluate_alerts(session, product)
        assert again == []


@pytest.mark.asyncio
async def test_evaluate_alerts_price_gap_and_rating() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_scenario(
        product_id, seller_price=36.0, rival_price=30.0, seller_rating=3.9
    )
    product = await get_product(product_id)
    async with SessionLocal() as session:
        alerts = await evaluate_alerts(session, product)
        kinds = {alert.kind for alert in alerts}
        assert "price_gap_pct" in kinds
        assert "rating_below" in kinds
        gap = next(alert for alert in alerts if alert.kind == "price_gap_pct")
        assert gap.evidence["gap_pct"] == pytest.approx(20.0, abs=0.1)


@pytest.mark.asyncio
async def test_evaluate_alerts_price_change_threshold() -> None:
    user = await make_user()
    product_id = await make_product(user.id, max_change_pct=10.0)
    product = await get_product(product_id)
    async with SessionLocal() as session:
        session.add_all(
            [
                ChangeEvent(
                    product_id=product_id,
                    platform="blinkit",
                    pincode="110016",
                    kind="price_rise",
                    old_value=30.0,
                    new_value=36.0,
                    detected_at=NOW - timedelta(minutes=10),
                ),
                ChangeEvent(
                    product_id=product_id,
                    platform="blinkit",
                    pincode="110017",
                    kind="price_rise",
                    old_value=30.0,
                    new_value=31.0,
                    detected_at=NOW - timedelta(minutes=10),
                ),
            ]
        )
        await session.commit()
        alerts = await evaluate_alerts(session, product)
        price_alerts = [alert for alert in alerts if alert.kind == "price_change_pct"]
        assert len(price_alerts) == 1
        assert price_alerts[0].evidence["pct"] == pytest.approx(20.0, abs=0.1)


@pytest.mark.asyncio
async def test_alert_inbox_api_and_isolation() -> None:
    owner = await make_user("Owner")
    stranger = await make_user("Stranger")
    product_id = await make_product(owner.id)
    await seed_scenario(product_id, seller_oos=True)
    product = await get_product(product_id)
    async with SessionLocal() as session:
        await evaluate_alerts(session, product)

    owner_app = app_for(owner)
    async with AsyncClient(
        transport=ASGITransport(app=owner_app), base_url="http://test"
    ) as client:
        listing = await client.get("/api/me/alerts")
        assert listing.status_code == 200
        body = listing.json()
        assert len(body["items"]) >= 1
        assert body["unread"] >= 1
        alert_id = body["items"][0]["id"]
        assert body["items"][0]["product_name"] == QUERY

        read = await client.post(f"/api/me/alerts/{alert_id}/read")
        assert read.status_code == 200
        assert read.json()["marked"] == 1

        read_all = await client.post("/api/me/alerts/read-all")
        assert read_all.status_code == 200

        unread_listing = await client.get("/api/me/alerts", params={"unread": "true"})
        assert unread_listing.json()["unread"] == 0

    stranger_app = app_for(stranger)
    async with AsyncClient(
        transport=ASGITransport(app=stranger_app), base_url="http://test"
    ) as client:
        listing = await client.get("/api/me/alerts")
        assert listing.json()["items"] == []
        denied = await client.post(f"/api/me/alerts/{alert_id}/read")
        assert denied.status_code == 404


@pytest.mark.asyncio
async def test_alert_rules_put_and_get() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        defaults = await client.get(f"/api/products/{product_id}/alert-rules")
        assert defaults.status_code == 200
        assert {rule["kind"] for rule in defaults.json()} == {
            "oos_any",
            "price_change_pct",
            "rating_below",
            "price_gap_pct",
        }

        replaced = await client.put(
            f"/api/products/{product_id}/alert-rules",
            json={
                "rules": [
                    {"kind": "oos_any", "threshold": None},
                    {"kind": "rating_below", "threshold": 4.5},
                ]
            },
        )
        assert replaced.status_code == 200

        after = await client.get(f"/api/products/{product_id}/alert-rules")
        assert len(after.json()) == 2
        rating = next(rule for rule in after.json() if rule["kind"] == "rating_below")
        assert rating["threshold"] == 4.5


@pytest.mark.asyncio
async def test_link_code_flow_and_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        code = await create_link_code(session, user_id=user.id, product_id=product_id)
        assert code.code.startswith("SS-")
        assert len(code.code.split("-")) == 3
        assert code.expires_at > utcnow()
        # Deep links need a bot username; without one there is no link.
        assert build_deeplink(code.code) is None
        monkeypatch.setattr(get_settings(), "telegram_bot_username", "ShelfSenseBot")
        assert build_deeplink(code.code) == f"https://t.me/ShelfSenseBot?start={code.code}"

        link = await redeem_link_code(
            session, code_value=code.code, chat_id="42", chat_title="Ops"
        )
        assert link is not None
        # Tapping Start twice in the same chat keeps the link instead of "invalid".
        again = await redeem_link_code(session, code_value=code.code, chat_id="42")
        assert again is not None and again.id == link.id
        assert link.user_id == user.id
        assert link.product_id == product_id
        assert link.chat_id == "42"

        reuse = await redeem_link_code(session, code_value=code.code, chat_id="43")
        assert reuse is None
        assert "already used by another chat" in await link_code_problem(session, code.code)
        assert "doesn't exist" in await link_code_problem(session, "SS-NOPE-NOPE")

        expired_code = f"SS-9999-EXP{uuid4().hex[:4].upper()}"
        expired = TelegramLinkCode(
            code=expired_code,
            user_id=user.id,
            product_id=product_id,
            chat_type="private",
            expires_at=utcnow() - timedelta(minutes=1),
        )
        session.add(expired)
        await session.commit()
        result = await redeem_link_code(session, code_value=expired_code, chat_id="42")
        assert result is None


@pytest.mark.asyncio
async def test_telegram_endpoints_without_token() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Link codes still work without a token; delivery just logs.
        code = await client.post(f"/api/products/{product_id}/telegram/link-code")
        assert code.status_code == 200
        body = code.json()
        assert body["code"].startswith("SS-")
        assert "deep_link" in body

        status = await client.get(f"/api/products/{product_id}/telegram/status")
        assert status.status_code == 200
        status_body = status.json()
        assert status_body["status"] == "waiting"
        assert status_body["enabled"] is False
        assert status_body["bot_running"] is False
        assert status_body["links"] == []

        patched = await client.patch(
            f"/api/products/{product_id}/telegram",
            json={"alert_types": ["oos_any"], "briefing_time": "09:00"},
        )
        assert patched.status_code == 404

        test = await client.post(f"/api/products/{product_id}/telegram/test")
        assert test.status_code == 404

        deleted = await client.delete(f"/api/products/{product_id}/telegram")
        assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_telegram_link_code_with_token(monkeypatch: pytest.MonkeyPatch) -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    settings = get_settings()
    monkeypatch.setattr(settings, "telegram_bot_token", "123:abc")
    monkeypatch.setattr(settings, "telegram_bot_username", "shelfsense_bot")
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(f"/api/products/{product_id}/telegram/link-code")
        assert response.status_code == 200
        body = response.json()
        assert body["code"].startswith("SS-")
        assert body["deep_link"].startswith("https://t.me/shelfsense_bot?start=")

        group = await client.post(
            f"/api/products/{product_id}/telegram/link-code",
            json={"chat_type": "group"},
        )
        assert group.status_code == 200
        assert group.json()["deep_link"].startswith(
            "https://t.me/shelfsense_bot?startgroup="
        )


@pytest.mark.asyncio
async def test_deliver_alerts_respects_links_and_quiet_hours(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_scenario(product_id, seller_oos=True)
    product = await get_product(product_id)
    sent: list[tuple[str, str]] = []

    async def fake_send(chat_id: str, text: str) -> bool:
        sent.append((chat_id, text))
        return True

    monkeypatch.setattr("app.services.telegram.send_telegram_message", fake_send)

    async with SessionLocal() as session:
        session.add(
            TelegramLink(
                user_id=user.id, product_id=product_id, chat_id="42", alert_types=[]
            )
        )
        await session.commit()
        alerts = await evaluate_alerts(session, product)
        assert alerts
        delivered = await deliver_alerts(session, alerts)
        assert delivered >= 1
        assert sent and sent[0][0] == "42"
        assert "ShelfSense" in sent[0][1]

        session.add(
            UserSettings(
                user_id=user.id,
                briefing_time="09:00",
                quiet_hours_start="00:00",
                quiet_hours_end="23:59",
            )
        )
        await session.commit()
        # Force a fresh alert; quiet hours now block delivery.
        await session.execute(delete(Alert).where(Alert.user_id == user.id))
        await session.commit()
        fresh = await evaluate_alerts(session, product)
        assert fresh
        sent.clear()
        delivered_quiet = await deliver_alerts(session, fresh)
        assert delivered_quiet == 0
        assert sent == []


@pytest.mark.asyncio
async def test_build_briefing_text() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_scenario(product_id, seller_oos=True)
    product = await get_product(product_id)
    async with SessionLocal() as session:
        session.add(
            Alert(
                user_id=user.id,
                product_id=product_id,
                kind="oos_any",
                message="Out of stock in 110016.",
                dedupe_key=f"brief:{uuid4()}",
            )
        )
        await session.commit()
        text = await build_briefing_text(session, product)
        assert text is not None
        assert QUERY in text
        assert "Out of stock" in text


@pytest.mark.asyncio
async def test_scan_due_products_skips_paused() -> None:
    user = await make_user(plan="pro")
    paused_id = await make_product(user.id, name="Paused product")
    async with SessionLocal() as session:
        product = await session.get(Product, paused_id)
        product.paused = True
        await session.commit()

    created: list[str] = []

    async def fake_schedule_run(run_id: str, *, product_id: str, user_id: str, jobs):
        created.append(run_id)

    original = runner_module.schedule_run
    runner_module.schedule_run = fake_schedule_run
    try:
        started = await scheduler_module.scan_due_products()
    finally:
        runner_module.schedule_run = original
    assert isinstance(started, int)
    async with SessionLocal() as session:
        paused_run = await session.scalar(
            select(CheckRun).where(CheckRun.product_id == paused_id)
        )
        assert paused_run is None
