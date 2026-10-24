"""Stage 5: AI provider fallback, guardrails, chat, and help topics."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.checks import CheckResult, CheckRun
from app.models.intelligence import AISummary, Recommendation
from app.models.product import Competitor, Product, ProductPincode
from app.models.user import Subscription, User
from app.services.ai.base import RecommendationCandidate, parse_json_payload
from app.services.ai.fallback import FallbackAIProvider
from app.services.intelligence import apply_recommendation_guardrails

NOW = datetime.now(UTC)
QUERY = "Amul Taaza Toned Milk 500 ml"


async def make_user(name: str, plan: str = "pro") -> User:
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
    pincodes = pincodes or ["110016", "110017", "110019"]
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


async def make_run(product_id: str) -> str:
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.commit()
        return str(run.id)


async def get_competitor_id(product_id: str) -> str:
    async with SessionLocal() as session:
        competitor = await session.scalar(
            select(Competitor).where(Competitor.product_id == product_id).limit(1)
        )
        return str(competitor.id)


async def add_result(
    run_id: str,
    product_id: str,
    competitor_id: str | None,
    platform: str,
    pincode: str,
    *,
    price: float | None = None,
    in_stock: bool | None = None,
    rating: float | None = None,
    status: str = "ok",
    checked_at: datetime | None = None,
) -> None:
    async with SessionLocal() as session:
        session.add(
            CheckResult(
                run_id=run_id,
                product_id=product_id,
                competitor_id=competitor_id,
                platform=platform,
                pincode=pincode,
                in_stock=in_stock,
                price=price,
                rating=rating,
                status=status,
                raw={},
                checked_at=checked_at or (NOW - timedelta(minutes=10)),
            )
        )
        await session.commit()


async def seed_check_data(product_id: str) -> None:
    """Seller: 30 / oos / 28; rival undercuts on 110016; 4 oos pins impossible here."""
    run_id = await make_run(product_id)
    competitor_id = await get_competitor_id(product_id)
    await add_result(run_id, product_id, None, "blinkit", "110016", price=30.0, in_stock=True, rating=4.4)
    await add_result(run_id, product_id, None, "blinkit", "110017", price=36.0, in_stock=False, rating=4.4)
    await add_result(run_id, product_id, None, "blinkit", "110019", price=28.0, in_stock=True, rating=4.4)
    await add_result(run_id, product_id, competitor_id, "blinkit", "110016", price=29.0, in_stock=True, rating=4.2)
    await add_result(run_id, product_id, competitor_id, "blinkit", "110017", price=33.0, in_stock=True, rating=4.2)
    await add_result(run_id, product_id, competitor_id, "blinkit", "110019", price=30.0, in_stock=True, rating=4.2)


async def seed_gap_runs(
    product_id: str, *, mine: float = 34.0, rival: float = 31.0, runs: int = 2
) -> None:
    """Completed runs after ``seed_check_data`` where you stay above the rival.

    Price suggestions need a gap that persists across runs (see
    services/price_thresholds.py), so a single run is not enough. 110017 stays
    out of stock so the restock advice is still there too.
    """
    competitor_id = await get_competitor_id(product_id)
    for index in range(runs):
        checked_at = NOW - timedelta(minutes=8 - index)
        run_id = await make_run(product_id)
        for pin in ("110016", "110019"):
            await add_result(run_id, product_id, None, "blinkit", pin, price=mine, in_stock=True, rating=4.4, checked_at=checked_at)
        await add_result(run_id, product_id, None, "blinkit", "110017", in_stock=False, checked_at=checked_at)
        for pin in ("110016", "110017", "110019"):
            await add_result(run_id, product_id, competitor_id, "blinkit", pin, price=rival, in_stock=True, rating=4.2, checked_at=checked_at)


@pytest.mark.asyncio
async def test_fallback_summary_is_grounded() -> None:
    provider = FallbackAIProvider()
    context = {
        "product_name": "Amul Taaza",
        "avg_price": 31.33,
        "cheapest_rival": 29.0,
        "in_stock": 2,
        "total_pins": 3,
        "oos_pins": ["110017"],
        "hot_zone_count": 0,
    }
    result = await provider.summarize(context)
    assert "Amul Taaza" in result.summary_text
    assert "₹31.33" in result.summary_text
    assert "110017" in result.summary_text
    assert "cheapest rival" in result.summary_text.lower()


@pytest.mark.asyncio
async def test_fallback_chat_offtopic_is_refused() -> None:
    provider = FallbackAIProvider()
    result = await provider.chat({"product_name": "Amul"}, "tell me a joke", [])
    assert "only help" in result.reply


@pytest.mark.asyncio
async def test_fallback_chat_price_answer_includes_evidence() -> None:
    provider = FallbackAIProvider()
    context = {
        "product_id": "p1",
        "product_name": "Amul Taaza",
        "avg_price": 31.33,
        "cheapest_rival": 29.0,
        "in_stock": 2,
        "total_pins": 3,
        "oos_pins": ["110017"],
    }
    result = await provider.chat(context, "How is my price?", [])
    assert "₹31.33" in result.reply
    assert any(item.metric == "avg_price" for item in result.evidence)


def test_parse_json_payload_tolerates_fences() -> None:
    payload = parse_json_payload('```json\n{"summary_text": "ok"}\n```')
    assert payload == {"summary_text": "ok"}


def test_guardrails_drop_banned_and_dedupe() -> None:
    candidates = [
        RecommendationCandidate(
            priority="high",
            action_text="Collude with rivals to fix prices across platforms",
            impact_text="Higher margins",
        ),
        RecommendationCandidate(
            priority="medium",
            action_text="Check restock for out-of-stock pins 110017.",
            impact_text="Recover sales.",
        ),
        RecommendationCandidate(
            priority="medium",
            action_text="Check restock for out-of-stock pins 110017.",
            impact_text="Duplicate of the previous item.",
        ),
    ]
    cleaned = apply_recommendation_guardrails(
        candidates,
        pending_texts=set(),
        context={"avg_price": 30.0, "cheapest_rival": 30.0},
    )
    assert len(cleaned) == 1
    assert "restock" in cleaned[0]["action_text"]


def test_guardrails_demote_high_priority_without_signal() -> None:
    candidates = [
        RecommendationCandidate(
            priority="high",
            action_text="Investigate the single out-of-stock pin 110017 today.",
            impact_text="Availability.",
        )
    ]
    cleaned = apply_recommendation_guardrails(
        candidates,
        pending_texts=set(),
        context={"avg_price": 30.0, "cheapest_rival": 30.0},
    )
    assert cleaned[0]["priority"] == "medium"

    cleaned_high = apply_recommendation_guardrails(
        candidates,
        pending_texts=set(),
        context={"avg_price": 36.0, "cheapest_rival": 30.0},
    )
    assert cleaned_high[0]["priority"] == "high"


def test_guardrails_truncate_long_text() -> None:
    candidates = [
        RecommendationCandidate(
            priority="low",
            action_text="A" * 3000,
            impact_text="B" * 3000,
        )
    ]
    cleaned = apply_recommendation_guardrails(
        candidates,
        pending_texts=set(),
        context={},
    )
    assert len(cleaned[0]["action_text"]) == 2000
    assert len(cleaned[0]["impact_text"]) == 2000


@pytest.mark.asyncio
async def test_summary_endpoint_generates_with_fallback_source() -> None:
    user = await make_user("Riya Sharma")
    product_id = await make_product(user.id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        empty = await client.post(f"/api/products/{product_id}/ai/summary")
        assert empty.status_code == 422

        await seed_check_data(product_id)
        response = await client.post(f"/api/products/{product_id}/ai/summary")
        assert response.status_code == 200
        body = response.json()
        assert body["source"] == "fallback"
        assert QUERY in body["summary_text"] or "₹" in body["summary_text"]
        assert body["evidence"]["total_pins"] == 3

    async with SessionLocal() as session:
        rows = list(
            (
                await session.scalars(
                    select(AISummary).where(AISummary.product_id == product_id)
                )
            ).all()
        )
        assert len(rows) == 1
        assert rows[0].source == "fallback"


@pytest.mark.asyncio
async def test_recommendations_generate_approve_dismiss() -> None:
    user = await make_user("Riya Sharma")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    await seed_gap_runs(product_id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(f"/api/products/{product_id}/ai/recommendations")
        assert response.status_code == 200
        body = response.json()
        assert body["source"] == "fallback"
        assert 1 <= len(body["recommendations"]) <= 3
        first = body["recommendations"][0]
        assert first["status"] == "pending"

        approve = await client.post(f"/api/recommendations/{first['id']}/approve")
        assert approve.status_code == 200
        assert approve.json()["status"] == "approved"
        assert approve.json()["decided_via"] == "web"

        second = body["recommendations"][1]
        dismiss = await client.post(f"/api/recommendations/{second['id']}/dismiss")
        assert dismiss.status_code == 200
        assert dismiss.json()["status"] == "dismissed"

        listing = await client.get(
            f"/api/products/{product_id}/ai/recommendations", params={"status": "pending"}
        )
        pending_ids = {item["id"] for item in listing.json()["items"]}
        assert first["id"] not in pending_ids
        assert second["id"] not in pending_ids


@pytest.mark.asyncio
async def test_recommendations_respect_pending_limit() -> None:
    user = await make_user("Riya Sharma")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    async with SessionLocal() as session:
        session.add_all(
            Recommendation(
                product_id=product_id,
                priority="low",
                action_text=f"Pending item {index} to fill the quota slot.",
                impact_text="n/a",
            )
            for index in range(5)
        )
        await session.commit()
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(f"/api/products/{product_id}/ai/recommendations")
        assert response.status_code == 200
        assert response.json()["recommendations"] == []
    async with SessionLocal() as session:
        count = await session.scalar(
            select(func.count(Recommendation.id)).where(
                Recommendation.product_id == product_id
            )
        )
        assert count == 5


@pytest.mark.asyncio
async def test_reviews_refresh_and_ownership_isolation() -> None:
    owner = await make_user("Owner")
    stranger = await make_user("Stranger")
    product_id = await make_product(owner.id)
    await seed_check_data(product_id)
    owner_app = app_for(owner)
    stranger_app = app_for(stranger)
    async with AsyncClient(
        transport=ASGITransport(app=owner_app), base_url="http://test"
    ) as client:
        response = await client.post(f"/api/products/{product_id}/ai/reviews")
        assert response.status_code == 200
        body = response.json()
        assert body["source"] == "fallback"
        assert body["loves"] or body["complaints"]

    async with AsyncClient(
        transport=ASGITransport(app=stranger_app), base_url="http://test"
    ) as client:
        denied = await client.post(f"/api/products/{product_id}/ai/summary")
        assert denied.status_code == 404


@pytest.mark.asyncio
async def test_help_topics_list_and_detail() -> None:
    user = await make_user("Riya Sharma")
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        listing = await client.get("/api/help/topics")
        assert listing.status_code == 200
        topics = listing.json()["items"]
        assert len(topics) >= 5
        slugs = {topic["slug"] for topic in topics}
        assert "heatmap" in slugs

        detail = await client.get("/api/help/topics/heatmap")
        assert detail.status_code == 200
        assert "out of stock" in detail.json()["body"]

        missing = await client.get("/api/help/topics/nope")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_chat_conversation_flow_and_guards() -> None:
    user = await make_user("Riya Sharma")
    product_id = await make_product(user.id)
    await seed_check_data(product_id)
    app = app_for(user)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        created = await client.post(
            "/api/chat/conversations", json={"product_id": product_id}
        )
        assert created.status_code == 200
        conversation_id = created.json()["id"]
        assert created.json()["product_id"] == product_id
        assert created.json()["title"].startswith("Chat about")

        message = await client.post(
            f"/api/chat/conversations/{conversation_id}/messages",
            json={"content": "How is my price doing?"},
        )
        assert message.status_code == 200
        body = message.json()
        assert body["source"] == "fallback"
        assert body["reply"]["role"] == "assistant"
        assert "₹" in body["reply"]["content"]
        assert any(item["metric"] == "avg_price" for item in body["evidence"])

        detail = await client.get(f"/api/chat/conversations/{conversation_id}")
        assert detail.status_code == 200
        roles = [row["role"] for row in detail.json()["messages"]]
        assert roles == ["user", "assistant"]

        too_long = await client.post(
            f"/api/chat/conversations/{conversation_id}/messages",
            json={"content": "x" * 2001},
        )
        assert too_long.status_code == 422

    stranger = await make_user("Stranger")
    stranger_app = app_for(stranger)
    async with AsyncClient(
        transport=ASGITransport(app=stranger_app), base_url="http://test"
    ) as client:
        missing = await client.get(f"/api/chat/conversations/{conversation_id}")
        assert missing.status_code == 404
        post = await client.post(
            f"/api/chat/conversations/{conversation_id}/messages",
            json={"content": "hello"},
        )
        assert post.status_code == 404
