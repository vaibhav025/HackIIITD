"""Smart price-recommendation threshold: bounds, sensitivity, persistence, cooldown."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import SessionLocal
from app.models.checks import CheckResult
from app.models.intelligence import Recommendation
from app.models.product import Product
from app.services.ai.base import RecommendationCandidate
from app.services.alerts import default_alert_rules
from app.services.intelligence import (
    approved_change_pct_today,
    enforce_price_signal,
    price_violation,
)
from app.services.price_thresholds import (
    RunGap,
    evaluate_price_signal,
    price_bounds,
    snap_price_point,
    summarize_run,
)
from tests.test_stage5 import (
    NOW,
    add_result,
    app_for,
    get_competitor_id,
    make_product,
    make_run,
    make_user,
)

BACKEND = Path(__file__).resolve().parents[1]
PINS = ("110016", "110017", "110019")


def run_gap(
    mine: float,
    rival: float,
    *,
    pins_compared: int = 3,
    pins_over: int = 3,
    minutes_ago: int = 0,
    platform: str = "zepto",
) -> RunGap:
    return RunGap(
        run_id=f"run-{minutes_ago}",
        checked_at=NOW - timedelta(minutes=minutes_ago),
        basis="shelf",
        mine=mine,
        rival=rival,
        rival_competitor_id="c1",
        rival_platform=platform,
        gap_pct=round((mine / rival - 1) * 100, 1),
        gap_rupees=round(mine - rival, 2),
        pins_compared=pins_compared,
        pins_over=pins_over,
    )


def runs(mine: float, rival: float, count: int = 2, **kwargs) -> list[RunGap]:
    return [run_gap(mine, rival, minutes_ago=index * 60, **kwargs) for index in range(count)]


def signal(history: list[RunGap], **kwargs):
    pricing = {
        "floor_price": None,
        "cost_price": None,
        "min_margin_pct": 10.0,
        "max_change_pct": 20.0,
        "commission_pct": None,
        "mrp": None,
        **kwargs.pop("pricing", {}),
    }
    return evaluate_price_signal(
        history,
        pricing=pricing,
        current_price=kwargs.pop("current_price", history[0].mine if history else None),
        **kwargs,
    )


# --- trigger threshold --------------------------------------------------------


def test_one_rupee_on_twenty_is_ignored() -> None:
    result = signal(runs(21.0, 20.0), sensitivity="essential")
    assert result.outcome == "silent"
    assert "₹2 minimum" in result.reason


def test_eight_percent_in_one_run_on_few_pins_is_not_enough() -> None:
    history = [run_gap(54.0, 50.0, pins_compared=6, pins_over=1)]
    result = signal(history)
    assert result.outcome == "silent"
    assert "only 1 check" in result.reason


def test_eight_percent_two_runs_regular_adjusts_with_margin() -> None:
    result = signal(
        runs(54.0, 50.0, pins_compared=6, pins_over=4),
        pricing={"cost_price": 30.0, "commission_pct": 25.0},
    )
    assert result.outcome == "adjust"
    evidence = result.evidence
    assert evidence["kind"] == "price"
    assert evidence["proposed_price"] == 50.0
    assert evidence["gap_pct"] == 8.0 and evidence["gap_rupees"] == 4.0
    assert evidence["threshold_pct"] == 7.0 and evidence["sensitivity"] == "regular"
    assert evidence["break_even"] == 40.0 and evidence["safe_floor"] == 44.0
    # (50 * 0.75 - 30) / 50 = 15% after commission.
    assert evidence["margin_at_target_pct"] == 15.0
    assert evidence["consecutive_runs"] == 2
    assert evidence["pins_affected_pct"] == pytest.approx(66.7)
    assert result.action_text == (
        "Lower your price to ₹50 (from ₹54) — you're 8.0% above the cheapest rival "
        "on 4 of 6 pins for 2 checks; you'd still keep a 15% margin after commission."
    )


def test_target_is_clamped_by_max_change() -> None:
    result = signal(
        runs(54.0, 47.0),
        pricing={"cost_price": 30.0, "commission_pct": 25.0, "max_change_pct": 10.0},
    )
    assert result.outcome == "adjust"
    assert result.target_price == pytest.approx(48.6)
    # The cap is rounded up to the paisa so the guardrail never rejects it.
    capped = signal(runs(38.72, 21.26), pricing={"max_change_pct": 15.0})
    assert capped.target_price == 32.92
    assert price_violation(32.92, {"max_change_pct": 15.0}, current_price=38.72) is None


def test_wide_gap_in_one_run_triggers() -> None:
    history = [run_gap(54.0, 50.0, pins_compared=6, pins_over=2)]
    assert signal(history).outcome == "adjust"  # 33% of pins >= 30%


def test_essential_triggers_at_five_percent_premium_not_at_eight() -> None:
    assert signal(runs(63.0, 60.0), sensitivity="essential").outcome == "adjust"
    assert signal(runs(63.0, 60.0), sensitivity="regular").outcome == "silent"
    premium = signal(runs(54.0, 50.0), sensitivity="premium")
    assert premium.outcome == "silent"
    assert premium.reason == "Price gap 8.0% is below your 10% threshold"


# --- hard bounds ---------------------------------------------------------------


def test_rival_below_safe_floor_is_a_margin_risk_warning() -> None:
    result = signal(
        runs(46.0, 38.0),
        pricing={"cost_price": 30.0, "commission_pct": 25.0},
    )
    assert result.outcome == "hold"
    assert result.priority == "high"
    assert result.evidence["kind"] == "margin_risk"
    assert result.evidence["proposed_price"] is None
    assert result.action_text == (
        "Don't match Zepto's ₹38 — that's below your safe floor of ₹44 "
        "(break-even ₹40 after 25% commission). Compete on stock, delivery, or a "
        "bundle instead."
    )


def test_commission_raises_the_floor() -> None:
    plain = price_bounds({"cost_price": 30.0, "min_margin_pct": 10.0})
    with_fee = price_bounds({"cost_price": 30.0, "min_margin_pct": 10.0, "commission_pct": 25.0})
    assert plain.break_even == 30.0 and plain.safe_floor == 33.0
    assert with_fee.break_even == 40.0 and with_fee.safe_floor == 44.0
    floor_wins = price_bounds({"cost_price": 30.0, "min_margin_pct": 10.0, "floor_price": 50.0})
    assert floor_wins.safe_floor == 50.0
    # 36 clears cost + margin (33) but not the commission-aware floor (44).
    rules = {"cost_price": 30.0, "min_margin_pct": 10.0, "max_change_pct": 50.0}
    assert price_violation(36.0, rules, current_price=40.0) is None
    blocked = price_violation(36.0, {**rules, "commission_pct": 25.0}, current_price=40.0)
    assert blocked is not None and "safe floor 44.00" in blocked
    # Same rival price: no commission -> a price move; 25% commission -> hold.
    assert signal(runs(42.0, 38.0), pricing={"cost_price": 30.0}).outcome == "adjust"
    assert (
        signal(runs(42.0, 38.0), pricing={"cost_price": 30.0, "commission_pct": 25.0}).outcome
        == "hold"
    )


def test_mrp_ceiling_is_respected() -> None:
    result = signal(runs(62.0, 57.0), pricing={"mrp": 55.0})
    assert result.outcome == "adjust"
    assert result.target_price == 55.0
    assert price_violation(56.0, {"mrp": 55.0}, current_price=60.0) == "price 56.0 is above MRP 55.00"


def test_price_point_rounding() -> None:
    assert snap_price_point(21.0, None) == 20.0
    assert snap_price_point(49.5, None) == 49.0
    assert snap_price_point(47.0, None) == 45.0
    assert snap_price_point(112.0, None) == 109.0
    assert snap_price_point(46.0, 44.0) == 45.0
    # No price point between the safe floor and the price: keep it unrounded.
    assert snap_price_point(44.5, 44.2) == 44.5
    rounded = signal(runs(56.0, 51.4), round_to_price_point=True)
    assert rounded.target_price == 50.0
    assert signal(runs(56.0, 51.4)).target_price == 51.4


# --- hysteresis ----------------------------------------------------------------


def test_cooldown_needs_the_gap_to_move_by_half_the_threshold() -> None:
    previous = {"kind": "price", "gap_pct": 8.0}
    small_move = signal(runs(54.5, 50.0), last_price_rec=previous)  # 9.0%
    assert small_move.outcome == "silent"
    assert "hasn't moved enough" in small_move.reason
    big_move = signal(runs(56.0, 50.0), last_price_rec=previous)  # 12.0%
    assert big_move.outcome == "adjust"
    # Switching from "adjust" to "don't match" is news even with a similar gap.
    hold = signal(
        runs(46.0, 42.0),
        pricing={"cost_price": 30.0, "commission_pct": 25.0},
        last_price_rec={"kind": "price", "gap_pct": 9.5},
    )
    assert hold.outcome == "hold"


# --- per-run gaps --------------------------------------------------------------


def _row(competitor: str | None, pin: str, price: float, checkout: float | None = None):
    raw = {"agent": {"true_price": {"final": checkout}}} if checkout is not None else {}
    return CheckResult(
        run_id="r1",
        product_id="p1",
        competitor_id=competitor,
        platform="blinkit",
        pincode=pin,
        in_stock=True,
        price=price,
        status="ok",
        raw=raw,
        checked_at=NOW,
    )


def test_run_gap_uses_checkout_price_when_measured() -> None:
    shelf = summarize_run(
        "r1", [_row(None, "110016", 50.0), _row("c1", "110016", 48.0)], 7.0
    )
    assert shelf.basis == "shelf" and shelf.gap_pct == pytest.approx(4.2)
    checkout = summarize_run(
        "r1",
        [_row(None, "110016", 50.0, 58.0), _row("c1", "110016", 48.0, 52.0)],
        7.0,
    )
    assert checkout.basis == "checkout"
    assert checkout.gap_rupees == 6.0 and checkout.pins_over == 1


# --- Gemini path ------------------------------------------------------------------


def _gemini(price: float | None, kind: str = "price") -> RecommendationCandidate:
    return RecommendationCandidate(
        priority="medium",
        action_text=f"Set the price to ₹{price} on Blinkit." if price else "Review pricing.",
        impact_text="More sales.",
        evidence={"kind": kind, "proposed_price": price},
    )


def test_gemini_price_recs_obey_the_threshold() -> None:
    restock = RecommendationCandidate(
        action_text="Restock 110017 on Blinkit.", evidence={"kind": "restock"}
    )
    silent = signal(runs(52.0, 50.0))
    assert enforce_price_signal([_gemini(49.0), restock], silent) == [restock]

    adjust = signal(
        runs(54.0, 50.0), pricing={"cost_price": 30.0, "commission_pct": 25.0}
    )
    kept = enforce_price_signal([_gemini(49.0)], adjust)
    assert kept[0].evidence["proposed_price"] == 49.0
    assert kept[0].evidence["threshold_pct"] == 7.0
    assert kept[0].evidence["margin_at_target_pct"] is not None
    # Below the safe floor (44): replaced by the rule-based suggestion.
    replaced = enforce_price_signal([_gemini(40.0)], adjust)
    assert replaced[0].action_text == adjust.action_text

    hold = signal(runs(46.0, 38.0), pricing={"cost_price": 30.0, "commission_pct": 25.0})
    held = enforce_price_signal([_gemini(38.0)], hold)
    assert [c.evidence["kind"] for c in held] == ["margin_risk"]


# --- database + API --------------------------------------------------------------


async def _configure(product_id: str, **fields) -> None:
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        for key, value in fields.items():
            setattr(product, key, value)
        await session.commit()


async def _seed_runs(product_id: str, mine: float, rival: float, count: int) -> None:
    competitor_id = await get_competitor_id(product_id)
    for index in range(count):
        checked_at = NOW - timedelta(minutes=30 - index)
        run_id = await make_run(product_id)
        for pin in PINS:
            await add_result(run_id, product_id, None, "blinkit", pin, price=mine, in_stock=True, checked_at=checked_at)
            await add_result(run_id, product_id, competitor_id, "blinkit", pin, price=rival, in_stock=True, checked_at=checked_at)


def _client(user) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test")


@pytest.mark.asyncio
async def test_refresh_creates_one_bounded_price_rec_then_stays_quiet() -> None:
    user = await make_user("Threshold")
    product_id = await make_product(user.id)
    await _configure(product_id, cost_price=30.0, commission_pct=25.0, mrp=60.0)
    await _seed_runs(product_id, 54.0, 50.0, 2)
    async with _client(user) as client:
        body = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        prices = [r for r in body["recommendations"] if r["evidence"]["kind"] == "price"]
        assert len(prices) == 1
        evidence = prices[0]["evidence"]
        assert evidence["proposed_price"] == 50.0
        assert evidence["safe_floor"] == 44.0 and evidence["margin_at_target_pct"] == 15.0
        again = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        assert again["recommendations"] == []
        assert "hasn't moved enough" in again["message"]


@pytest.mark.asyncio
async def test_small_gap_refresh_explains_the_threshold() -> None:
    user = await make_user("Quiet")
    product_id = await make_product(user.id)
    await _seed_runs(product_id, 103.0, 100.0, 2)
    async with _client(user) as client:
        body = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
    assert not [r for r in body["recommendations"] if r["evidence"]["kind"] == "price"]
    assert body["price_note"] == "Price gap 3.0% is below your 7% threshold"
    assert "price gap 3.0% is below your 7% threshold" in body["message"].lower()


@pytest.mark.asyncio
async def test_margin_risk_approval_is_an_action_not_a_price_move() -> None:
    user = await make_user("Margin")
    product_id = await make_product(user.id)
    await _configure(product_id, cost_price=30.0, commission_pct=25.0)
    await _seed_runs(product_id, 46.0, 38.0, 2)
    async with _client(user) as client:
        body = (await client.post(f"/api/products/{product_id}/ai/recommendations")).json()
        warning = next(
            r for r in body["recommendations"] if r["evidence"]["kind"] == "margin_risk"
        )
        assert warning["priority"] == "high"
        assert warning["action_text"].startswith("Don't match Blinkit's ₹38")
        approve = (await client.post(f"/api/recommendations/{warning['id']}/approve")).json()
    assert approve["effect"] == "action_created"
    assert approve["action_item"] == warning["action_text"]
    async with SessionLocal() as session:
        row = await session.get(Recommendation, warning["id"])
        assert row.evidence.get("change_pct") is None
        assert row.evidence.get("proposed_price") is None
        assert await approved_change_pct_today(session, product_id) == 0.0


@pytest.mark.asyncio
async def test_product_threshold_fields_validate_and_round_trip() -> None:
    user = await make_user("Fields")
    product_id = await make_product(user.id)
    async with _client(user) as client:
        url = f"/api/products/{product_id}"
        fresh = (await client.get(url)).json()
        assert fresh["price_sensitivity"] == "regular"
        assert fresh["round_to_price_point"] is False
        assert fresh["commission_pct"] is None and fresh["mrp"] is None
        ok = await client.patch(
            url,
            json={
                "cost_price": 30.0,
                "floor_price": 40.0,
                "commission_pct": 25,
                "mrp": 60,
                "price_sensitivity": "essential",
                "round_to_price_point": True,
            },
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["price_sensitivity"] == "essential"
        assert (await client.patch(url, json={"commission_pct": 70})).status_code == 422
        assert (await client.patch(url, json={"mrp": 0})).status_code == 422
        assert (await client.patch(url, json={"mrp": 35})).status_code == 422  # < floor
        assert (await client.patch(url, json={"price_sensitivity": "cheap"})).status_code == 422
        cleared = await client.patch(url, json={"mrp": None, "price_sensitivity": None})
        assert cleared.json()["mrp"] is None
        assert cleared.json()["price_sensitivity"] == "regular"
        created = await client.post(
            "/api/products",
            json={"name": "Bad MRP", "search_query": "x", "cost_price": 50, "mrp": 40},
        )
        assert created.status_code == 422


def test_default_gap_alert_follows_sensitivity() -> None:
    product = Product(name="x", search_query="x", max_change_pct=10.0, price_sensitivity="essential")
    gap_rule = next(r for r in default_alert_rules(product) if r["kind"] == "price_gap_pct")
    assert gap_rule["threshold"] == 4.0
    product.price_sensitivity = None
    gap_rule = next(r for r in default_alert_rules(product) if r["kind"] == "price_gap_pct")
    assert gap_rule["threshold"] == 7.0


# --- migration ---------------------------------------------------------------------


def test_migration_upgrades_a_fresh_sqlite_database() -> None:
    directory = Path(tempfile.mkdtemp(prefix="shelfsense-migration-"))
    database = directory / "fresh.db"
    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database.as_posix()}"}

    def alembic(*args: str) -> None:
        subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=BACKEND,
            env=env,
            check=True,
            capture_output=True,
            timeout=120,
        )

    def columns() -> set[str]:
        with sqlite3.connect(database) as connection:
            return {row[1] for row in connection.execute("PRAGMA table_info(products)")}

    new = {"commission_pct", "mrp", "price_sensitivity", "round_to_price_point"}
    alembic("upgrade", "head")
    assert new <= columns()
    with sqlite3.connect(database) as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
    assert version == ("0002_price_thresholds",)
    alembic("downgrade", "0001_initial")
    assert not new & columns()
    alembic("upgrade", "head")
    assert new <= columns()

