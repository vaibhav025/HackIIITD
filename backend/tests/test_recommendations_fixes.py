"""Approval effects, the action list, honest refreshes, and review labelling."""

from __future__ import annotations

from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models.intelligence import Recommendation, ReviewInsight
from app.models.product import Product
from app.models.telegram import TelegramLink
from tests.test_stage5 import (
    NOW,
    app_for,
    make_product,
    make_user,
    seed_check_data,
    seed_gap_runs,
)


async def add_rec(product_id: str, action_text: str, evidence: dict, **extra) -> str:
    async with SessionLocal() as session:
        row = Recommendation(
            product_id=product_id,
            priority="medium",
            action_text=action_text,
            impact_text="Impact.",
            evidence=evidence,
            **extra,
        )
        session.add(row)
        await session.commit()
        return str(row.id)


async def statuses(product_id: str) -> dict[str, str]:
    async with SessionLocal() as session:
        rows = (
            await session.scalars(
                select(Recommendation).where(Recommendation.product_id == product_id)
            )
        ).all()
        return {row.id: row.status for row in rows}


def client_for(user) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test")


@pytest.mark.asyncio
async def test_approve_restock_creates_action_then_done_and_reopen() -> None:
    user = await make_user("Actions")
    product_id = await make_product(user.id)
    rec_id = await add_rec(
        product_id,
        "Check restock and listing health for out-of-stock pins 110017.",
        {"kind": "restock", "oos_pins": ["110017"]},
    )
    async with client_for(user) as client:
        approve = await client.post(f"/api/recommendations/{rec_id}/approve")
        assert approve.status_code == 200
        body = approve.json()
        assert body["status"] == "approved"
        assert body["effect"] == "action_created"
        assert body["message"] == "Approved — added to your action list"

        again = await client.post(f"/api/recommendations/{rec_id}/approve")
        assert again.status_code == 409
        assert again.json()["error"]["code"] == "already_decided"

        actions = (await client.get("/api/actions")).json()
        assert [item["id"] for item in actions["open"]] == [rec_id]
        assert actions["open"][0]["kind"] == "restock"
        assert actions["open"][0]["product_name"]

        done = await client.post(f"/api/recommendations/{rec_id}/done")
        assert done.status_code == 200 and done.json()["status"] == "done"
        twice = await client.post(f"/api/recommendations/{rec_id}/done")
        assert twice.json()["error"]["code"] == "already_decided"
        scoped = (await client.get(f"/api/actions?product_id={product_id}")).json()
        assert scoped["open"] == []
        assert scoped["done"][0]["done_at"] is not None

        reopen = await client.post(f"/api/recommendations/{rec_id}/reopen")
        assert reopen.json()["status"] == "approved"

        dashboard = (await client.get("/api/dashboard")).json()
        tiles = {tile["key"]: tile["value"] for tile in dashboard["tiles"]}
        assert tiles["approved_this_week"] == 1


@pytest.mark.asyncio
async def test_approve_price_records_target_and_seller_panel_action() -> None:
    user = await make_user("Price")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    rec_id = await add_rec(
        product_id,
        "Move your price to ₹29.00 (from ₹31.33).",
        {"kind": "price", "proposed_price": 29.0},
    )
    async with client_for(user) as client:
        approve = await client.post(f"/api/recommendations/{rec_id}/approve")
    assert approve.status_code == 200
    body = approve.json()
    assert body["effect"] == "action_created"
    assert body["action_item"] == "Update price to ₹29.00 on Blinkit seller panel"
    assert "can't change marketplace prices" in body["message"]
    async with SessionLocal() as session:
        row = await session.get(Recommendation, rec_id)
        assert row.evidence["target_price"] == 29.0
        assert row.evidence["base_price"] == pytest.approx(31.33, abs=0.01)


@pytest.mark.asyncio
async def test_guardrail_block_uses_its_own_error_code() -> None:
    user = await make_user("Guard")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        product.floor_price = 30.5
        await session.commit()
    rec_id = await add_rec(
        product_id, "Move your price to ₹29.00 today.", {"proposed_price": 29.0}
    )
    async with client_for(user) as client:
        response = await client.post(f"/api/recommendations/{rec_id}/approve")
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "guardrail_blocked"
    assert "floor_price" in error["message"]
    assert (await statuses(product_id))[rec_id] == "pending"


@pytest.mark.asyncio
async def test_approve_recheck_starts_a_run(monkeypatch: pytest.MonkeyPatch) -> None:
    scheduled: list[str] = []

    def fake_schedule(run_id, **_kwargs):
        scheduled.append(run_id)

    monkeypatch.setattr("app.api.runs.schedule_run", fake_schedule)
    user = await make_user("Recheck")
    product_id = await make_product(user.id)
    rec_id = await add_rec(
        product_id,
        "2 check(s) failed on the latest run; re-run them to fill the gaps.",
        {"kind": "recheck", "failed_pins": 2},
    )
    async with client_for(user) as client:
        response = await client.post(f"/api/recommendations/{rec_id}/approve")
        assert response.status_code == 200
        body = response.json()
        assert body["effect"] == "run_started"
        assert body["run_id"] and scheduled == [body["run_id"]]
        assert body["status"] == "done"

        # A second re-check while that run is active surfaces the runner's 409.
        other = await add_rec(
            product_id,
            "1 pin(s) have stale checks; run a fresh check now.",
            {"kind": "recheck", "stale_pins": 1},
        )
        busy = await client.post(f"/api/recommendations/{other}/approve")
        assert busy.status_code == 409
        assert busy.json()["error"]["code"] != "already_decided"
    assert (await statuses(product_id))[other] == "pending"


@pytest.mark.asyncio
async def test_refresh_is_honest_and_does_not_pile_up() -> None:
    user = await make_user("Refresh")
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        empty = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert empty["reason"] == "no_check_data"
        assert empty["message"].startswith("No new recommendations")

        await seed_check_data(product_id)
        # A single run's gap is not enough for a price suggestion any more.
        await seed_gap_runs(product_id)
        first = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert first["recommendations"]
        assert first["message"].startswith(f"{len(first['recommendations'])} new")

        second = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert second["recommendations"] == []
        assert second["reason"] == "no_change"

        price = next(
            r for r in first["recommendations"] if r["evidence"].get("kind") == "price"
        )
        await client.post(f"/api/recommendations/{price['id']}/dismiss")
        third = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert third["recommendations"] == []
        # The dismissed price advice's gap has not moved by half the threshold,
        # so the threshold stays silent and says why.
        assert "hasn't moved enough" in third["price_note"]
        assert third["message"] == f"No new recommendations — {third['price_note']}"


@pytest.mark.asyncio
async def test_new_price_supersedes_old_pending_and_stale_pending_expires() -> None:
    user = await make_user("Supersede")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    await seed_gap_runs(product_id)
    old_price = await add_rec(
        product_id, "Move your price to ₹30.00 now.", {"kind": "price", "proposed_price": 30.0}
    )
    stale = await add_rec(
        product_id,
        "Some ancient advice nobody acted on.",
        {"kind": "other"},
        created_at=NOW - timedelta(days=10),
    )
    async with client_for(user) as client:
        body = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
    assert body["superseded"] == 1
    assert body["expired"] == 1
    current = await statuses(product_id)
    assert current[old_price] == "superseded"
    assert current[stale] == "expired"
    pending_prices = [
        r for r in body["recommendations"] if r["evidence"].get("kind") == "price"
    ]
    assert len(pending_prices) == 1


@pytest.mark.asyncio
async def test_auto_approval_when_product_does_not_require_it() -> None:
    user = await make_user("Auto")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        product.approval_required = False
        await session.commit()
    async with client_for(user) as client:
        body = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert body["auto_approved"] == len(body["recommendations"]) > 0
        actions = (await client.get(f"/api/actions?product_id={product_id}")).json()
    assert {item["decided_via"] for item in actions["open"]} == {"auto"}


@pytest.mark.asyncio
async def test_send_to_telegram_reports_the_real_reason() -> None:
    user = await make_user("Telegram")
    product_id = await make_product(user.id)
    rec_id = await add_rec(product_id, "Check restock for pins 110017.", {})
    async with client_for(user) as client:
        none = (await client.post(f"/api/recommendations/{rec_id}/send-telegram")).json()
        assert none["telegram_status"] == "no_linked_chats"
        async with SessionLocal() as session:
            session.add(TelegramLink(user_id=user.id, product_id=product_id, chat_id="7"))
            await session.commit()
        offline = (await client.post(f"/api/recommendations/{rec_id}/send-telegram")).json()
    assert offline["telegram_status"] == "bot_offline"
    assert offline["sent_to_chats"] == 0
    assert "isn't running" in offline["message"]


@pytest.mark.asyncio
async def test_dashboard_meters_are_per_product_and_credit_based() -> None:
    user = await make_user("Meters")
    await make_product(user.id, pincodes=["110016", "110017"])
    await make_product(user.id, pincodes=["110019", "110021", "110024"])
    async with client_for(user) as client:
        meters = (await client.get("/api/dashboard")).json()["meters"]
    assert meters["max_pincodes_per_product"] == 3
    assert meters["pincode_limit_per_product"] == 100
    assert meters["daily_credit_budget"] == 1000
    assert meters["credits_today"] == 0


@pytest.mark.asyncio
async def test_review_refresh_reports_whether_anything_changed() -> None:
    user = await make_user("Reviews")
    product_id = await make_product(user.id)
    async with client_for(user) as client:
        nothing = (await client.post(f"/api/products/{product_id}/ai/reviews")).json()
        assert nothing["changed"] is False
        assert "run a check first" in nothing["message"]
        await seed_check_data(product_id)
        first = (await client.post(f"/api/products/{product_id}/ai/reviews")).json()
        assert first["changed"] is True
        again = (await client.post(f"/api/products/{product_id}/ai/reviews")).json()
        assert again["changed"] is False
        assert again["rival_complaints"] == []
    async with SessionLocal() as session:
        own = await session.scalar(
            select(ReviewInsight).where(ReviewInsight.product_id == product_id)
        )
        assert own.competitor_id is None
