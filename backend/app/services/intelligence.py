"""AI orchestration: context building, generation, and recommendation guardrails.

Every generated artefact is grounded in measured numbers (KPIs, heatmap,
weekly stats) and passes pure-Python guardrails before being persisted.

Price guardrails act on the structured ``evidence.proposed_price`` (or, for
free text, an explicit "set/drop/raise … to ₹X" proposal). A proposal must
respect the floor price, cost + minimum margin, the max change versus the
current own average price, and the max change accumulated by approvals of the
same product today. Approval re-checks all of this against fresh numbers.

Approval is not just a status flip: each recommendation has a *kind*
(``price``, ``pricing``, ``margin_risk``, ``restock``, ``recheck``, ``rating``,
``other``) and
approving applies its effect. A re-check starts a real check run; everything
else becomes an open item on the seller's action list (status ``approved``)
until they mark it ``done``. ShelfSense is read-only on marketplaces, so an
approved price move is recorded as the committed target the seller must set
in their seller panel, never pushed to the platform.

Generation keeps the list honest: a new recommendation supersedes older
pending ones of the same kind, pending ones expire after a week, and a
recommendation the seller decided on recently is not recreated verbatim.

Whether a price recommendation fires at all is decided by the smart threshold
in ``services/price_thresholds.py`` (per-product sensitivity, ₹2 minimum,
persistence across runs, hysteresis, and the commission/MRP hard bounds). Its
verdict filters both the Gemini and the rule-based candidates, so the two
paths agree. A ``margin_risk`` warning ("don't match, it would be a loss") is
never a price move: it never carries a proposed price and never counts toward
the daily change cap.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.checks import ChangeEvent, CheckResult
from ..models.intelligence import AISummary, Recommendation, ReviewInsight
from ..models.product import Competitor, Product, ProductPincode
from .ai import get_ai_provider, with_fallback
from .ai.base import RecommendationCandidate
from .heatmap import compute_heatmap
from .insights import compute_overview, compute_weekly
from .plans import credit_day_start
from .price_thresholds import (
    PRICE_FAMILY_KINDS,
    PriceSignal,
    compute_price_signal,
    margin_after_commission_pct,
    price_bounds,
)

logger = logging.getLogger("shelfsense.intelligence")

RECOMMENDATION_LIMIT = 5
ACTION_TEXT_LIMIT = 2000
IMPACT_TEXT_LIMIT = 2000
MIN_ACTION_LENGTH = 10
RECENT_EVENTS_LIMIT = 10
VALID_PRIORITIES = {"high", "medium", "low"}
HIGH_PRIORITY_MIN_OOS_PINS = 3
HIGH_PRIORITY_MIN_GAP_PCT = 5.0
# Decided (approved/done/dismissed) recommendations block identical ones this long.
DECISION_COOLDOWN = timedelta(days=7)
# Pending recommendations nobody acted on expire after this long.
PENDING_TTL = timedelta(days=7)
OPEN_ACTION_STATUSES = ("approved", "done")
DECIDED_STATUSES = ("approved", "done", "dismissed")
RECOMMENDATION_KINDS = {
    "price",
    "pricing",
    "margin_risk",
    "restock",
    "recheck",
    "rating",
    "other",
}
# Kinds where only the newest pending suggestion makes sense; price and
# "review pricing" compete for the same decision.
SUPERSEDE_GROUPS = {
    "price": "price",
    "pricing": "price",
    "margin_risk": "price",
    "restock": "restock",
    "recheck": "recheck",
    "rating": "rating",
}
PLATFORM_LABELS = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Swiggy Instamart",
    "amazon": "Amazon.in",
    "flipkart": "Flipkart",
}
_RECHECK_RE = re.compile(
    r"\b(?:re-?run|re-?check|fresh check|run a (?:new |fresh )?check)", re.IGNORECASE
)

BANNED_PHRASES = (
    "price fix",
    "price-fix",
    "fix prices",
    "cartel",
    "collude",
    "collusion",
    "sabotage",
    "fake review",
    "brigade",
    "blackmail",
    "undercut illegally",
)

_PROPOSAL_RE = re.compile(
    r"\b(?:drop|reduce|cut|lower|decrease|raise|increase|hike|set|nudge|move|change|"
    r"price|match|bring)\w*\b[^₹\n]{0,40}?\b(?:to|at)\s*(?:₹|Rs\.?|INR)\s*"
    r"(\d[\d,]*(?:\.\d+)?)",
    re.IGNORECASE,
)
_PRESCRIPTIVE_PCT_RE = re.compile(
    r"(drop|reduce|cut|lower|decrease|raise|increase|hike)\D{0,40}?"
    r"(\d+(?:\.\d+)?)\s*%",
    re.IGNORECASE,
)


async def build_context(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> dict | None:
    """Grounding numbers for the AI providers; None when there is no data."""
    product = await session.get(Product, product_id)
    if product is None:
        return None
    now = now if now is not None else datetime.now(UTC)
    overview = await compute_overview(session, product_id, now=now)
    weekly = await compute_weekly(session, product_id, now=now)
    heatmap = await compute_heatmap(session, product_id, now=now)
    pins = heatmap["pins"]
    oos_pins = [pin["pincode"] for pin in pins if pin["status"] == "out_of_stock"]
    oos_platforms = sorted(
        {pin["platform"] for pin in pins if pin["status"] == "out_of_stock"}
    )
    top_pending = await session.scalar(
        select(Recommendation.action_text)
        .where(
            Recommendation.product_id == product_id,
            Recommendation.status == "pending",
        )
        .order_by(Recommendation.created_at.desc())
        .limit(1)
    )
    recent_events = list(
        (
            await session.scalars(
                select(ChangeEvent)
                .where(ChangeEvent.product_id == product_id)
                .order_by(ChangeEvent.detected_at.desc())
                .limit(RECENT_EVENTS_LIMIT)
            )
        ).all()
    )
    kpis = overview["kpis"]
    pricing = pricing_rules(product)
    signal = await compute_price_signal(
        session,
        product,
        pricing=pricing,
        current_price=kpis["avg_price"]["value"],
        approved_change_pct_today=await approved_change_pct_today(session, product_id),
        now=now,
    )
    return {
        "product_id": product_id,
        "product_name": product.name,
        "avg_price": kpis["avg_price"]["value"],
        "cheapest_rival": kpis["cheapest_rival"]["value"],
        "in_stock": kpis["in_stock"]["value"],
        "total_pins": kpis["in_stock"]["total"],
        "rating": kpis["rating"]["value"],
        "price_gap_pins": heatmap["summary"]["price_gap"],
        "stale_pins": heatmap["summary"]["stale"] - heatmap["summary"]["failed"],
        "failed_pins": heatmap["summary"]["failed"],
        "hot_zone_count": len(heatmap["hot_zones"]),
        "oos_pins": oos_pins,
        "oos_platforms": oos_platforms,
        "all_pins": sorted({pin["pincode"] for pin in pins}),
        "this_week_avg_price": weekly["this_week"]["avg_price"],
        "last_week_avg_price": weekly["last_week"]["avg_price"],
        "this_week_oos_count": weekly["this_week"]["oos_count"],
        "recommendation_preview": top_pending or "",
        "pricing": pricing,
        "price_signal": signal.as_context(),
        "recent_changes": [
            {
                "kind": row.kind,
                "platform": row.platform,
                "pincode": row.pincode,
                "old_value": row.old_value,
                "new_value": row.new_value,
            }
            for row in recent_events
        ],
    }


def _stats_from_context(context: dict) -> dict:
    return {
        "oos_pins": len(context.get("oos_pins") or []),
        "max_gap_pct": _gap_from_context(context),
    }


def _gap_from_context(context: dict) -> float | None:
    avg_price = context.get("avg_price")
    rival = context.get("cheapest_rival")
    if avg_price is None or rival is None or rival == 0:
        return None
    return round((avg_price / rival - 1) * 100, 2)


class RecommendationConflict(HTTPException):
    """A decision that the recommendation's state or the guardrails forbid (409).

    ``code`` is ``already_decided`` when the recommendation is no longer
    pending and ``guardrail_blocked`` when pricing guardrails block approval.
    """

    def __init__(self, message: str, code: str = "already_decided") -> None:
        super().__init__(status_code=409, detail={"code": code, "message": message})
        self.code = code
        self.message = message


def pricing_rules(product: Product) -> dict:
    return {
        "floor_price": product.floor_price,
        "cost_price": product.cost_price,
        "min_margin_pct": product.min_margin_pct,
        "max_change_pct": product.max_change_pct,
        "commission_pct": product.commission_pct,
        "mrp": product.mrp,
    }


def parse_rupees(raw: str) -> float:
    """Parse ``1,299.50`` (Indian digit grouping included) as 1299.5."""
    return float(raw.replace(",", ""))


def proposed_price_of(text: str, evidence: dict) -> float | None:
    """The concrete price a recommendation proposes, if any.

    Structured ``evidence.proposed_price`` wins; otherwise an explicit
    "set/drop/raise … to ₹X" phrase counts. Mentions such as "cheapest
    rival (₹X)" are context, not proposals.
    """
    value = evidence.get("proposed_price")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) else math.nan
    match = _PROPOSAL_RE.search(text)
    return parse_rupees(match.group(1)) if match else None


def change_pct(price: float, current_price: float | None) -> float | None:
    if not current_price:
        return None
    return round(abs(price / current_price - 1) * 100, 2)


def price_violation(
    price: float,
    pricing: dict,
    *,
    current_price: float | None,
    approved_change_pct: float = 0.0,
) -> str | None:
    """Reason a proposed price breaks the product's pricing rules, else None."""
    if not math.isfinite(price) or price <= 0:
        return f"proposed price {price} is not a valid price"
    floor_price = pricing.get("floor_price")
    cost_price = pricing.get("cost_price")
    min_margin_pct = pricing.get("min_margin_pct")
    max_change_pct = pricing.get("max_change_pct")
    if floor_price is not None and price < float(floor_price):
        return f"price {price} is below floor_price {floor_price}"
    if cost_price is not None and min_margin_pct is not None:
        minimum = float(cost_price) * (1 + float(min_margin_pct) / 100)
        if price < minimum - 0.005:
            return f"price {price} is below cost+margin minimum {minimum:.2f}"
    bounds = price_bounds(pricing)
    if (
        pricing.get("commission_pct")
        and bounds.safe_floor is not None
        and bounds.break_even is not None
        and price < bounds.safe_floor - 0.005
    ):
        return (
            f"price {price} is below the safe floor {bounds.safe_floor:.2f} "
            f"(break-even {bounds.break_even:.2f} after "
            f"{pricing['commission_pct']}% commission)"
        )
    if bounds.ceiling is not None and price > bounds.ceiling + 0.005:
        return f"price {price} is above MRP {bounds.ceiling:.2f}"
    moved = change_pct(price, current_price)
    if moved is not None and max_change_pct is not None:
        if moved > float(max_change_pct) + 0.005:
            return (
                f"price {price} changes {moved:.1f}% from current "
                f"{current_price} (max {max_change_pct}%)"
            )
        if moved + approved_change_pct > float(max_change_pct) + 0.005:
            return (
                f"price {price} would bring today's approved changes to "
                f"{moved + approved_change_pct:.1f}% (max {max_change_pct}%)"
            )
    return None


def _percent_violation(text: str, pricing: dict) -> str | None:
    max_change_pct = pricing.get("max_change_pct")
    if max_change_pct is None:
        return None
    for match in _PRESCRIPTIVE_PCT_RE.finditer(text):
        pct = float(match.group(2))
        if pct > float(max_change_pct) + 0.005:
            return (
                f"proposes {pct}% price change above max_change_pct {max_change_pct}"
            )
    return None


def apply_recommendation_guardrails(
    candidates: list[RecommendationCandidate],
    *,
    pending_texts: set[str],
    context: dict,
    pricing: dict | None = None,
) -> list[dict]:
    """Pure filter: ban-list, price rules, truncation, priority clamp, dedupe."""
    stats = _stats_from_context(context)
    allowed_high = (
        stats["oos_pins"] >= HIGH_PRIORITY_MIN_OOS_PINS
        or (
            stats["max_gap_pct"] is not None
            and stats["max_gap_pct"] >= HIGH_PRIORITY_MIN_GAP_PCT
        )
    )
    pricing = pricing or {}
    current_price = context.get("avg_price")
    approved_today = float(pricing.get("approved_change_pct_today") or 0.0)
    cleaned: list[dict] = []
    seen = {text.strip().lower() for text in pending_texts}
    for candidate in candidates:
        action = candidate.action_text.strip()
        impact = candidate.impact_text.strip()
        combined = f"{action} {impact}".lower()
        if any(phrase in combined for phrase in BANNED_PHRASES):
            logger.info("guardrail dropped banned recommendation: %s", action[:60])
            continue
        if len(action) < MIN_ACTION_LENGTH:
            continue
        evidence = dict(candidate.evidence)
        warning = evidence.get("kind") == "margin_risk"
        # A margin-risk warning names the rival's price only to say "don't match".
        proposal = None if warning else proposed_price_of(f"{action} {impact}", evidence)
        violation = None if warning else _percent_violation(f"{action} {impact}", pricing)
        if proposal is not None:
            violation = violation or price_violation(
                proposal,
                pricing,
                current_price=current_price,
                approved_change_pct=approved_today,
            )
            evidence["proposed_price"] = round(proposal, 2)
            evidence["base_price"] = current_price
            evidence["change_pct"] = change_pct(proposal, current_price)
        else:
            evidence["proposed_price"] = None
            evidence.pop("change_pct", None)
        if violation is not None:
            logger.info(
                "guardrail dropped price-violating recommendation (%s): %s",
                violation,
                action[:60],
            )
            continue
        priority = candidate.priority.strip().lower()
        if priority not in VALID_PRIORITIES:
            priority = "medium"
        if priority == "high" and not allowed_high and not warning:
            priority = "medium"
        normalized = action.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        cleaned.append(
            {
                "priority": priority,
                "action_text": action[:ACTION_TEXT_LIMIT],
                "impact_text": impact[:IMPACT_TEXT_LIMIT],
                "evidence": evidence,
            }
        )
        if len(cleaned) >= RECOMMENDATION_LIMIT:
            break
    return cleaned


async def generate_summary(
    session: AsyncSession, product: Product, *, run_id: str | None = None
) -> AISummary | None:
    context = await build_context(session, product.id)
    if context is None or not await has_check_data(session, product.id):
        return None
    provider = get_ai_provider()
    result, source = await with_fallback(provider, "summarize", context)
    summary = AISummary(
        product_id=product.id,
        run_id=run_id,
        summary_text=result.summary_text[:4000],
        evidence={
            "avg_price": context.get("avg_price"),
            "cheapest_rival": context.get("cheapest_rival"),
            "in_stock": context.get("in_stock"),
            "total_pins": context.get("total_pins"),
            "oos_pins": context.get("oos_pins"),
        },
        source=source,
    )
    session.add(summary)
    await session.commit()
    await session.refresh(summary)
    return summary


@dataclass
class GenerationOutcome:
    """What one recommendation refresh actually did (for honest UI messages)."""

    source: str
    created: list[Recommendation] = field(default_factory=list)
    superseded: int = 0
    expired: int = 0
    skipped_recent: int = 0
    auto_approved: int = 0
    # Why nothing was created: no_check_data | limit_reached | no_change.
    reason: str | None = None
    # Why no price recommendation was made (the price threshold stayed silent).
    price_note: str | None = None


def _normalize_text(text: str) -> str:
    return " ".join(text.lower().split())


def recommendation_kind(action_text: str, evidence: dict | None) -> str:
    """Classify a recommendation so approval knows which effect to apply."""
    evidence = evidence or {}
    proposal = evidence.get("proposed_price")
    has_proposal = isinstance(proposal, (int, float)) and not isinstance(proposal, bool)
    declared = evidence.get("kind")
    if declared in RECOMMENDATION_KINDS:
        if declared == "price" and not has_proposal:
            return "pricing"
        return declared
    if has_proposal:
        return "price"
    if evidence.get("failed_pins") or evidence.get("stale_pins"):
        return "recheck"
    if evidence.get("oos_pins"):
        return "restock"
    if _RECHECK_RE.search(action_text):
        return "recheck"
    lowered = action_text.lower()
    if "restock" in lowered or "out of stock" in lowered or "out-of-stock" in lowered:
        return "restock"
    if evidence.get("gap_pct") is not None or "pric" in lowered:
        return "pricing"
    if evidence.get("rating") is not None or "rating" in lowered or "review" in lowered:
        return "rating"
    return "other"


def recommendation_target(kind: str, action_text: str, evidence: dict | None) -> str:
    """What a recommendation targets; equal kind + target means "the same advice"."""
    evidence = evidence or {}
    if kind == "price":
        proposal = evidence.get("proposed_price")
        if isinstance(proposal, (int, float)) and not isinstance(proposal, bool):
            return f"{float(proposal):.2f}"
    if kind == "restock":
        pins = sorted(str(pin) for pin in evidence.get("oos_pins") or [])
        if pins:
            return ",".join(pins)
    return _normalize_text(action_text)


def recommendation_signature(
    action_text: str, evidence: dict | None
) -> tuple[str, str]:
    kind = recommendation_kind(action_text, evidence)
    return kind, recommendation_target(kind, action_text, evidence)


def _row_signature(row: Recommendation) -> tuple[str, str]:
    return recommendation_signature(row.action_text, row.evidence)


def _retire(row: Recommendation, status: str, now: datetime) -> None:
    row.status = status
    row.decided_via = "system"
    row.decided_at = now


async def generate_recommendations(
    session: AsyncSession, product: Product
) -> tuple[list[Recommendation], str]:
    outcome = await refresh_recommendations(session, product)
    return outcome.created, outcome.source


async def refresh_recommendations(
    session: AsyncSession, product: Product
) -> GenerationOutcome:
    """Generate new recommendations, retiring stale and contradictory ones.

    - pending recommendations older than ``PENDING_TTL`` expire;
    - a candidate equal (kind + target) to a pending one is skipped, and one
      the seller decided on within ``DECISION_COOLDOWN`` is not recreated;
    - a new candidate supersedes older pending ones of the same kind group;
    - with ``approval_required`` off, new ones that pass guardrails are
      auto-approved (except re-checks, which spend credits);
    - new pending ones are pushed to linked Telegram chats.
    """
    context = await build_context(session, product.id)
    if context is None or not await has_check_data(session, product.id):
        return GenerationOutcome(source="fallback", reason="no_check_data")
    provider = get_ai_provider()
    result, source = await with_fallback(provider, "recommend", context)
    signal = signal_from_context(context)
    candidates = enforce_price_signal(result.recommendations, signal)
    outcome = GenerationOutcome(source=source)
    gap = signal.evidence.get("gap_pct")
    if signal.outcome == "silent" and isinstance(gap, (int, float)) and gap > 0:
        outcome.price_note = signal.reason
    now = datetime.now(UTC)

    pending = list(
        (
            await session.scalars(
                select(Recommendation)
                .where(
                    Recommendation.product_id == product.id,
                    Recommendation.status == "pending",
                )
                .order_by(Recommendation.created_at.desc())
            )
        ).all()
    )
    live: list[Recommendation] = []
    for row in pending:
        created_at = row.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        if now - created_at > PENDING_TTL:
            _retire(row, "expired", now)
            outcome.expired += 1
        else:
            live.append(row)

    recent_decided = (
        await session.scalars(
            select(Recommendation).where(
                Recommendation.product_id == product.id,
                Recommendation.status.in_(DECIDED_STATUSES),
                Recommendation.decided_at >= now - DECISION_COOLDOWN,
            )
        )
    ).all()
    blocked = {_row_signature(row) for row in recent_decided}
    live_signatures = {_row_signature(row) for row in live}

    cleaned = apply_recommendation_guardrails(
        candidates,
        pending_texts={row.action_text for row in live},
        context=context,
        pricing={
            **pricing_rules(product),
            "approved_change_pct_today": await approved_change_pct_today(
                session, product.id
            ),
        },
    )
    accepted: list[dict] = []
    for item in cleaned:
        signature = recommendation_signature(item["action_text"], item["evidence"])
        if signature in blocked:
            outcome.skipped_recent += 1
            continue
        if signature in live_signatures:
            continue
        item["evidence"] = {**item["evidence"], "kind": signature[0]}
        accepted.append(item)

    # The newest advice of a kind replaces the older pending one.
    groups = {
        SUPERSEDE_GROUPS[item["evidence"]["kind"]]
        for item in accepted
        if item["evidence"]["kind"] in SUPERSEDE_GROUPS
    }
    still_live: list[Recommendation] = []
    for row in live:
        group = SUPERSEDE_GROUPS.get(_row_signature(row)[0])
        if group is not None and group in groups:
            _retire(row, "superseded", now)
            outcome.superseded += 1
        else:
            still_live.append(row)

    room = max(RECOMMENDATION_LIMIT - len(still_live), 0)
    rows = [
        Recommendation(
            product_id=product.id,
            priority=item["priority"],
            action_text=item["action_text"],
            impact_text=item["impact_text"],
            evidence=item["evidence"],
        )
        for item in accepted[:room]
    ]
    session.add_all(rows)
    await session.commit()
    for row in rows:
        await session.refresh(row)
    outcome.created = rows
    if not rows:
        outcome.reason = "limit_reached" if accepted and not room else "no_change"

    if rows and not product.approval_required:
        for row in rows:
            if recommendation_kind(row.action_text, row.evidence) == "recheck":
                continue
            try:
                await approve_recommendation(session, row, decided_via="auto")
                outcome.auto_approved += 1
            except HTTPException as exc:
                logger.info("auto-approval skipped for %s: %s", row.id, exc.detail)
    still_pending = [row for row in rows if row.status == "pending"]
    if still_pending:
        from .telegram import push_new_recommendations

        try:
            await push_new_recommendations(session, product, still_pending)
        except Exception:
            logger.exception("telegram push of new recommendations failed")
    return outcome


def signal_from_context(context: dict) -> PriceSignal:
    """The price-threshold verdict stored in a built context (silent if absent)."""
    raw = context.get("price_signal") or {}
    return PriceSignal(
        outcome=raw.get("outcome", "silent"),
        reason=raw.get("reason", ""),
        evidence=dict(raw.get("evidence") or {}),
        action_text=raw.get("action_text", ""),
        impact_text=raw.get("impact_text", ""),
        priority=raw.get("priority", "medium"),
        target_price=raw.get("target_price"),
    )


def _is_price_family(candidate: RecommendationCandidate) -> bool:
    evidence = candidate.evidence or {}
    if evidence.get("kind") in PRICE_FAMILY_KINDS:
        return True
    return recommendation_kind(candidate.action_text, evidence) in PRICE_FAMILY_KINDS


def signal_candidate(signal: PriceSignal) -> RecommendationCandidate | None:
    """The rule-based recommendation for an ``adjust`` or ``hold`` verdict."""
    if signal.outcome not in ("adjust", "hold"):
        return None
    return RecommendationCandidate(
        priority=signal.priority,
        action_text=signal.action_text,
        impact_text=signal.impact_text,
        evidence=dict(signal.evidence),
    )


def _merged(signal_evidence: dict, own: dict, drop: tuple[str, ...] = ()) -> dict:
    """Measured threshold evidence wins over whatever a model claimed."""
    return {
        **own,
        **{key: value for key, value in signal_evidence.items() if key not in drop},
    }


def enforce_price_signal(
    candidates: list[RecommendationCandidate], signal: PriceSignal
) -> list[RecommendationCandidate]:
    """Make every provider's price advice obey the smart threshold.

    - ``silent``: every price-family candidate is dropped;
    - ``hold``: price moves are dropped; the provider's own margin-risk warning
      is kept (with the measured evidence), else the rule-based one is added;
    - ``adjust``: a provider price move survives only when its proposed price
      lies within the safe floor / MRP bounds and below the current price, and
      gains the threshold evidence; otherwise the rule-based one is used.
    Non-price candidates pass through untouched.
    """
    others = [c for c in candidates if not _is_price_family(c)]
    priced = [c for c in candidates if _is_price_family(c)]
    if signal.outcome not in ("adjust", "hold"):
        return others
    chosen: RecommendationCandidate | None = None
    if signal.outcome == "hold":
        for candidate in priced:
            if (candidate.evidence or {}).get("kind") == "margin_risk":
                chosen = candidate.model_copy(
                    update={
                        "priority": "high",
                        "evidence": {
                            **_merged(signal.evidence, candidate.evidence or {}),
                            "kind": "margin_risk",
                            "proposed_price": None,
                        },
                    }
                )
                break
    else:
        floor = signal.evidence.get("safe_floor")
        ceiling = signal.evidence.get("mrp")
        current = signal.evidence.get("avg_price")
        for candidate in priced:
            proposal = (candidate.evidence or {}).get("proposed_price")
            if not isinstance(proposal, (int, float)) or isinstance(proposal, bool):
                continue
            price = float(proposal)
            if floor is not None and price < float(floor) - 0.005:
                continue
            if ceiling is not None and price > float(ceiling) + 0.005:
                continue
            if current is None or price >= float(current) - 0.005:
                continue
            chosen = candidate.model_copy(
                update={
                    "evidence": {
                        **_merged(
                            signal.evidence,
                            candidate.evidence or {},
                            drop=("proposed_price", "change_pct", "margin_at_target_pct"),
                        ),
                        "kind": "price",
                        "proposed_price": round(price, 2),
                        "margin_at_target_pct": margin_after_commission_pct(
                            price,
                            {
                                "cost_price": signal.evidence.get("cost_price"),
                                "commission_pct": signal.evidence.get("commission_pct"),
                            },
                        ),
                    }
                }
            )
            break
    picked = chosen or signal_candidate(signal)
    return [picked, *others] if picked is not None else others


async def refresh_review_insights(
    session: AsyncSession, product: Product
) -> tuple[ReviewInsight | None, str]:
    context = await build_context(session, product.id)
    if context is None or not await has_check_data(session, product.id):
        return None, "fallback"
    provider = get_ai_provider()
    result, source = await with_fallback(provider, "reviews", context)
    existing = await session.scalar(
        select(ReviewInsight).where(
            ReviewInsight.product_id == product.id,
            ReviewInsight.competitor_id.is_(None),
        )
    )
    if existing is not None:
        existing.loves = result.loves[:10]
        existing.complaints = result.complaints[:10]
        existing.updated_at = datetime.now(UTC)
        row = existing
    else:
        row = ReviewInsight(
            product_id=product.id,
            competitor_id=None,
            loves=result.loves[:10],
            complaints=result.complaints[:10],
        )
        session.add(row)
    await session.commit()
    await session.refresh(row)
    return row, source


async def has_check_data(session: AsyncSession, product_id: str) -> bool:
    return (
        await session.scalar(
            select(CheckResult.id)
            .where(
                CheckResult.product_id == product_id,
                CheckResult.status == "ok",
            )
            .limit(1)
        )
    ) is not None


async def refresh_intelligence(
    session: AsyncSession, product_id: str, *, run_id: str | None = None
) -> None:
    """Post-run hook: refresh summary, recommendations, and review insights."""
    product = await session.get(Product, product_id)
    if product is None or not await has_check_data(session, product_id):
        return
    try:
        await generate_summary(session, product, run_id=run_id)
        await generate_recommendations(session, product)
        await refresh_review_insights(session, product)
    except Exception:
        logger.exception("intelligence refresh failed for product %s", product_id)


async def approved_change_pct_today(session: AsyncSession, product_id: str) -> float:
    """Sum of price moves (in %) approved for this product since UTC midnight.

    Approved actions the seller already marked done still count.
    """
    evidence_rows = (
        await session.scalars(
            select(Recommendation.evidence).where(
                Recommendation.product_id == product_id,
                Recommendation.status.in_(OPEN_ACTION_STATUSES),
                Recommendation.decided_at >= credit_day_start(),
            )
        )
    ).all()
    total = 0.0
    for evidence in evidence_rows:
        moved = (evidence or {}).get("change_pct")
        if isinstance(moved, (int, float)) and not isinstance(moved, bool):
            total += abs(float(moved))
    return round(total, 2)


DECISIONS = ("approved", "dismissed")


@dataclass
class ApprovalOutcome:
    """What approving a recommendation did."""

    recommendation: Recommendation
    effect: str  # run_started | action_created
    message: str
    action_item: str
    run_id: str | None = None


def _already_decided(recommendation: Recommendation) -> RecommendationConflict:
    return RecommendationConflict(
        f"This recommendation is already {recommendation.status}", "already_decided"
    )


async def _platform_names(
    session: AsyncSession, product_id: str, evidence: dict
) -> str:
    platforms = [str(p) for p in evidence.get("platforms") or [] if p]
    if not platforms:
        platforms = sorted(
            set(
                (
                    await session.scalars(
                        select(ProductPincode.platform).where(
                            ProductPincode.product_id == product_id
                        )
                    )
                ).all()
            )
        )
    labels = [PLATFORM_LABELS.get(p, p.title()) for p in platforms]
    if not labels:
        return "your marketplace"
    return labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]


async def _start_recheck_run(session: AsyncSession, product: Product) -> str:
    """Start a check run exactly like "Re-check now" (same limits, 409/429/422)."""
    from ..api.runs import start_run
    from ..config import get_settings
    from ..models.user import User

    user = await session.get(User, product.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Product owner not found")
    created = await start_run(
        product_id=product.id,
        payload=None,
        user=user,
        session=session,
        settings=get_settings(),
    )
    return created.run_id


async def approve_recommendation(
    session: AsyncSession,
    recommendation: Recommendation,
    *,
    decided_via: str = "web",
) -> ApprovalOutcome:
    """Approve a pending recommendation and apply its effect.

    - ``recheck``: starts a real check run (its 409/422/429 errors propagate and
      the recommendation stays pending);
    - ``price``: re-checks the guardrails on fresh numbers, then records the
      committed target price; the seller sets it in their seller panel;
    - anything else: becomes an open item on the action list.

    Raises RecommendationConflict: ``already_decided`` when it is no longer
    pending, ``guardrail_blocked`` when the pricing guardrails forbid it.
    """
    if recommendation.status != "pending":
        raise _already_decided(recommendation)
    product = await session.get(Product, recommendation.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    evidence = dict(recommendation.evidence or {})
    kind = recommendation_kind(recommendation.action_text, evidence)
    evidence["kind"] = kind
    run_id: str | None = None
    if kind == "price":
        proposal = float(evidence["proposed_price"])
        overview = await compute_overview(session, recommendation.product_id)
        current_price = overview["kpis"]["avg_price"]["value"]
        violation = price_violation(
            proposal,
            pricing_rules(product),
            current_price=current_price,
            approved_change_pct=await approved_change_pct_today(
                session, recommendation.product_id
            ),
        )
        if violation is not None:
            raise RecommendationConflict(
                f"Blocked by pricing guardrails: {violation}", "guardrail_blocked"
            )
        where = await _platform_names(session, product.id, evidence)
        evidence["base_price"] = current_price
        evidence["target_price"] = round(proposal, 2)
        evidence["change_pct"] = change_pct(proposal, current_price)
        action_item = f"Update price to ₹{proposal:.2f} on {where} seller panel"
        effect = "action_created"
        message = (
            f"Approved — “{action_item}” is on your action list. ShelfSense can't "
            "change marketplace prices, so set it yourself, then mark it done."
        )
    elif kind == "recheck":
        run_id = await _start_recheck_run(session, product)
        evidence["run_id"] = run_id
        action_item = "Re-check started"
        effect = "run_started"
        message = "Approved — re-check started"
    else:
        action_item = recommendation.action_text
        effect = "action_created"
        message = "Approved — added to your action list"
    evidence["effect"] = effect
    evidence["action_item"] = action_item
    result = await session.execute(
        update(Recommendation)
        .where(
            Recommendation.id == recommendation.id,
            Recommendation.status == "pending",
        )
        .values(
            # A started re-check is already carried out; nothing stays open.
            status="done" if effect == "run_started" else "approved",
            decided_via=decided_via,
            decided_at=datetime.now(UTC),
            evidence=evidence
            | ({"done_at": datetime.now(UTC).isoformat()} if run_id else {}),
        )
    )
    await session.commit()
    await session.refresh(recommendation)
    if not result.rowcount:
        raise _already_decided(recommendation)
    if decided_via != "telegram":
        from .telegram import notify_recommendation_approved

        try:
            await notify_recommendation_approved(
                session, recommendation, product=product, message=message
            )
        except Exception:
            logger.exception("telegram approval notice failed")
    return ApprovalOutcome(
        recommendation=recommendation,
        effect=effect,
        message=message,
        action_item=action_item,
        run_id=run_id,
    )


async def decide_recommendation(
    session: AsyncSession,
    recommendation: Recommendation,
    *,
    decision: str,
    decided_via: str = "web",
) -> Recommendation:
    """Move a pending recommendation to approved (with its effect) or dismissed.

    Raises RecommendationConflict (HTTP 409) when it is no longer pending or
    when an approval's proposed price fails the guardrails on fresh numbers.
    """
    if decision not in DECISIONS:
        raise ValueError(f"Unknown decision: {decision}")
    if decision == "approved":
        outcome = await approve_recommendation(
            session, recommendation, decided_via=decided_via
        )
        return outcome.recommendation
    if recommendation.status != "pending":
        raise _already_decided(recommendation)
    result = await session.execute(
        update(Recommendation)
        .where(
            Recommendation.id == recommendation.id,
            Recommendation.status == "pending",
        )
        .values(
            status=decision,
            decided_via=decided_via,
            decided_at=datetime.now(UTC),
        )
    )
    await session.commit()
    await session.refresh(recommendation)
    if not result.rowcount:
        raise _already_decided(recommendation)
    return recommendation


async def set_action_done(
    session: AsyncSession, recommendation: Recommendation, *, done: bool
) -> Recommendation:
    """Mark an approved action done, or reopen a done one."""
    source, target = ("approved", "done") if done else ("done", "approved")
    if recommendation.status != source:
        if recommendation.status == target:
            raise RecommendationConflict(
                f"This action is already {'done' if done else 'open'}",
                "already_decided",
            )
        raise RecommendationConflict(
            "Only approved actions can be marked done or reopened",
            "invalid_transition",
        )
    evidence = dict(recommendation.evidence or {})
    if done:
        evidence["done_at"] = datetime.now(UTC).isoformat()
    else:
        evidence.pop("done_at", None)
    result = await session.execute(
        update(Recommendation)
        .where(
            Recommendation.id == recommendation.id,
            Recommendation.status == source,
        )
        .values(status=target, evidence=evidence)
    )
    await session.commit()
    await session.refresh(recommendation)
    if not result.rowcount:
        raise _already_decided(recommendation)
    return recommendation


async def clear_pending_recommendations(
    session: AsyncSession, product_id: str
) -> int:
    result = await session.execute(
        delete(Recommendation).where(
            Recommendation.product_id == product_id,
            Recommendation.status == "pending",
        )
    )
    await session.commit()
    return result.rowcount or 0


async def list_competitor_names(
    session: AsyncSession, product_id: str
) -> dict[str, str]:
    rows = list(
        (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    )
    return {row.id: row.name for row in rows}
