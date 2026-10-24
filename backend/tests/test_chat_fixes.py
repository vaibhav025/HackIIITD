"""Chat assistant fixes: offline intent router, per-platform checkout answers,
conversation delete, Gemini failure fallback."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.checks import CheckResult, CheckRun
from app.models.intelligence import Recommendation
from app.models.product import Competitor, Product, ProductPincode
from app.models.user import Subscription, User
from app.services.ai import gemini_client as gemini_module
from app.services.ai import with_fallback
from app.services.ai.base import grounding_violations, is_allowed_action_path
from app.services.ai.fallback import FallbackAIProvider

NOW = datetime.now(UTC)
SUGGESTED = [
    "Which pincodes are out of stock right now?",
    "Am I cheaper than my rivals at checkout?",
    "What should I do first today?",
    "How many checks do I have left?",
]
TOPIC_PROMPTS = [
    "Tell me more about getting started",
    "Tell me more about checks and runs",
    "Tell me more about reading the heatmap",
    "Tell me more about weekly report",
    "Tell me more about ai summaries and recommendations",
    "Tell me more about credits and plans",
]

CONTEXT = {
    "product_id": "p1",
    "product_name": "Haldiram Bhujia",
    "avg_price": 32.0,
    "cheapest_rival": 20.0,
    "in_stock": 4,
    "total_pins": 6,
    "oos_pins": ["110016", "110017"],
    "all_pins": ["110003", "110016", "110017"],
    "price_gap_pins": 1,
    "stale_pins": 0,
    "hot_zone_count": 0,
    "rating": 4.3,
    "recent_changes": [
        {"kind": "price_drop", "platform": "zepto", "pincode": "110016", "old_value": 34.0, "new_value": 30.0}
    ],
    "this_week_avg_price": 32.0,
    "last_week_avg_price": 34.0,
    "platform_prices": [
        {
            "platform": "amazon", "pins_checked": 3, "pins_in_stock": 3, "oos_pins": [],
            "my_price": 28.0, "my_checkout": None, "rival_price": 30.0,
            "rival_name": "Bikaji Bhujia", "rival_checkout": None,
        },
        {
            "platform": "zepto", "pins_checked": 3, "pins_in_stock": 1, "oos_pins": ["110016", "110017"],
            "my_price": 36.0, "my_checkout": 40.0, "rival_price": 20.0,
            "rival_name": "Bikaji Bhujia", "rival_checkout": 25.0,
        },
    ],
    "pending_count": 2,
    "approved_count": 1,
    "pending_recommendations": [
        {"product_id": "p1", "product_name": "Haldiram Bhujia", "priority": "high",
         "action_text": "Restock Zepto pins 110016, 110017."},
        {"product_id": "p1", "product_name": "Haldiram Bhujia", "priority": "low",
         "action_text": "Check reviews."},
    ],
    "approved_actions": [
        {"product_id": "p1", "product_name": "Haldiram Bhujia", "priority": "medium",
         "action_text": "Match the rival at ₹30.00 on Amazon."}
    ],
    "product_count": 1,
    "plan": "pro",
    "credits_used_today": 48,
    "daily_credit_budget": 1000,
    "product_limit": 25,
    "pincode_limit": 100,
}


async def ask(message: str, context: dict | None = None):
    return await FallbackAIProvider().chat(dict(context or CONTEXT), message, [])


# ---------------------------------------------------------------- intent router


@pytest.mark.asyncio
async def test_telegram_how_to_is_answered_not_refused() -> None:
    result = await ask("How do I connect Telegram?")
    assert "only help" not in result.reply
    assert "/start" in result.reply
    paths = [action.path for action in result.actions]
    assert "/products/p1/telegram" in paths and "/settings#telegram" in paths


@pytest.mark.asyncio
async def test_off_topic_is_declined_even_with_generic_words() -> None:
    for question in ("what is the weather today", "tell me a joke", "who won the match today?"):
        result = await ask(question)
        assert "only help" in result.reply, question
        assert "₹" not in result.reply and "pins in stock" not in result.reply
        assert "'s" not in result.reply  # no "your products's" template slip


@pytest.mark.asyncio
async def test_checkout_question_compares_each_platform() -> None:
    result = await ask("Am I cheaper than my rivals at checkout?")
    reply = result.reply
    assert "Zepto" in reply and "Amazon" in reply
    assert "₹40.00 checkout" in reply and "₹25.00" in reply
    assert "dearer than Bikaji Bhujia at checkout" in reply
    assert "cheaper than Bikaji Bhujia on the shelf" in reply
    assert "Bottom line" in reply
    assert "avg n/a" not in reply
    assert grounding_violations(reply, CONTEXT) == []


@pytest.mark.asyncio
async def test_suggested_questions_get_specific_answers() -> None:
    oos = await ask(SUGGESTED[0])
    assert "110016" in oos.reply and "110017" in oos.reply and "Zepto" in oos.reply
    first = await ask(SUGGESTED[2])
    assert "Restock Zepto pins" in first.reply and "[high]" in first.reply
    assert first.actions[0].path == "/products/p1"
    credits = await ask(SUGGESTED[3])
    assert "952 of 1000 remain" in credits.reply


@pytest.mark.asyncio
async def test_how_to_topics_and_data_questions_route() -> None:
    for prompt in TOPIC_PROMPTS:
        result = await ask(prompt)
        assert "only help" not in result.reply, prompt
        assert result.actions, prompt
    add = await ask("How do I add a product?")
    assert "Add product" in add.reply and add.actions[0].path == "/products"
    pins = await ask("How do I change my pincodes?")
    assert any(a.path == "/products/p1/settings#pincodes" for a in pins.actions)
    alerts = await ask("How do I set up alerts?")
    assert any(a.path == "/products/p1/settings#rules" for a in alerts.actions)
    cheapest = await ask("Which platform is cheapest for me?")
    assert "lowest shelf price is on Amazon" in cheapest.reply
    changes = await ask("What changed recently?")
    assert "price dropped ₹34.00 → ₹30.00" in changes.reply
    approved = await ask("What have I approved?")
    assert "Match the rival" in approved.reply


@pytest.mark.asyncio
async def test_without_platform_rows_price_answer_uses_headline_numbers() -> None:
    context = {k: v for k, v in CONTEXT.items() if k != "platform_prices"}
    result = await ask("How is my price?", context)
    assert "₹32.00" in result.reply and "₹20.00" in result.reply
    assert any(item.metric == "avg_price" for item in result.evidence)


@pytest.mark.asyncio
async def test_no_products_yet_points_to_add_product() -> None:
    empty = {"product_name": "your products", "product_count": 0, "plan": "free"}
    result = await ask("Which pincodes are out of stock right now?", empty)
    assert "haven't added a product" in result.reply
    assert result.actions[0].path == "/products"


def test_action_paths_allow_in_app_fragments_only() -> None:
    assert is_allowed_action_path("/settings#telegram")
    assert is_allowed_action_path("/products/abc/settings#pincodes")
    assert not is_allowed_action_path("//evil.example")
    assert not is_allowed_action_path("/settings#a b")


# ---------------------------------------------------------------- API


async def make_user(plan: str = "pro") -> User:
    async with SessionLocal() as session:
        user = User(name="Chat Tester", email=f"{uuid4()}@test.local")
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


def true_price(price: float, fees: float) -> dict:
    return {"agent": {"true_price": {"item": price, "handling_fee": fees, "delivery_fee": 0.0,
                                     "offer": 0.0, "final": round(price + fees, 2)}}}


async def make_checked_product(user_id: str) -> str:
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name="Haldiram Bhujia Sev", search_query="bhujia")
        session.add(product)
        await session.flush()
        rival = Competitor(product_id=product.id, name="Bikaji Bhujia", platform="zepto", confirmed=True)
        session.add(rival)
        session.add_all(
            ProductPincode(product_id=product.id, pincode=pin, platform="zepto")
            for pin in ("110016", "110017")
        )
        run = CheckRun(product_id=product.id, trigger="manual", status="done")
        session.add(run)
        await session.flush()
        rows = [
            (None, "110016", True, 30.0, true_price(30.0, 4.0)),
            (None, "110017", False, None, {}),
            (rival.id, "110016", True, 33.0, true_price(33.0, 6.0)),
            (rival.id, "110017", True, 35.0, true_price(35.0, 2.0)),
        ]
        session.add_all(
            CheckResult(
                run_id=run.id, product_id=product.id, competitor_id=competitor, platform="zepto",
                pincode=pin, in_stock=in_stock, price=price, status="ok", raw=raw,
                checked_at=NOW - timedelta(minutes=5),
            )
            for competitor, pin, in_stock, price, raw in rows
        )
        session.add(Recommendation(product_id=product.id, priority="high",
                                   action_text="Restock Zepto pincode 110017.", impact_text="",
                                   evidence={}, status="pending"))
        await session.commit()
        return product.id


@pytest.mark.asyncio
async def test_chat_api_answers_checkout_from_real_rows() -> None:
    user = await make_user()
    product_id = await make_checked_product(user.id)
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://t") as client:
        body = (await client.post("/api/chat", json={"message": "Am I cheaper than my rivals at checkout?"})).json()
        assert body["source"] == "fallback"
        # Mine: ₹34 at checkout; cheapest rival checkout: ₹37 (35 + 2).
        assert "₹30.00 shelf / ₹34.00 checkout" in body["answer"]
        assert "₹3.00" in body["answer"] and "cheaper than Bikaji Bhujia at checkout" in body["answer"]
        first = (await client.post("/api/chat", json={"message": "What should I do first today?",
                                                      "product_id": product_id})).json()
        assert "Restock Zepto pincode 110017" in first["answer"]
        assert {"label": "Review recommendations", "path": f"/products/{product_id}"} in first["actions"]


@pytest.mark.asyncio
async def test_delete_conversation_is_owner_scoped() -> None:
    owner, stranger = await make_user(), await make_user()
    async with AsyncClient(transport=ASGITransport(app=app_for(owner)), base_url="http://t") as client:
        conversation_id = (await client.post("/api/chat", json={"message": "hello"})).json()["conversation_id"]
    async with AsyncClient(transport=ASGITransport(app=app_for(stranger)), base_url="http://t") as client:
        assert (await client.delete(f"/api/chat/conversations/{conversation_id}")).status_code == 404
    async with AsyncClient(transport=ASGITransport(app=app_for(owner)), base_url="http://t") as client:
        assert (await client.delete(f"/api/chat/conversations/{conversation_id}")).status_code == 204
        assert (await client.get(f"/api/chat/conversations/{conversation_id}")).status_code == 404
        listed = (await client.get("/api/chat/conversations")).json()["items"]
        assert all(item["id"] != conversation_id for item in listed)


@pytest.mark.asyncio
async def test_new_chat_is_titled_after_its_first_message() -> None:
    user = await make_user()
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://t") as client:
        created = (await client.post("/api/chat/conversations", json={})).json()
        assert created["title"] == "New chat"
        await client.post(f"/api/chat/conversations/{created['id']}/messages",
                          json={"content": "How do I connect Telegram?"})
        detail = (await client.get(f"/api/chat/conversations/{created['id']}")).json()
        assert detail["title"] == "How do I connect Telegram?"


# ---------------------------------------------------------------- Gemini failures


class _FailingModels:
    def __init__(self, error: Exception | None = None, delay: float = 0.0) -> None:
        self.error, self.delay = error, delay

    async def generate_content(self, **_kwargs):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return SimpleNamespace(text="")


def failing_gemini(models: _FailingModels) -> gemini_module.GeminiAIProvider:
    provider = gemini_module.GeminiAIProvider(api_key="test-key")
    provider._client = SimpleNamespace(aio=SimpleNamespace(models=models))
    return provider


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "models",
    [
        _FailingModels(RuntimeError("429 RESOURCE_EXHAUSTED: quota")),
        _FailingModels(ValueError("invalid api key")),
        _FailingModels(),  # empty response
        _FailingModels(delay=1.0),  # timeout
    ],
)
async def test_gemini_failures_fall_back_to_rules(monkeypatch: pytest.MonkeyPatch, models) -> None:
    monkeypatch.setattr(gemini_module, "GENERATION_TIMEOUT_SECONDS", 0.05)
    result, source = await with_fallback(
        failing_gemini(models), "chat", dict(CONTEXT), "How do I connect Telegram?", []
    )
    assert source == "fallback"
    assert "/start" in result.reply


@pytest.mark.asyncio
async def test_chat_api_survives_gemini_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.api.chat as chat_api

    monkeypatch.setattr(
        chat_api, "get_ai_provider", lambda: failing_gemini(_FailingModels(RuntimeError("503")))
    )
    user = await make_user()
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://t") as client:
        response = await client.post("/api/chat", json={"message": "How many checks do I have left?"})
    assert response.status_code == 200
    assert response.json()["source"] == "fallback"
    assert "credit" in response.json()["answer"]
