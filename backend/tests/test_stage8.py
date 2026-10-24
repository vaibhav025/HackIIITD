"""Stage 8: price-recommendation guardrails and the daily credit budget."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.checks import CreditLedger
from app.models.product import Product, ProductPincode
from app.models.user import Subscription, User
from app.services import runner as runner_module
from app.services import scheduler as scheduler_module
from app.services.ai.base import RecommendationCandidate
from app.services.intelligence import apply_recommendation_guardrails
from app.services.plans import credits_exhausted, daily_credits_used, limits_for

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
    floor_price: float | None = None,
    cost_price: float | None = None,
    min_margin_pct: float = 10.0,
    max_change_pct: float = 10.0,
) -> str:
    async with SessionLocal() as session:
        product = Product(
            user_id=user_id,
            name=name,
            search_query=name,
            floor_price=floor_price,
            cost_price=cost_price,
            min_margin_pct=min_margin_pct,
            max_change_pct=max_change_pct,
        )
        session.add(product)
        await session.flush()
        session.add_all(
            [
                ProductPincode(product_id=product.id, pincode="110016", platform="blinkit"),
                ProductPincode(product_id=product.id, pincode="110017", platform="blinkit"),
            ]
        )
        await session.commit()
        return str(product.id)


PRICING = {
    "floor_price": 28.0,
    "cost_price": 25.0,
    "min_margin_pct": 10.0,
    "max_change_pct": 10.0,
}
CONTEXT = {"avg_price": 30.0, "cheapest_rival": 29.0, "oos_pins": []}


def _candidate(text: str, impact: str = "Impact on sales.") -> RecommendationCandidate:
    return RecommendationCandidate(priority="medium", action_text=text, impact_text=impact)


def test_guardrail_drops_price_below_floor() -> None:
    cleaned = apply_recommendation_guardrails(
        [_candidate("Drop the price to ₹25.00 on Blinkit to match rivals.")],
        pending_texts=set(),
        context=CONTEXT,
        pricing=PRICING,
    )
    assert cleaned == []


def test_guardrail_drops_price_below_cost_plus_margin() -> None:
    # floor_price absent so only the cost+margin rule applies: 25 * 1.10 = 27.50
    cleaned = apply_recommendation_guardrails(
        [_candidate("Set the price to ₹27.00 to stay competitive.")],
        pending_texts=set(),
        context=CONTEXT,
        pricing={
            "floor_price": None,
            "cost_price": 25.0,
            "min_margin_pct": 10.0,
            "max_change_pct": None,
        },
    )
    assert cleaned == []


def test_guardrail_drops_excessive_percent_change() -> None:
    cleaned = apply_recommendation_guardrails(
        [_candidate("Reduce price by 25% across all platforms today.")],
        pending_texts=set(),
        context=CONTEXT,
        pricing=PRICING,
    )
    assert cleaned == []


def test_guardrail_drops_rupee_change_above_max() -> None:
    # 30 -> 36 is a 20% move; max_change_pct is 10%.
    cleaned = apply_recommendation_guardrails(
        [_candidate("Raise the price to ₹36.00 to recover margin.")],
        pending_texts=set(),
        context=CONTEXT,
        pricing=PRICING,
    )
    assert cleaned == []


def test_guardrail_keeps_legitimate_price_move() -> None:
    # 30 -> 32 is a 6.7% move, above floor and cost+margin.
    cleaned = apply_recommendation_guardrails(
        [_candidate("Nudge the price to ₹32.00 on Zepto for the weekend.")],
        pending_texts=set(),
        context=CONTEXT,
        pricing=PRICING,
    )
    assert len(cleaned) == 1
    assert "₹32.00" in cleaned[0]["action_text"]


def test_guardrail_without_pricing_config_is_unaffected() -> None:
    cleaned = apply_recommendation_guardrails(
        [_candidate("Drop the price to ₹10.00 to clear inventory fast.")],
        pending_texts=set(),
        context=CONTEXT,
    )
    assert len(cleaned) == 1


def test_plan_daily_credit_budgets() -> None:
    assert limits_for("free").daily_credit_budget == 100
    assert limits_for("pro").daily_credit_budget == 1000
    assert limits_for("brand").daily_credit_budget is None
    assert credits_exhausted("free", 100) is True
    assert credits_exhausted("free", 99) is False
    assert credits_exhausted("brand", 10**9) is False


@pytest.mark.asyncio
async def test_daily_credits_used_sums_today_only() -> None:
    user = await make_user()
    async with SessionLocal() as session:
        session.add_all(
            [
                CreditLedger(user_id=user.id, credits=40, reason="test"),
                CreditLedger(user_id=user.id, credits=60, reason="test"),
                CreditLedger(
                    user_id=user.id,
                    credits=500,
                    reason="test-old",
                    created_at=NOW - timedelta(days=1),
                ),
            ]
        )
        await session.commit()
        used = await daily_credits_used(session, user.id)
        assert used == 100


@pytest.mark.asyncio
async def test_scheduler_skips_when_credit_budget_exhausted() -> None:
    user = await make_user(plan="pro")
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        session.add(
            CreditLedger(user_id=user.id, credits=1000, reason="budget filler")
        )
        await session.commit()

    created: list[str] = []

    async def fake_schedule_run(run_id: str, *, product_id: str, user_id: str, jobs):
        created.append(product_id)

    original = runner_module.schedule_run
    runner_module.schedule_run = fake_schedule_run
    try:
        started = await scheduler_module.scan_due_products()
    finally:
        runner_module.schedule_run = original
    assert isinstance(started, int)
    async with SessionLocal() as session:
        runs = list(
            (
                await session.scalars(
                    select(CreditLedger).where(CreditLedger.user_id == user.id)
                )
            ).all()
        )
        assert runs  # ledger intact
    assert product_id not in created


@pytest.mark.asyncio
async def test_generation_wires_product_pricing_into_guardrails() -> None:
    """A generated rec suggesting a below-floor price must not be persisted."""
    from app.models.checks import CheckResult, CheckRun
    from app.models.product import Competitor
    from app.services.intelligence import generate_recommendations

    user = await make_user()
    product_id = await make_product(
        user.id, floor_price=28.0, cost_price=25.0, min_margin_pct=10.0
    )
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        session.add(
            Competitor(
                product_id=product_id,
                name="Rival",
                platform="blinkit",
                search_query=QUERY,
                confirmed=True,
            )
        )
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.flush()
        for pin, price, stock in (("110016", 30.0, True), ("110017", 12.0, True)):
            session.add(
                CheckResult(
                    run_id=run.id,
                    product_id=product_id,
                    competitor_id=None,
                    platform="blinkit",
                    pincode=pin,
                    price=price,
                    in_stock=stock,
                    rating=4.3,
                    status="ok",
                    raw={},
                    checked_at=NOW - timedelta(minutes=5),
                )
            )
        await session.commit()

        rows, source = await generate_recommendations(session, product)
        assert source == "fallback"
        for row in rows:
            assert "₹12" not in row.action_text
            assert "₹12" not in row.impact_text
