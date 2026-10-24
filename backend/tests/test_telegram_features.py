"""Telegram bot features: /compare text, check flow guards, command list."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.telegram_features import (
    BOT_COMMANDS,
    AppSummary,
    compare_text,
    handle_check_callback,
    last_checked_text,
    report_text,
    time_ago,
)


def test_compare_text_marks_the_cheapest_in_stock_app() -> None:
    text = compare_text(
        "Amul Taaza",
        [
            AppSummary("zepto", 17.0, 3, 3, False),
            AppSummary("flipkart", 29.0, 3, 3, True),
            AppSummary("amazon", None, 0, 3, True),
        ],
    )
    assert "Zepto: ₹17 · 3/3 pins in stock ⭐ cheapest" in text
    assert "Flipkart: ₹29 (listing-wide)" in text
    assert "Amazon: out of stock" in text
    assert "no check results yet" in compare_text("X", [])


def test_bot_command_menu_lists_every_feature() -> None:
    names = {name for name, _ in BOT_COMMANDS}
    assert {"menu", "status", "compare", "check", "ask", "link", "stop"} <= names


class _Query:
    def __init__(self, data: str) -> None:
        self.data = data
        self.answers: list[str] = []
        self.edits: list[str] = []
        self.message = None

    async def answer(self, text: str = "") -> None:
        self.answers.append(text)

    async def edit_message_text(self, text: str, **_kwargs) -> None:
        self.edits.append(text)


@pytest.mark.asyncio
async def test_check_buttons_refuse_chats_not_linked_to_the_product() -> None:
    query = _Query("chk:r:not-a-product:zepto:110017")
    update = SimpleNamespace(
        callback_query=query,
        effective_chat=SimpleNamespace(id=999, type="private"),
        effective_user=None,
    )
    assert await handle_check_callback(update, None) is True
    assert query.answers == ["This chat is not linked to that product."]
    assert query.edits == []  # nothing started


@pytest.mark.asyncio
async def test_cancel_button_runs_nothing() -> None:
    query = _Query("chk:x")
    update = SimpleNamespace(callback_query=query, effective_chat=SimpleNamespace(id=1, type="private"))
    assert await handle_check_callback(update, None) is True
    assert query.edits == ["Check cancelled. Nothing was run."]


@pytest.mark.asyncio
async def test_all_products_chat_covers_every_product_and_naming_one_focuses() -> None:
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://t") as client:
        names = [p["name"] for p in (await client.get("/api/products")).json()]
        overall = (await client.post("/api/chat", json={"message": "Where am I out of stock?"})).json()
        focused = (await client.post("/api/chat", json={"message": "Is Paper Boat Aamras in stock?"})).json()
    assert overall["answer"].startswith("Across your")
    assert sum(name in overall["answer"] for name in names) >= 2
    assert "Paper Boat" in focused["answer"] and "Across your" not in focused["answer"]


@pytest.mark.asyncio
async def test_plain_messages_get_a_reply_instead_of_silence() -> None:
    from app.services.telegram import _handle_text

    class Msg:
        def __init__(self, text: str) -> None:
            self.text = text
            self.replies: list[str] = []

        async def reply_text(self, text: str, **_kwargs) -> None:
            self.replies.append(text)

    message = Msg("hi")
    update = SimpleNamespace(
        effective_message=message, effective_chat=SimpleNamespace(id=424242, type="private")
    )
    await _handle_text(update, None)
    assert message.replies and "not connected" in message.replies[0]


def test_report_covers_all_four_apps_with_last_checked() -> None:
    from datetime import UTC, datetime, timedelta

    now = datetime(2026, 10, 19, 12, 0, tzinfo=UTC)
    apps = [
        AppSummary("zepto", 17.0, 2, 3, False, now - timedelta(minutes=5)),
        AppSummary("flipkart", None, 0, 3, True, now - timedelta(hours=2)),
    ]
    text = report_text("Amul", apps, now)
    assert "✅ Zepto: ₹17 · 2/3 pins in stock · 5 min ago" in text
    assert "❌ Flipkart: out of stock (listing-wide) · 2 h ago" in text
    assert "⚪ Instamart: not checked yet" in text and "⚪ Amazon: not checked yet" in text
    assert "🕒 Last checked: 5 min ago" in text
    assert "Instamart never" in last_checked_text("Amul", apps, now)
    assert time_ago(None) == "never"
