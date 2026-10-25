"""My Inventory: demo seeding, stock changes, stock-out alerts and Telegram push."""

from __future__ import annotations

import random

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models.intelligence import Alert
from app.models.inventory import InventoryEvent, InventoryItem, Warehouse
from app.models.telegram import TelegramLink
from app.models.user import User, UserSettings
from app.services import telegram as telegram_module
from app.services.alerts import deliver_deferred_alerts
from app.services.inventory import ensure_inventory, simulate_sales
from tests.test_stage6 import app_for, make_product, make_user


def client_for(user: User) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test")


@pytest.fixture
def sent_messages(monkeypatch) -> list[tuple[str, str]]:
    """Pretend the bot is running and record every message it would send."""
    sent: list[tuple[str, str]] = []

    async def fake_send(chat_id: str, text: str, reply_markup=None) -> bool:
        sent.append((chat_id, text))
        return True

    monkeypatch.setattr(telegram_module, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_module, "bot_is_running", lambda: True)
    return sent


async def seeded(user: User, **product_kwargs) -> tuple[str, dict]:
    product_id = await make_product(user.id, **product_kwargs)
    async with client_for(user) as client:
        response = await client.get("/api/inventory")
    assert response.status_code == 200
    return product_id, response.json()


def first_line(body: dict, platform: str = "blinkit") -> dict:
    for product in body["products"]:
        for line in product["warehouses"]:
            if line["warehouse"]["platform"] == platform:
                return line
    raise AssertionError(f"no {platform} line")


async def link_chat(user: User, product_id: str, chat_id: str, alert_types=None) -> None:
    async with SessionLocal() as session:
        session.add(
            TelegramLink(
                user_id=user.id,
                product_id=product_id,
                chat_id=chat_id,
                alert_types=alert_types or [],
            )
        )
        await session.commit()


async def alerts_of(user: User, kind: str) -> list[Alert]:
    async with SessionLocal() as session:
        return list(
            (
                await session.scalars(
                    select(Alert).where(Alert.user_id == user.id, Alert.kind == kind)
                )
            ).all()
        )


# ---------------------------------------------------------------- seeding


@pytest.mark.asyncio
async def test_seeding_is_idempotent_and_realistic() -> None:
    user = await make_user()
    product_id, body = await seeded(user)
    assert body["summary"]["products"] == 1
    product = body["products"][0]
    assert product["product_id"] == product_id
    platforms = {line["warehouse"]["platform"] for line in product["warehouses"]}
    # The product is tracked on Blinkit only: Blinkit dark stores + own warehouse.
    assert platforms == {"blinkit", "own"}
    names = {line["warehouse"]["name"] for line in product["warehouses"]}
    assert "Blinkit dark store · Saket" in names
    assert "Own warehouse · Okhla" in names
    for line in product["warehouses"]:
        assert 1 <= line["quantity"] <= 120
    assert product["total_units"] == sum(line["quantity"] for line in product["warehouses"])
    assert body["recent_events"] == []

    async with client_for(user) as client:
        again = (await client.get("/api/inventory")).json()
    assert again["products"] == body["products"]
    async with SessionLocal() as session:
        warehouses = await session.scalar(
            select(func.count()).select_from(Warehouse).where(Warehouse.user_id == user.id)
        )
        assert warehouses == body["summary"]["warehouses"]
        await ensure_inventory(session, await session.get(User, user.id))
        items = await session.scalar(
            select(func.count())
            .select_from(InventoryItem)
            .where(InventoryItem.product_id == product_id)
        )
    assert items == len(product["warehouses"])


@pytest.mark.asyncio
async def test_new_products_and_platforms_get_lines_on_next_load() -> None:
    user = await make_user()
    await seeded(user)
    second = await make_product(
        user.id, name="Haldiram Aloo Bhujia 200g", platforms=["blinkit", "zepto"]
    )
    async with client_for(user) as client:
        body = (await client.get("/api/inventory")).json()
    assert body["summary"]["products"] == 2
    lines = next(p for p in body["products"] if p["product_id"] == second)["warehouses"]
    assert {line["warehouse"]["platform"] for line in lines} == {"blinkit", "zepto", "own"}


@pytest.mark.asyncio
async def test_inventory_is_owner_scoped() -> None:
    owner = await make_user()
    _product_id, body = await seeded(owner)
    item_id = first_line(body)["item_id"]
    stranger = await make_user(name="Someone Else")
    async with client_for(stranger) as client:
        listed = (await client.get("/api/inventory")).json()
        assert listed["products"] == []
        assert (await client.post(f"/api/inventory/items/{item_id}/sell")).status_code == 404
        assert (
            await client.post(f"/api/inventory/items/{item_id}/restock", json={"units": 5})
        ).status_code == 404
        assert (
            await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 0})
        ).status_code == 404


# ---------------------------------------------------------------- changes


@pytest.mark.asyncio
async def test_sell_restock_and_set() -> None:
    user = await make_user()
    _product_id, body = await seeded(user)
    line = first_line(body)
    item_id, start = line["item_id"], line["quantity"]
    async with client_for(user) as client:
        sold = await client.post(f"/api/inventory/items/{item_id}/sell")
        assert sold.status_code == 200
        assert sold.json()["item"]["quantity"] == start - 1

        restocked = await client.post(
            f"/api/inventory/items/{item_id}/restock", json={"units": 20}
        )
        assert restocked.json()["item"]["quantity"] == start + 19

        updated = await client.put(
            f"/api/inventory/items/{item_id}",
            json={"quantity": 50, "low_stock_threshold": 15},
        )
        item = updated.json()["item"]
        assert (item["quantity"], item["low_stock_threshold"], item["status"]) == (
            50,
            15,
            "in_stock",
        )
        # Selling more than is left stops at 0.
        oversold = await client.post(
            f"/api/inventory/items/{item_id}/sell", json={"units": 500}
        )
        assert oversold.json()["item"]["quantity"] == 0
        assert oversold.json()["item"]["status"] == "out_of_stock"
        again = await client.post(f"/api/inventory/items/{item_id}/sell")
        assert again.status_code == 409
        assert (
            await client.post(f"/api/inventory/items/{item_id}/sell", json={"units": 0})
        ).status_code == 422
        assert (
            await client.put(f"/api/inventory/items/{item_id}", json={"quantity": -1})
        ).status_code == 422

        listed = (await client.get("/api/inventory")).json()
    reasons = [event["reason"] for event in listed["recent_events"]]
    assert reasons == ["sale", "set", "restock", "sale"]
    assert listed["recent_events"][0]["quantity_after"] == 0


# ---------------------------------------------------------------- alerts


@pytest.mark.asyncio
async def test_zeroing_alerts_once_per_transition(sent_messages) -> None:
    user = await make_user()
    product_id, body = await seeded(user)
    line = first_line(body)
    item_id = line["item_id"]
    async with client_for(user) as client:
        zeroed = (
            await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 0})
        ).json()
        assert [alert["kind"] for alert in zeroed["alerts"]] == ["inventory_out"]
        # Not linked yet: in-app alert only.
        assert zeroed["telegram"] == {
            "sent": 0,
            "linked": 0,
            "bot_running": True,
            "skipped": None,
        }
        # Still 0: setting 0 again is no new transition.
        repeat = (
            await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 0})
        ).json()
        assert repeat["alerts"] == []
        assert len(await alerts_of(user, "inventory_out")) == 1

        await client.post(f"/api/inventory/items/{item_id}/restock", json={"units": 20})
        again = (
            await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 0})
        ).json()
        assert [alert["kind"] for alert in again["alerts"]] == ["inventory_out"]
        inbox = (await client.get("/api/me/alerts")).json()
    stored = await alerts_of(user, "inventory_out")
    assert len(stored) == 2
    assert stored[0].product_id == product_id
    assert any(item["kind"] == "inventory_out" for item in inbox["items"])
    assert sent_messages == []


@pytest.mark.asyncio
async def test_low_stock_alert_on_downward_threshold_crossing(sent_messages) -> None:
    user = await make_user()
    _product_id, body = await seeded(user)
    item_id = first_line(body)["item_id"]
    async with client_for(user) as client:
        await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 12})
        crossed = (
            await client.post(f"/api/inventory/items/{item_id}/sell", json={"units": 3})
        ).json()
        assert crossed["item"]["status"] == "low"
        assert [alert["kind"] for alert in crossed["alerts"]] == ["inventory_low"]
        # Already below the threshold: further sales are not a new crossing.
        lower = (await client.post(f"/api/inventory/items/{item_id}/sell")).json()
        assert lower["alerts"] == []
        # Dropping from low straight to 0 is a stock-out, not another low alert.
        out = (
            await client.post(f"/api/inventory/items/{item_id}/sell", json={"units": 99})
        ).json()
        assert [alert["kind"] for alert in out["alerts"]] == ["inventory_out"]
    assert len(await alerts_of(user, "inventory_low")) == 1


@pytest.mark.asyncio
async def test_stock_out_is_pushed_to_linked_telegram_chats(sent_messages) -> None:
    user = await make_user()
    product_id, body = await seeded(user, name="Haldiram Aloo Bhujia 200g")
    line = next(
        line
        for line in body["products"][0]["warehouses"]
        if line["warehouse"]["name"] == "Blinkit dark store · Saket"
    )
    await link_chat(user, product_id, "chat-everything")
    await link_chat(user, product_id, "chat-out-only", ["inventory_out"])
    await link_chat(user, product_id, "chat-prices-only", ["price_change_pct"])
    # Stock-outs ignore quiet hours and the Telegram channel switch.
    async with SessionLocal() as session:
        session.add(
            UserSettings(
                user_id=user.id,
                quiet_hours_start="00:00",
                quiet_hours_end="23:59",
                channels={"telegram": False, "email": False},
            )
        )
        await session.commit()
    async with client_for(user) as client:
        response = (
            await client.put(f"/api/inventory/items/{line['item_id']}", json={"quantity": 0})
        ).json()
    expected = (
        "🚨 Out of stock: Haldiram Aloo Bhujia 200g is at 0 units at "
        "Blinkit dark store · Saket (110017). Restock now."
    )
    assert response["alerts"][0]["message"] == expected
    assert response["alerts"][0]["telegram"]["sent"] == 2
    assert response["telegram"]["sent"] == 2
    assert response["telegram"]["linked"] == 2
    assert sorted(chat for chat, _text in sent_messages) == ["chat-everything", "chat-out-only"]
    assert all(text.startswith(expected) for _chat, text in sent_messages)
    stored = await alerts_of(user, "inventory_out")
    assert stored[0].sent_telegram is True


@pytest.mark.asyncio
async def test_low_stock_respects_telegram_switch(sent_messages) -> None:
    user = await make_user()
    product_id, body = await seeded(user)
    item_id = first_line(body)["item_id"]
    await link_chat(user, product_id, "chat-low")
    async with SessionLocal() as session:
        session.add(UserSettings(user_id=user.id, channels={"telegram": False}))
        await session.commit()
    async with client_for(user) as client:
        await client.put(f"/api/inventory/items/{item_id}", json={"quantity": 11})
        low = (await client.post(f"/api/inventory/items/{item_id}/sell")).json()
    assert low["alerts"][0]["kind"] == "inventory_low"
    assert low["telegram"]["skipped"] == "telegram_off"
    assert sent_messages == []


@pytest.mark.asyncio
async def test_unsent_stock_out_is_not_retried_later(sent_messages, monkeypatch) -> None:
    user = await make_user()
    product_id, body = await seeded(user)
    await link_chat(user, product_id, "chat-late")

    async def bot_down(chat_id: str, text: str, reply_markup=None) -> bool:
        return False

    monkeypatch.setattr(telegram_module, "send_telegram_message", bot_down)
    async with client_for(user) as client:
        zeroed = (
            await client.put(
                f"/api/inventory/items/{first_line(body)['item_id']}", json={"quantity": 0}
            )
        ).json()
    assert zeroed["telegram"]["sent"] == 0
    assert zeroed["telegram"]["linked"] == 1
    sent_later: list[str] = []

    async def record(chat_id: str, text: str, reply_markup=None) -> bool:
        sent_later.append(text)
        return True

    monkeypatch.setattr(telegram_module, "send_telegram_message", record)
    await deliver_deferred_alerts()
    assert not any("Out of stock" in text for text in sent_later)


# ---------------------------------------------------------------- simulate / reset


@pytest.mark.asyncio
async def test_simulated_sales_never_go_below_zero() -> None:
    user = await make_user()
    _product_id, _body = await seeded(user)
    rng = random.Random(7)
    async with SessionLocal() as session:
        db_user = await session.get(User, user.id)
        for _ in range(400):
            await simulate_sales(session, db_user, rng=rng)
        quantities = list(
            (
                await session.scalars(
                    select(InventoryItem.quantity)
                    .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
                    .where(Warehouse.user_id == user.id)
                )
            ).all()
        )
        events = list(
            (
                await session.scalars(
                    select(InventoryEvent)
                    .join(InventoryItem, InventoryItem.id == InventoryEvent.item_id)
                    .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
                    .where(
                        Warehouse.user_id == user.id,
                        InventoryEvent.reason == "simulated_sale",
                    )
                )
            ).all()
        )
    assert all(quantity >= 0 for quantity in quantities)
    assert all(event.quantity_after >= 0 and event.delta < 0 for event in events)
    assert 0 in quantities
    # Every line that reached 0 raised exactly one stock-out alert.
    assert len(await alerts_of(user, "inventory_out")) == quantities.count(0)


@pytest.mark.asyncio
async def test_simulate_endpoint_and_reset() -> None:
    user = await make_user()
    _product_id, body = await seeded(user)
    async with client_for(user) as client:
        simulated = await client.post("/api/inventory/simulate-sales")
        assert simulated.status_code == 200
        changes = simulated.json()["changes"]
        assert 1 <= len(changes) <= 3
        for change in changes:
            assert -3 <= change["delta"] <= -1
            assert change["item"]["quantity"] == change["previous_quantity"] + change["delta"]
        reset = await client.post("/api/inventory/reset")
        assert reset.status_code == 200
        assert reset.json()["items"] == sum(
            len(product["warehouses"]) for product in body["products"]
        )
        after = (await client.get("/api/inventory")).json()
    assert after["products"][0]["total_units"] == body["products"][0]["total_units"]
    assert after["recent_events"] == []
