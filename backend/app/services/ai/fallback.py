"""Deterministic rule-based AI fallback.

Used whenever Gemini is not configured or fails. Every sentence is built from
the measured context numbers, so the app stays useful with zero API keys.
"""

from __future__ import annotations

import re

from .base import (
    AlertRuleOut,
    ChatOut,
    RecommendationCandidate,
    RecommendOut,
    ReviewsOut,
    SummaryOut,
)
from .chat_router import answer_chat

_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_BELOW_RE = re.compile(r"below\s+(\d+(?:\.\d+)?)")
_PINCODE_RE = re.compile(r"^[1-9]\d{5}$")
# "out of stock in South Delhi", "OOS at 110017 and 110016 on blinkit".
_AREA_RE = re.compile(
    r"(?:out[\s-]of[\s-]stock|stockouts?|oos)\s+(?:in|at|across|around|for)\s+"
    r"(?P<areas>.+?)(?:\s+on\s+\w+)?\s*[.!?]*$",
    re.IGNORECASE,
)
_AREA_SPLIT_RE = re.compile(r"\s*(?:,|\band\b|&|/)\s*", re.IGNORECASE)
_NOT_AN_AREA = {"any", "all", "every", "some", "a", "the"}


def _fmt_money(value: float | None) -> str:
    return "n/a" if value is None else f"₹{value:.2f}"


def parse_rule_areas(text: str) -> tuple[list[str], list[str]] | None:
    """Areas and pincodes named after "out of stock in …", or None."""
    match = _AREA_RE.search(text.strip())
    if match is None:
        return None
    areas: list[str] = []
    pincodes: list[str] = []
    for part in _AREA_SPLIT_RE.split(match.group("areas")):
        cleaned = part.strip(" .")
        if not cleaned or cleaned.lower() in _NOT_AN_AREA:
            continue
        if _PINCODE_RE.match(cleaned):
            pincodes.append(cleaned)
        elif not cleaned.lower().startswith(("any ", "all ", "every ")):
            areas.append(cleaned)
    if not areas and not pincodes:
        return None
    return areas, pincodes


def _gap_pct(context: dict) -> float | None:
    avg_price = context.get("avg_price")
    rival = context.get("cheapest_rival")
    if avg_price is None or rival is None or rival == 0:
        return None
    return round((avg_price / rival - 1) * 100, 1)


class FallbackAIProvider:
    name = "fallback"

    async def summarize(self, context: dict) -> SummaryOut:
        name = context.get("product_name", "This product")
        in_stock = context.get("in_stock")
        total = context.get("total_pins")
        oos_pins: list[str] = context.get("oos_pins", [])
        gap = _gap_pct(context)
        sentences = [
            (
                f"{name} averages {_fmt_money(context.get('avg_price'))} across "
                f"{total or 0} checked pins with {in_stock or 0} in stock."
            )
        ]
        rival = context.get("cheapest_rival")
        if rival is not None:
            if gap is not None and gap > 0:
                sentences.append(
                    f"The cheapest rival offer is {_fmt_money(rival)}, "
                    f"about {gap}% below your average price."
                )
            else:
                sentences.append(
                    f"The cheapest rival offer is {_fmt_money(rival)}; your "
                    "pricing is competitive."
                )
        if oos_pins:
            preview = ", ".join(oos_pins[:4])
            more = "" if len(oos_pins) <= 4 else f" (+{len(oos_pins) - 4} more)"
            sentences.append(
                f"Out of stock in {len(oos_pins)} pin(s): {preview}{more} — "
                "prioritise restock and listing checks there."
            )
        if context.get("hot_zone_count"):
            sentences.append(
                f"{context['hot_zone_count']} hot zone(s) of clustered "
                "out-of-stock pins need attention."
            )
        return SummaryOut(summary_text=" ".join(sentences))

    async def recommend(self, context: dict) -> RecommendOut:
        candidates: list[RecommendationCandidate] = []
        oos_pins: list[str] = context.get("oos_pins", [])
        platforms = context.get("oos_platforms") or context.get("platforms") or []
        if oos_pins:
            priority = "high" if len(oos_pins) >= 3 else "medium"
            where = f" on {', '.join(platforms)}" if platforms else ""
            candidates.append(
                RecommendationCandidate(
                    priority=priority,
                    action_text=(
                        f"Check restock and listing health{where} for "
                        f"out-of-stock pins {', '.join(oos_pins[:5])}."
                    ),
                    impact_text=(
                        "Recovering availability in these pins wins back "
                        "quick-commerce sales before rivals fill the gap."
                    ),
                    evidence={"kind": "restock", "oos_pins": oos_pins, "platforms": platforms},
                )
            )
        # Price advice comes only from the smart threshold's verdict
        # (services/price_thresholds.py): adjust -> a bounded price move,
        # hold -> a "don't price-match" margin warning, silent -> nothing.
        signal = context.get("price_signal") or {}
        if signal.get("outcome") in ("adjust", "hold") and signal.get("action_text"):
            candidates.append(
                RecommendationCandidate(
                    priority=signal.get("priority") or "medium",
                    action_text=signal["action_text"],
                    impact_text=signal.get("impact_text") or "",
                    evidence=dict(signal.get("evidence") or {}),
                )
            )
        rating = context.get("rating")
        if rating is not None and rating < 4.2:
            candidates.append(
                RecommendationCandidate(
                    priority="low",
                    action_text=(
                        f"Average rating is {rating:.1f}; inspect recent "
                        "reviews for recurring quality or delivery complaints."
                    ),
                    impact_text="Improving ratings protects visibility in platform ranking.",
                    evidence={"kind": "rating", "rating": rating},
                )
            )
        failed = context.get("failed_pins") or 0
        if failed:
            candidates.append(
                RecommendationCandidate(
                    priority="low",
                    action_text=(
                        f"{failed} check(s) failed on the latest run; re-run them "
                        "to fill the gaps in the heatmap."
                    ),
                    impact_text="Failed checks leave those pins without fresh data.",
                    evidence={"kind": "recheck", "failed_pins": failed},
                )
            )
        stale = context.get("stale_pins") or 0
        if stale:
            candidates.append(
                RecommendationCandidate(
                    priority="low",
                    action_text=(
                        f"{stale} pin(s) have stale checks; run a fresh check "
                        "to restore heatmap confidence."
                    ),
                    impact_text="Fresh data keeps recommendations and alerts accurate.",
                    evidence={"kind": "recheck", "stale_pins": stale},
                )
            )
        # "No urgent issues" would contradict advice that is still pending.
        if not candidates and not context.get("recommendation_preview"):
            candidates.append(
                RecommendationCandidate(
                    priority="low",
                    action_text=(
                        "No urgent issues detected; keep the weekly check "
                        "cadence to maintain coverage."
                    ),
                    impact_text="Steady monitoring prevents surprise stockouts.",
                    evidence={"kind": "other", "avg_price": context.get("avg_price")},
                )
            )
        return RecommendOut(recommendations=candidates[:3])

    async def reviews(self, context: dict) -> ReviewsOut:
        loves: list[str] = []
        complaints: list[str] = []
        total = context.get("total_pins") or 0
        in_stock = context.get("in_stock") or 0
        if total and in_stock / total >= 0.8:
            loves.append("Consistent availability across most checked pins")
        gap = _gap_pct(context)
        if gap is not None and gap <= 0:
            loves.append("Competitive pricing versus the cheapest rival")
        rating = context.get("rating")
        if rating is not None and rating >= 4.3:
            loves.append("Strong average product rating")
        if context.get("oos_pins"):
            complaints.append("Out-of-stock pockets in specific pincodes")
        threshold = (
            (context.get("price_signal") or {}).get("evidence") or {}
        ).get("threshold_pct") or 5
        if gap is not None and gap >= threshold:
            complaints.append("Priced above rivals on some platforms")
        if rating is not None and rating < 4.2:
            complaints.append("Mixed ratings feedback from customers")
        if not loves and not complaints:
            loves.append("Steady performance across price and stock signals")
        return ReviewsOut(loves=loves[:4], complaints=complaints[:4])

    async def chat(
        self, context: dict, message: str, history: list[dict]
    ) -> ChatOut:
        del history  # the rule-based answer only needs the current message
        return answer_chat(context, message)

    async def parse_alert_rule(self, text: str) -> AlertRuleOut:
        lowered = text.lower()
        if any(
            word in lowered
            for word in ("out of stock", "out-of-stock", "stockout", "oos")
        ):
            if "rival" in lowered or "competitor" in lowered:
                return AlertRuleOut(
                    kind="rival_oos",
                    rule_text=text,
                    rule_json={"trigger": "competitor out of stock"},
                )
            located = parse_rule_areas(text)
            if located is not None:
                areas, pincodes = located
                return AlertRuleOut(
                    kind="oos_area",
                    rule_text=text,
                    rule_json={"areas": areas, "pincodes": pincodes},
                )
            return AlertRuleOut(
                kind="oos_any", rule_text=text, rule_json={"trigger": "seller oos"}
            )
        if "rating" in lowered:
            match = _BELOW_RE.search(lowered) or _PERCENT_RE.search(lowered)
            threshold = float(match.group(1)) if match else 4.0
            return AlertRuleOut(
                kind="rating_below",
                threshold=threshold,
                rule_text=text,
                rule_json={"trigger": "rating below"},
            )
        if "price" in lowered:
            match = _PERCENT_RE.search(lowered)
            threshold = float(match.group(1)) if match else None
            direction = "drop" if any(
                word in lowered for word in ("drop", "down", "fall", "decrease")
            ) else "change"
            return AlertRuleOut(
                kind="price_change_pct",
                threshold=threshold,
                rule_text=text,
                rule_json={"trigger": f"price {direction}"},
            )
        return AlertRuleOut(
            kind="custom", rule_text=text, rule_json={"trigger": "custom"}
        )
