"""Stage 7: error envelope, request IDs, grounding, and brief contract checks."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.checks import CheckResult, CheckRun
from app.models.intelligence import Recommendation
from app.models.product import Competitor, Product, ProductPincode
from app.models.telegram import TelegramLink
from app.models.user import Subscription, User
from app.services.ai.base import grounding_violations
from app.services.ai.fallback import FallbackAIProvider
from app.services.alerts import evaluate_alerts

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
) -> str:
    pincodes = pincodes or ["110016", "110017"]
    platforms = platforms or ["blinkit"]
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name=name, search_query=name)
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


async def get_competitor_id(product_id: str) -> str:
    async with SessionLocal() as session:
        competitor = await session.scalar(
            select(Competitor).where(Competitor.product_id == product_id).limit(1)
        )
        assert competitor is not None
        return str(competitor.id)


async def seed_check_data(product_id: str, *, rival_oos: bool = False) -> None:
    competitor_id = await get_competitor_id(product_id)
    await add_result(product_id, None, "blinkit", "110016", price=30.0, in_stock=True, rating=4.4)
    await add_result(product_id, None, "blinkit", "110017", price=36.0, in_stock=True, rating=4.4)
    await add_result(
        product_id,
        competitor_id,
        "blinkit",
        "110016",
        price=29.0,
        in_stock=not rival_oos,
        rating=4.2,
    )
    await add_result(
        product_id, competitor_id, "blinkit", "110017", price=33.0, in_stock=True, rating=4.2
    )


@pytest.mark.asyncio
async def test_errors_have_standard_envelope_and_request_ids() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/products/not-a-product")
    assert response.status_code == 404
    assert response.headers["X-Request-ID"]
    assert response.json()["error"]["code"] == "not_found"
    assert "detail" not in response.json()
    assert response.json()["error"]["message"] == "Product not found"


@pytest.mark.asyncio
async def test_validation_errors_use_envelope() -> None:
    user = await make_user()
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/api/products", json={"name": ""})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_error"
    assert "detail" not in body
    assert {field["loc"] for field in body["error"]["fields"]} >= {"body.name"}


def test_grounding_violations_detect_hallucinated_pin_and_price() -> None:
    context = {
        "all_pins": ["110016", "110017"],
        "oos_pins": [],
        "avg_price": 30.0,
        "cheapest_rival": 29.0,
        "recent_changes": [],
    }
    bad_pin = grounding_violations("Out of stock in 110099 today.", context)
    assert any("110099" in item for item in bad_pin)
    bad_price = grounding_violations("The price is ₹45.50 on Blinkit.", context)
    assert any("45.5" in item for item in bad_price)
    good = grounding_violations(
        "Averages ₹30.00; rival is ₹29.00; checked pins 110016 and 110017.", context
    )
    assert good == []


def test_grounding_allows_recent_change_values() -> None:
    context = {
        "all_pins": ["110016"],
        "oos_pins": [],
        "recent_changes": [
            {"pincode": "110016", "old_value": 28.5, "new_value": 31.0}
        ],
    }
    text = "Price rose from ₹28.50 to ₹31.00 in 110016."
    assert grounding_violations(text, context) == []


@pytest.mark.asyncio
async def test_fallback_parse_alert_rule() -> None:
    provider = FallbackAIProvider()
    oos = await provider.parse_alert_rule("Alert me when we go out of stock")
    assert oos.kind == "oos_any"
    rival = await provider.parse_alert_rule("Tell me when a rival is OOS")
    assert rival.kind == "rival_oos"
    price = await provider.parse_alert_rule("Alert if price drops more than 10%")
    assert price.kind == "price_change_pct"
    assert price.threshold == 10.0
    rating = await provider.parse_alert_rule("Notify me if rating is below 4.2")
    assert rating.kind == "rating_below"
    assert rating.threshold == 4.2
    custom = await provider.parse_alert_rule("Something else entirely")
    assert custom.kind == "custom"


@pytest.mark.asyncio
async def test_post_chat_single_shot_endpoint() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/chat",
            json={"product_id": product_id, "message": "How is my price?"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["conversation_id"]
        assert "₹" in body["answer"]
        assert body["source"] == "fallback"
        assert any(item["metric"] == "avg_price" for item in body["evidence"])

        follow = await client.post(
            "/api/chat",
            json={
                "conversation_id": body["conversation_id"],
                "message": "What about stock?",
            },
        )
        assert follow.status_code == 200
        assert follow.json()["conversation_id"] == body["conversation_id"]

        detail = await client.get(f"/api/chat/conversations/{body['conversation_id']}")
        roles = [row["role"] for row in detail.json()["messages"]]
        assert roles == ["user", "assistant", "user", "assistant"]


@pytest.mark.asyncio
async def test_recommendation_send_telegram_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    async with SessionLocal() as session:
        session.add(
            Recommendation(
                product_id=product_id,
                priority="medium",
                action_text="Check restock for out-of-stock pins.",
                impact_text="Recover sales.",
            )
        )
        session.add(
            TelegramLink(user_id=user.id, product_id=product_id, chat_id="42")
        )
        await session.commit()
        recommendation = await session.scalar(
            select(Recommendation).where(Recommendation.product_id == product_id)
        )
        assert recommendation is not None
        recommendation_id = str(recommendation.id)

    sent: list[str] = []

    async def fake_send(chat_id, text, reply_markup=None) -> bool:
        sent.append(chat_id)
        return True

    monkeypatch.setattr(
        "app.services.telegram.send_telegram_message", fake_send
    )
    monkeypatch.setattr("app.services.telegram.bot_is_running", lambda: True)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/api/recommendations/{recommendation_id}/send-telegram"
        )
        assert response.status_code == 200
        assert response.json()["sent_to_chats"] == 1
        assert response.json()["telegram_status"] == "sent"
    assert sent == ["42"]


@pytest.mark.asyncio
async def test_telegram_status_waiting_connected_lifecycle() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        before = await client.get(f"/api/products/{product_id}/telegram/status")
        assert before.json()["status"] == "not_connected"

        code = await client.post(f"/api/products/{product_id}/telegram/link-code")
        assert code.status_code == 200
        waiting = await client.get(f"/api/products/{product_id}/telegram/status")
        assert waiting.json()["status"] == "waiting"

        async with SessionLocal() as session:
            session.add(
                TelegramLink(
                    user_id=user.id,
                    product_id=product_id,
                    chat_id="42",
                    chat_title="Ops",
                )
            )
            await session.commit()

        connected = await client.get(f"/api/products/{product_id}/telegram/status")
        body = connected.json()
        assert body["status"] == "connected"
        assert body["chat_title"] == "Ops"

        patched = await client.patch(
            f"/api/products/{product_id}/telegram",
            json={"alert_types": ["oos_any", "rival_oos"], "briefing_time": "08:30"},
        )
        assert patched.status_code == 200
        assert patched.json()["links"][0]["alert_types"] == ["oos_any", "rival_oos"]
        assert patched.json()["links"][0]["briefing_time"] == "08:30"

        test = await client.post(f"/api/products/{product_id}/telegram/test")
        assert test.status_code == 200
        assert test.json()["sent"] is False  # bot not running; logged only

        deleted = await client.delete(f"/api/products/{product_id}/telegram")
        assert deleted.status_code == 204
        after = await client.get(f"/api/products/{product_id}/telegram/status")
        assert after.json()["status"] != "connected"


@pytest.mark.asyncio
async def test_rival_oos_alert_kind() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    await seed_check_data(product_id, rival_oos=True)
    from app.models.intelligence import AlertRule

    async with SessionLocal() as session:
        session.add(
            AlertRule(product_id=product_id, kind="rival_oos", active=True)
        )
        await session.commit()
        product = await session.get(Product, product_id)
        alerts = await evaluate_alerts(session, product)
        rival_alerts = [alert for alert in alerts if alert.kind == "rival_oos"]
        assert rival_alerts
        assert "out of stock" in rival_alerts[0].message.lower()
