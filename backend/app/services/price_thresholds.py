"""Smart price-recommendation threshold: when a price move is worth suggesting.

A price suggestion only fires when the gap to the cheapest rival is big
enough to matter to shoppers, has persisted, and can be closed without
selling at a loss. Three outcomes:

``adjust``  gap over the product's threshold, persistent, and a target price
            exists inside the hard bounds -> a ``price`` recommendation.
``hold``    the rival sells below the seller's safe floor, so matching would
            mean a loss -> a ``margin_risk`` warning (never a price move).
``silent``  gap too small, not persistent yet, or inside the cooldown -> no
            price recommendation; ``reason`` says why for the refresh toast.

Hard bounds (a proposed price must satisfy ``safe_floor <= price <= ceiling``):

- ``break_even = cost_price / (1 - commission_pct / 100)``; without a
  commission it is the cost price;
- ``safe_floor = max(floor_price, break_even * (1 + min_margin_pct / 100))``;
- ``ceiling = mrp`` (Legal Metrology rules forbid selling above MRP).

Trigger threshold (Weber's law: shoppers notice relative differences):
``price_sensitivity`` essential = 4 %, regular = 7 % (default), premium = 10 %,
and never under an absolute ₹2. Persistence: over the threshold in at least
2 consecutive completed runs, or on >= 30 % of the compared pincodes in the
latest run. Hysteresis: within 7 days of the last price-family
recommendation, a new one needs the gap to move by half the threshold.

Gaps compare the true checkout price when every compared listing in the run
has one measured, otherwise the shelf price.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.checks import CheckResult, CheckRun
from ..models.intelligence import Recommendation
from ..models.product import Competitor, Product
from .heatmap import selected_pairs

SENSITIVITY_THRESHOLDS: dict[str, float] = {
    "essential": 4.0,
    "regular": 7.0,
    "premium": 10.0,
}
DEFAULT_SENSITIVITY = "regular"
MIN_GAP_RUPEES = 2.0
MIN_CONSECUTIVE_RUNS = 2
MIN_PINS_AFFECTED_PCT = 30.0
HYSTERESIS_FRACTION = 0.5
PRICE_REC_COOLDOWN = timedelta(days=7)
RUN_HISTORY_LIMIT = 10
RUN_HISTORY_WINDOW = timedelta(days=14)
COMPLETED_RUN_STATUSES = ("done", "partial")
# Recommendation kinds that answer "what should my price be?".
PRICE_FAMILY_KINDS = ("price", "pricing", "margin_risk")
COOLDOWN_STATUSES = ("pending", "approved", "done", "dismissed")
PLATFORM_LABELS = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Swiggy Instamart",
    "amazon": "Amazon.in",
    "flipkart": "Flipkart",
}


def sensitivity_of(value: str | None) -> str:
    return value if value in SENSITIVITY_THRESHOLDS else DEFAULT_SENSITIVITY


def threshold_pct(sensitivity: str | None) -> float:
    return SENSITIVITY_THRESHOLDS[sensitivity_of(sensitivity)]


def product_threshold_pct(product: Product) -> float:
    return threshold_pct(getattr(product, "price_sensitivity", None))


def _num(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


@dataclass(frozen=True)
class PriceBounds:
    break_even: float | None
    safe_floor: float | None
    ceiling: float | None


def price_bounds(pricing: dict) -> PriceBounds:
    """Hard bounds from the product's pricing rules (see module docstring)."""
    cost = _num(pricing.get("cost_price"))
    commission = _num(pricing.get("commission_pct")) or 0.0
    margin = _num(pricing.get("min_margin_pct")) or 0.0
    floor = _num(pricing.get("floor_price"))
    mrp = _num(pricing.get("mrp"))
    break_even = None
    if cost is not None and commission < 100:
        break_even = round(cost / (1 - commission / 100), 2)
    candidates = [value for value in (floor,) if value is not None]
    if break_even is not None:
        candidates.append(break_even * (1 + margin / 100))
    safe_floor = round(max(candidates), 2) if candidates else None
    return PriceBounds(
        break_even=break_even,
        safe_floor=safe_floor,
        ceiling=round(mrp, 2) if mrp is not None and mrp > 0 else None,
    )


def margin_after_commission_pct(price: float, pricing: dict) -> float | None:
    """Margin on the selling price after the platform commission, in %."""
    cost = _num(pricing.get("cost_price"))
    if cost is None or price <= 0:
        return None
    commission = _num(pricing.get("commission_pct")) or 0.0
    net = price * (1 - commission / 100)
    return round((net - cost) / price * 100, 1)


def snap_price_point(price: float, safe_floor: float | None) -> float:
    """Snap down to an Indian price point that stays at or above the safe floor.

    Under ₹100 the nearest lower whole rupee ending in 9, 5 or 0 (21 -> 20,
    49.5 -> 49); from ₹100 the nearest lower one ending in 9 (112 -> 109).
    Returns the price unchanged when no such point clears the safe floor.
    """
    whole = math.floor(price + 1e-9)
    endings = (9, 5, 0) if price < 100 else (9,)
    candidate = whole
    while candidate > 0 and candidate % 10 not in endings:
        candidate -= 1
    if candidate <= 0 or (safe_floor is not None and candidate < safe_floor - 0.005):
        return round(price, 2)
    return float(candidate)


@dataclass
class RunGap:
    """One completed run: your comparable price vs the cheapest rival's."""

    run_id: str
    checked_at: datetime
    basis: str  # checkout | shelf
    mine: float
    rival: float
    rival_competitor_id: str | None
    rival_platform: str
    gap_pct: float
    gap_rupees: float
    pins_compared: int
    pins_over: int

    @property
    def pins_over_pct(self) -> float:
        if not self.pins_compared:
            return 0.0
        return round(self.pins_over / self.pins_compared * 100, 1)


def checkout_price(row: CheckResult) -> float | None:
    """True price at checkout (item + fees - offer) when the agent measured it."""
    agent = (row.raw or {}).get("agent")
    true_price = agent.get("true_price") if isinstance(agent, dict) else None
    final = true_price.get("final") if isinstance(true_price, dict) else None
    return _num(final)


def _over(gap_pct: float, gap_rupees: float, threshold: float) -> bool:
    return gap_pct >= threshold - 1e-9 and gap_rupees >= MIN_GAP_RUPEES - 1e-9


def summarize_run(
    run_id: str,
    rows: Iterable[CheckResult],
    threshold: float,
    pairs: dict[str, set[str]] | None = None,
) -> RunGap | None:
    """Gap of one run's results; None when it has no comparable prices."""
    mine: dict[tuple[str, str], CheckResult] = {}
    rivals: list[CheckResult] = []
    for row in rows:
        if row.status != "ok" or row.in_stock is not True or row.price is None:
            continue
        if pairs is not None and row.platform not in pairs.get(row.pincode, ()):
            continue
        if row.competitor_id is None:
            mine[(row.platform, row.pincode)] = row
        else:
            rivals.append(row)
    if not mine or not rivals:
        return None
    use_checkout = all(checkout_price(row) is not None for row in [*mine.values(), *rivals])
    basis = "checkout" if use_checkout else "shelf"

    def price(row: CheckResult) -> float:
        value = checkout_price(row) if use_checkout else None
        return float(value if value is not None else row.price)

    my_prices = [price(row) for row in mine.values()]
    my_avg = sum(my_prices) / len(my_prices)
    cheapest = min(rivals, key=price)
    rival = price(cheapest)
    if rival <= 0:
        return None
    by_pin: dict[tuple[str, str], float] = {}
    for row in rivals:
        key = (row.platform, row.pincode)
        value = price(row)
        if key not in by_pin or value < by_pin[key]:
            by_pin[key] = value
    compared = over = 0
    for key, row in mine.items():
        theirs = by_pin.get(key)
        if theirs is None or theirs <= 0:
            continue
        compared += 1
        ours = price(row)
        if _over((ours / theirs - 1) * 100, ours - theirs, threshold):
            over += 1
    return RunGap(
        run_id=run_id,
        checked_at=max(row.checked_at for row in [*mine.values(), *rivals]),
        basis=basis,
        mine=round(my_avg, 2),
        rival=round(rival, 2),
        rival_competitor_id=cheapest.competitor_id,
        rival_platform=cheapest.platform,
        gap_pct=round((my_avg / rival - 1) * 100, 1),
        gap_rupees=round(my_avg - rival, 2),
        pins_compared=compared,
        pins_over=over,
    )


async def recent_run_gaps(
    session: AsyncSession,
    product_id: str,
    threshold: float,
    *,
    now: datetime | None = None,
    limit: int = RUN_HISTORY_LIMIT,
) -> list[RunGap]:
    """Per-run gaps of the latest completed runs, newest first."""
    now = now if now is not None else datetime.now(UTC)
    rows = list(
        (
            await session.scalars(
                select(CheckResult)
                .join(CheckRun, CheckRun.id == CheckResult.run_id)
                .where(
                    CheckResult.product_id == product_id,
                    CheckRun.status.in_(COMPLETED_RUN_STATUSES),
                    CheckResult.checked_at >= now - RUN_HISTORY_WINDOW,
                )
            )
        ).all()
    )
    by_run: dict[str, list[CheckResult]] = {}
    for row in rows:
        by_run.setdefault(row.run_id, []).append(row)
    pairs = await selected_pairs(session, product_id)
    gaps = [
        gap
        for run_id, run_rows in by_run.items()
        if (gap := summarize_run(run_id, run_rows, threshold, pairs)) is not None
    ]
    gaps.sort(key=lambda gap: gap.checked_at, reverse=True)
    return gaps[:limit]


def consecutive_runs_over(runs: list[RunGap], threshold: float) -> int:
    count = 0
    for run in runs:
        if not _over(run.gap_pct, run.gap_rupees, threshold):
            break
        count += 1
    return count


@dataclass
class PriceSignal:
    """What the threshold logic decided for this product right now."""

    outcome: str  # adjust | hold | silent
    reason: str
    evidence: dict = field(default_factory=dict)
    action_text: str = ""
    impact_text: str = ""
    priority: str = "medium"
    target_price: float | None = None

    def as_context(self) -> dict:
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "target_price": self.target_price,
            "action_text": self.action_text,
            "impact_text": self.impact_text,
            "priority": self.priority,
            "evidence": self.evidence,
        }


def _money(value: float) -> str:
    return f"₹{value:.0f}" if abs(value - round(value)) < 0.005 else f"₹{value:.2f}"


def _pct(value: float) -> str:
    return f"{value:.0f}%" if abs(value - round(value)) < 0.05 else f"{value:.1f}%"


def evaluate_price_signal(
    runs: list[RunGap],
    *,
    pricing: dict,
    current_price: float | None,
    sensitivity: str | None = None,
    round_to_price_point: bool = False,
    approved_change_pct_today: float = 0.0,
    last_price_rec: dict | None = None,
    rival_name: str | None = None,
) -> PriceSignal:
    """Pure decision: adjust / hold / silent from run history and pricing rules.

    ``last_price_rec`` is ``{"kind": ..., "gap_pct": ...}`` of the newest
    price-family recommendation inside the cooldown window, if any.
    """
    sensitivity = sensitivity_of(sensitivity)
    threshold = threshold_pct(sensitivity)
    bounds = price_bounds(pricing)
    base_evidence: dict = {
        "threshold_pct": threshold,
        "sensitivity": sensitivity,
        "safe_floor": bounds.safe_floor,
        "break_even": bounds.break_even,
        "mrp": bounds.ceiling,
        "commission_pct": _num(pricing.get("commission_pct")),
        "cost_price": _num(pricing.get("cost_price")),
    }
    if not runs:
        return PriceSignal("silent", "No rival price to compare yet", base_evidence)
    latest = runs[0]
    consecutive = consecutive_runs_over(runs, threshold)
    evidence = {
        **base_evidence,
        "gap_pct": latest.gap_pct,
        "gap_rupees": latest.gap_rupees,
        "price_basis": latest.basis,
        "avg_price": current_price,
        "cheapest_rival": latest.rival,
        "rival_platform": latest.rival_platform,
        "rival_name": rival_name,
        "consecutive_runs": consecutive,
        "pins_affected": latest.pins_over,
        "pins_compared": latest.pins_compared,
        "pins_affected_pct": latest.pins_over_pct,
    }
    if latest.gap_pct <= 0 or latest.gap_rupees <= 0:
        return PriceSignal(
            "silent", "You're already at or below the cheapest rival's price", evidence
        )
    if latest.gap_rupees < MIN_GAP_RUPEES:
        return PriceSignal(
            "silent",
            f"Price gap of ₹{latest.gap_rupees:.2f} is under the ₹{MIN_GAP_RUPEES:.0f} "
            "minimum worth acting on",
            evidence,
        )
    if latest.gap_pct < threshold:
        return PriceSignal(
            "silent",
            f"Price gap {latest.gap_pct:.1f}% is below your {_pct(threshold)} threshold",
            evidence,
        )
    persistent = (
        consecutive >= MIN_CONSECUTIVE_RUNS
        or latest.pins_over_pct >= MIN_PINS_AFFECTED_PCT
    )
    if not persistent:
        return PriceSignal(
            "silent",
            f"Price gap {latest.gap_pct:.1f}% showed up in only {consecutive} check "
            f"on {latest.pins_over} of {latest.pins_compared} pins — waiting for "
            "another check to confirm",
            evidence,
        )
    if current_price is None or current_price <= 0:
        return PriceSignal("silent", "No current price of yours to compare", evidence)

    rival_label = PLATFORM_LABELS.get(latest.rival_platform, latest.rival_platform.title())
    # The shelf price that closes the measured (shelf or checkout) gap.
    match_price = round(current_price - latest.gap_rupees, 2)
    commission = _num(pricing.get("commission_pct"))

    def kind_changed(kind: str) -> bool:
        return last_price_rec is not None and last_price_rec.get("kind") != kind

    def within_cooldown(kind: str) -> PriceSignal | None:
        if last_price_rec is None or kind_changed(kind):
            return None
        previous = _num(last_price_rec.get("gap_pct"))
        if previous is None:
            return None
        if abs(latest.gap_pct - previous) < threshold * HYSTERESIS_FRACTION:
            return PriceSignal(
                "silent",
                f"Price gap {latest.gap_pct:.1f}% hasn't moved enough since the last "
                f"price suggestion ({previous:.1f}%)",
                evidence,
            )
        return None

    if bounds.safe_floor is not None and match_price < bounds.safe_floor - 0.005:
        cooled = within_cooldown("margin_risk")
        if cooled is not None:
            return cooled
        floor_note = ""
        if bounds.break_even is not None:
            floor_note = f" (break-even {_money(bounds.break_even)}"
            floor_note += f" after {_pct(commission)} commission)" if commission else ")"
        basis_note = " checkout price" if latest.basis == "checkout" else ""
        action = (
            f"Don't match {rival_label}'s {_money(latest.rival)}{basis_note} — that's "
            "below your "
            f"safe floor of {_money(bounds.safe_floor)}{floor_note}. Compete on "
            "stock, delivery, or a bundle instead."
        )
        return PriceSignal(
            "hold",
            "Rival is below your safe floor",
            {**evidence, "kind": "margin_risk", "proposed_price": None},
            action_text=action,
            impact_text=(
                f"You're {_pct(latest.gap_pct)} above the cheapest rival, but matching "
                "would sell at a loss after commission; protect margin and win on "
                "availability instead."
            ),
            priority="high",
        )

    target = match_price
    if bounds.safe_floor is not None:
        target = max(target, bounds.safe_floor)
    max_change = _num(pricing.get("max_change_pct"))
    lowest_allowed = None
    if max_change is not None:
        room = max(max_change - approved_change_pct_today, 0.0)
        # Round the cap up to the paisa so the move never exceeds max_change_pct.
        lowest_allowed = math.ceil(current_price * (1 - room / 100) * 100 - 1e-6) / 100
        target = max(target, lowest_allowed)
    # MRP is a legal ceiling: it wins (the change-cap guardrail then decides).
    if bounds.ceiling is not None:
        target = min(target, bounds.ceiling)
    target = round(target, 2)
    if round_to_price_point:
        snapped = snap_price_point(target, bounds.safe_floor)
        if lowest_allowed is not None and snapped < lowest_allowed - 0.005:
            snapped = target
        target = snapped
    if target >= current_price - 0.005:
        reason = "Your pricing rules leave no room to lower the price today"
        if max_change is not None and approved_change_pct_today >= max_change - 0.005:
            reason = "Today's price-change limit is already used up"
        return PriceSignal("silent", reason, evidence)
    cooled = within_cooldown("price")
    if cooled is not None:
        return cooled
    margin = margin_after_commission_pct(target, pricing)
    change = round((1 - target / current_price) * 100, 2)
    run_word = "check" if consecutive == 1 else "checks"
    where = (
        f"on {latest.pins_over} of {latest.pins_compared} pins"
        if latest.pins_compared
        else "overall"
    )
    action = (
        f"Lower your price to {_money(target)} (from {_money(current_price)}) — you're "
        f"{latest.gap_pct:.1f}% above the cheapest rival {where} for {consecutive} "
        f"{run_word}"
    )
    if margin is not None:
        after = " after commission" if commission else ""
        action += f"; you'd still keep a {margin:.0f}% margin{after}."
    else:
        action += "."
    return PriceSignal(
        "adjust",
        "Price gap is over your threshold",
        {
            **evidence,
            "kind": "price",
            "proposed_price": target,
            "margin_at_target_pct": margin,
            "change_pct": change,
        },
        action_text=action,
        impact_text=(
            "Closing a gap shoppers notice wins back conversion on price-sensitive "
            "pins, while staying above your safe floor."
        ),
        priority="medium",
        target_price=target,
    )


async def last_price_recommendation(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> dict | None:
    """Newest price-family recommendation inside the cooldown window."""
    now = now if now is not None else datetime.now(UTC)
    rows = (
        await session.scalars(
            select(Recommendation)
            .where(
                Recommendation.product_id == product_id,
                Recommendation.status.in_(COOLDOWN_STATUSES),
                Recommendation.created_at >= now - PRICE_REC_COOLDOWN,
            )
            .order_by(Recommendation.created_at.desc())
        )
    ).all()
    for row in rows:
        evidence = row.evidence or {}
        if evidence.get("kind") in PRICE_FAMILY_KINDS:
            return {"kind": evidence.get("kind"), "gap_pct": evidence.get("gap_pct")}
    return None


async def compute_price_signal(
    session: AsyncSession,
    product: Product,
    *,
    pricing: dict,
    current_price: float | None,
    approved_change_pct_today: float = 0.0,
    now: datetime | None = None,
) -> PriceSignal:
    threshold = product_threshold_pct(product)
    runs = await recent_run_gaps(session, product.id, threshold, now=now)
    rival_name = None
    if runs and runs[0].rival_competitor_id:
        competitor = await session.get(Competitor, runs[0].rival_competitor_id)
        rival_name = competitor.name if competitor is not None else None
    return evaluate_price_signal(
        runs,
        pricing=pricing,
        current_price=current_price,
        sensitivity=product.price_sensitivity,
        round_to_price_point=bool(product.round_to_price_point),
        approved_change_pct_today=approved_change_pct_today,
        last_price_rec=await last_price_recommendation(session, product.id, now=now),
        rival_name=rival_name,
    )
