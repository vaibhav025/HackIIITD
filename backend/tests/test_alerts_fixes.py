"""Alert rules, Telegram preferences, competitors and scheduler fixes."""

from __future__ import annotations

from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models.base import utcnow
from app.models.checks import ChangeEvent, CheckRun, CreditLedger
from app.models.intelligence import Alert
from app.models.product import Product
from app.models.telegram import TelegramLink
from app.models.user import User, UserSettings
from app.services import runner as runner_module
from app.services import scheduler as scheduler_module
from app.services.alerts import (
    deliver_alerts,
    effective_rules,
    link_wants,
    replace_alert_rules,
    telegram_types_in,
    telegram_types_out,
)
from app.services.scheduler import boosted_interval_hours
from tests.test_stage6 import app_for, make_product, make_user


def client_for(user: User) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test")


# ---------------------------------------------------------------- alert rules


@pytest.mark.asyncio
async def test_inactive_rule_stays_listed_but_is_not_evaluated() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        saved = await client.put(
            f"/api/products/{product_id}/alert-rules",
            json={
                "rules": [
                    {"kind": "oos_any", "active": False},
                    {"kind": "rating_below", "threshold": 4.2, "active": True},
                ]
            },
        )
        assert saved.status_code == 200
        listed = (await client.get(f"/api/products/{product_id}/alert-rules")).json()
        assert {(rule["kind"], rule["active"]) for rule in listed} == {
            ("oos_any", False),
            ("rating_below", True),
        }
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        kinds = [rule.kind for rule in await effective_rules(session, product)]
    assert kinds == ["rating_below"]


@pytest.mark.asyncio
async def test_cleared_rules_stay_empty_instead_of_defaults() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        await replace_alert_rules(session, product_id, [])
    async with client_for(user) as client:
        listed = await client.get(f"/api/products/{product_id}/alert-rules")
        assert listed.status_code == 200
        assert listed.json() == []
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        assert await effective_rules(session, product) == []
        # Saving rules again replaces the "cleared" marker.
        await replace_alert_rules(
            session, product_id, [{"kind": "oos_any", "threshold": None}]
        )
        assert [rule.kind for rule in await effective_rules(session, product)] == [
            "oos_any"
        ]


@pytest.mark.asyncio
async def test_parse_rejects_unsupported_rule_text() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        rejected = await client.post(
            f"/api/products/{product_id}/alert-rules/parse",
            json={"text": "tell me when something interesting happens"},
        )
        assert rejected.status_code == 422
        body = rejected.json()["error"]
        assert body["code"] == "unsupported_rule"
        assert "out of stock" in body["message"]

        nowhere = await client.post(
            f"/api/products/{product_id}/alert-rules/parse",
            json={"text": "Alert me if we go out of stock in Atlantis"},
        )
        assert nowhere.status_code == 422

        gap = await client.post(
            f"/api/products/{product_id}/alert-rules/parse",
            json={"text": "Alert me when my price is more than 7% above the rival"},
        )
        assert gap.status_code == 200
        assert gap.json()["kind"] == "price_gap_pct"
        assert gap.json()["threshold"] == 7.0

        oos = await client.post(
            f"/api/products/{product_id}/alert-rules/parse",
            json={"text": "Alert me if we go out of stock"},
        )
        assert oos.json()["kind"] == "oos_any"


# ------------------------------------------------------------------ telegram


def test_telegram_alert_type_semantics() -> None:
    assert telegram_types_in(None) == []
    assert telegram_types_out([]) is None
    assert telegram_types_in([]) == ["none"]
    assert telegram_types_out(["none"]) == []
    assert telegram_types_out(telegram_types_in(["oos_area", "briefing"])) == [
        "oos_area",
        "briefing",
    ]
    assert link_wants(TelegramLink(alert_types=[]), "briefing")
    assert not link_wants(TelegramLink(alert_types=["none"]), "oos_any")
    assert not link_wants(TelegramLink(alert_types=["oos_any"]), "briefing")
    assert link_wants(TelegramLink(alert_types=["rating_below"]), "rating_drop")


@pytest.mark.asyncio
async def test_telegram_patch_round_trips_all_and_none() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        session.add(
            TelegramLink(
                user_id=user.id, product_id=product_id, chat_id="fix-chat", alert_types=[]
            )
        )
        await session.commit()
    async with client_for(user) as client:
        url = f"/api/products/{product_id}/telegram"
        status = (await client.get(f"{url}/status")).json()
        assert status["links"][0]["alert_types"] is None

        nothing = await client.patch(url, json={"alert_types": []})
        assert nothing.status_code == 200
        assert nothing.json()["links"][0]["alert_types"] == []

        some = await client.patch(url, json={"alert_types": ["oos_area", "custom"]})
        assert some.json()["links"][0]["alert_types"] == ["oos_area", "custom"]

        everything = await client.patch(url, json={"alert_types": None})
        assert everything.json()["links"][0]["alert_types"] is None


@pytest.mark.asyncio
async def test_deliver_alerts_respects_nothing_and_area_kinds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[str] = []

    async def fake_send(chat_id: str, text: str, photo=None) -> bool:
        sent.append(chat_id)
        return True

    monkeypatch.setattr("app.services.telegram_features.send_alert", fake_send)
    user = await make_user()
    product_id = await make_product(user.id)
    past = utcnow() - timedelta(hours=1)
    async with SessionLocal() as session:
        session.add_all(
            [
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="area-chat",
                             alert_types=["oos_area"], connected_at=past),
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="mute-chat",
                             alert_types=["none"], connected_at=past),
            ]
        )
        alert = Alert(
            user_id=user.id,
            product_id=product_id,
            kind="oos_area",
            message="Out of stock in South Delhi",
            dedupe_key=f"fix-area:{product_id}",
        )
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
        user_settings = await session.get(UserSettings, user.id)
        if user_settings is not None:
            user_settings.quiet_hours_start = None
            user_settings.quiet_hours_end = None
            await session.commit()
        await deliver_alerts(session, [alert])
    assert sent == ["area-chat"]


@pytest.mark.asyncio
async def test_link_code_has_no_deeplink_without_bot(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "telegram_bot_username", "ShelfSenseAI_bot")
    user = await make_user()
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        code = await client.post(f"/api/products/{product_id}/telegram/link-code", json={})
        assert code.status_code == 200
        assert code.json()["deep_link"] is None
        status = (await client.get(f"/api/products/{product_id}/telegram/status")).json()
        assert status["bot_username"] is None
        assert status["simulate_available"] is True

        monkeypatch.setattr(settings, "app_env", "production")
        blocked = await client.post(
            f"/api/products/{product_id}/telegram/simulate-link",
            json={"code": code.json()["code"]},
        )
        assert blocked.status_code == 404
        status = (await client.get(f"/api/products/{product_id}/telegram/status")).json()
        assert status["simulate_available"] is False


@pytest.mark.asyncio
async def test_briefings_honour_opt_in_and_channel_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "telegram_bot_token", "123:abc")
    sent: list[str] = []

    async def fake_send(chat_id: str, text: str) -> bool:
        sent.append(chat_id)
        return True

    monkeypatch.setattr("app.services.telegram.send_telegram_message", fake_send)
    user = await make_user()
    muted_user = await make_user("Muted Seller")
    product_id = await make_product(user.id)
    muted_product = await make_product(muted_user.id)
    async with SessionLocal() as session:
        muted_settings = await session.get(UserSettings, muted_user.id)
        if muted_settings is None:
            session.add(UserSettings(user_id=muted_user.id, channels={"telegram": False}))
        else:
            muted_settings.channels = {"telegram": False}
        now_text = scheduler_module._local_time_text(scheduler_module._local_now(user))
        session.add_all(
            [
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="brief-all",
                             alert_types=[], briefing_time=now_text),
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="brief-opt",
                             alert_types=["briefing"], briefing_time=now_text),
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="brief-no",
                             alert_types=["oos_any"], briefing_time=now_text),
                TelegramLink(user_id=user.id, product_id=product_id, chat_id="brief-none",
                             alert_types=["none"], briefing_time=now_text),
                TelegramLink(user_id=muted_user.id, product_id=muted_product,
                             chat_id="brief-muted", alert_types=[], briefing_time=now_text),
            ]
        )
        await session.commit()
    await scheduler_module.send_briefings()
    ours = {chat for chat in sent if chat.startswith("brief-")}
    assert ours == {"brief-all", "brief-opt"}
    # Persisted per day: a second pass (even after a restart) sends nothing new.
    scheduler_module._briefings_sent.clear()
    sent.clear()
    await scheduler_module.send_briefings()
    assert not {chat for chat in sent if chat.startswith("brief-")}


# --------------------------------------------------------------- competitors


@pytest.mark.asyncio
async def test_duplicate_competitor_is_rejected() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        url = f"/api/products/{product_id}/competitors"
        body = {"name": "Mother Dairy Toned Milk", "platform": "zepto"}
        assert (await client.post(url, json=body)).status_code == 201
        again = await client.post(url, json={**body, "name": " mother dairy  toned milk "})
        assert again.status_code == 409
        assert again.json()["error"]["code"] == "duplicate_competitor"
        other_platform = await client.post(url, json={**body, "platform": "blinkit"})
        assert other_platform.status_code == 201

        linked = {"name": "Rival A", "platform": "amazon", "url": "https://amazon.in/dp/X1"}
        assert (await client.post(url, json=linked)).status_code == 201
        same_url = await client.post(
            url, json={**linked, "name": "Renamed", "url": "https://amazon.in/dp/X1/"}
        )
        assert same_url.status_code == 409


@pytest.mark.asyncio
async def test_discover_is_honest_demo_and_skips_tracked() -> None:
    user = await make_user()
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        product.brand = "Amul"
        await session.commit()
    async with client_for(user) as client:
        url = f"/api/products/{product_id}/competitors/discover"
        first = await client.post(url, json={})
        assert first.status_code == 200
        data = first.json()
        assert data["source"] == "demo"
        assert data["suggestions"]
        for suggestion in data["suggestions"]:
            assert suggestion["url"] is None
            assert "amul" not in suggestion["search_query"].lower()
        picked = data["suggestions"][0]
        added = await client.post(
            f"/api/products/{product_id}/competitors", json={**picked, "confirmed": True}
        )
        assert added.status_code == 201
        second = (await client.post(url, json={})).json()
        assert picked["name"] not in {item["name"] for item in second["suggestions"]}


# ----------------------------------------------------------------- scheduler


def test_boosted_interval_respects_plan_floor() -> None:
    assert boosted_interval_hours(24, 3) == 12
    assert boosted_interval_hours(168, None) == 24
    assert boosted_interval_hours(3, None) == 3
    assert boosted_interval_hours(168, 168) == 168
    assert boosted_interval_hours(12, 12) == 12


async def _scan(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    scheduled: list[str] = []

    async def fake_schedule_run(run_id: str, *, product_id: str, user_id: str, jobs):
        scheduled.append(product_id)

    monkeypatch.setattr(runner_module, "schedule_run", fake_schedule_run)
    await scheduler_module.scan_due_products()
    return scheduled


async def _finished_run(product_id: str, hours_ago: float) -> None:
    async with SessionLocal() as session:
        when = utcnow() - timedelta(hours=hours_ago)
        session.add(
            CheckRun(
                product_id=product_id,
                trigger="manual",
                status="done",
                started_at=when,
                finished_at=when,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_volatile_boost_checks_sooner(monkeypatch: pytest.MonkeyPatch) -> None:
    user = await make_user(plan="pro")
    calm_id = await make_product(user.id, name="Calm product")
    boosted_id = await make_product(user.id, name="Volatile product")
    for product_id in (calm_id, boosted_id):
        await _finished_run(product_id, hours_ago=13)
    async with SessionLocal() as session:
        for product_id in (calm_id, boosted_id):
            product = await session.get(Product, product_id)
            product.check_frequency = "daily"
            product.volatile_boost = True
        session.add(
            ChangeEvent(
                product_id=boosted_id,
                platform="blinkit",
                pincode="110016",
                kind="price_drop",
                old_value=100.0,
                new_value=88.0,
            )
        )
        await session.commit()
    scheduled = await _scan(monkeypatch)
    assert boosted_id in scheduled
    assert calm_id not in scheduled


@pytest.mark.asyncio
async def test_scheduler_skips_runs_larger_than_remaining_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = await make_user(plan="pro")
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        product.check_frequency = "3h"
        # 2 pincodes x (own + 1 rival) = 4 jobs; leave only 2 credits.
        session.add(CreditLedger(user_id=user.id, credits=998, reason="filler"))
        await session.commit()
    assert product_id not in await _scan(monkeypatch)
    async with SessionLocal() as session:
        assert (
            await session.scalar(select(CheckRun.id).where(CheckRun.product_id == product_id))
            is None
        )
        session.add(CreditLedger(user_id=user.id, credits=-4, reason="refund"))
        await session.commit()
    assert product_id in await _scan(monkeypatch)
