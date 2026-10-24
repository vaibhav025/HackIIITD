"""AI provider contract and shared output shapes.

Both providers (Gemini and the no-key fallback) answer the same four tasks
with the same Pydantic shapes so callers never branch on provider details.
"""

from __future__ import annotations

import json
import re
from typing import Protocol

from pydantic import BaseModel, Field, field_validator


class AIProviderError(Exception):
    """Raised when a provider cannot produce a valid answer; callers fall back."""


class SummaryOut(BaseModel):
    summary_text: str


class RecommendationCandidate(BaseModel):
    priority: str = "medium"
    action_text: str
    impact_text: str = ""
    evidence: dict = Field(default_factory=dict)


class RecommendOut(BaseModel):
    recommendations: list[RecommendationCandidate] = Field(default_factory=list)


class ReviewsOut(BaseModel):
    loves: list[str] = Field(default_factory=list)
    complaints: list[str] = Field(default_factory=list)


# In-app destinations a chat action may link to; anything else is dropped.
ACTION_PATH_RE = re.compile(
    r"^/(dashboard|products(/[\w-]+(/(settings|telegram|heatmap))?)?|heatmap|help"
    r"|settings|agents)(\?[^\s#]*)?(#[\w-]+)?$"
)


def is_allowed_action_path(path: str) -> bool:
    return bool(ACTION_PATH_RE.match(path)) and "//" not in path


class ChatAction(BaseModel):
    label: str
    path: str


class ChatEvidence(BaseModel):
    metric: str
    value: float | int | str | None = None


class ChatOut(BaseModel):
    reply: str
    actions: list[ChatAction] = Field(default_factory=list)
    evidence: list[ChatEvidence] = Field(default_factory=list)

    @field_validator("actions")
    @classmethod
    def drop_unknown_paths(cls, actions: list[ChatAction]) -> list[ChatAction]:
        return [action for action in actions if is_allowed_action_path(action.path)]


class AlertRuleOut(BaseModel):
    kind: str
    threshold: float | None = None
    rule_text: str = ""
    rule_json: dict = Field(default_factory=dict)


class AIProvider(Protocol):
    name: str

    async def summarize(self, context: dict) -> SummaryOut: ...

    async def recommend(self, context: dict) -> RecommendOut: ...

    async def reviews(self, context: dict) -> ReviewsOut: ...

    async def chat(
        self, context: dict, message: str, history: list[dict]
    ) -> ChatOut: ...

    async def parse_alert_rule(self, text: str) -> AlertRuleOut: ...


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
_PINCODE_RE = re.compile(r"\b[1-9]\d{5}\b")
_RUPEE_PRICE_RE = re.compile(r"(?:₹|Rs\.?|INR)\s*(\d[\d,]*(?:\.\d+)?)", re.IGNORECASE)


def parse_json_payload(text: str) -> dict:
    """Extract a JSON object from a model response, tolerating code fences."""
    cleaned = text.strip()
    fenced = _FENCE_RE.search(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise AIProviderError("No JSON object found in model response") from None
        try:
            payload = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise AIProviderError(f"Invalid JSON in model response: {exc}") from exc
    if not isinstance(payload, dict):
        raise AIProviderError("Model response JSON was not an object")
    return payload


def grounding_violations(
    text: str, context: dict, extra_prices: set[float] | None = None
) -> list[str]:
    """Return violations when text mentions pincodes/prices absent from context.

    The brief requires rejecting model outputs that invent pincodes or prices;
    callers fall back to the rule-based provider when this list is non-empty.
    When the context carries no prices at all, any rupee amount is invented.
    ``extra_prices`` are additionally allowed (structured price proposals,
    which the recommendation guardrails validate separately).
    """
    allowed_pins = {str(pin) for pin in context.get("all_pins", [])}
    allowed_pins.update(str(pin) for pin in context.get("oos_pins", []))
    for change in context.get("recent_changes", []):
        if change.get("pincode"):
            allowed_pins.add(str(change["pincode"]))
    for item in context.get("portfolio") or ():
        if isinstance(item, dict):
            allowed_pins.update(str(pin) for pin in item.get("oos_pins") or ())
    for row in context.get("platform_prices") or ():
        if isinstance(row, dict):
            allowed_pins.update(str(pin) for pin in row.get("oos_pins") or ())
    allowed_prices = {
        round(float(context[key]), 2)
        for key in (
            "avg_price",
            "cheapest_rival",
            "this_week_avg_price",
            "last_week_avg_price",
        )
        if isinstance(context.get(key), (int, float))
    }
    for change in context.get("recent_changes", []):
        for field in ("old_value", "new_value"):
            value = change.get(field)
            if isinstance(value, (int, float)):
                allowed_prices.add(round(float(value), 2))
    pricing = context.get("pricing") or {}
    for key in ("floor_price", "cost_price"):
        if isinstance(pricing.get(key), (int, float)):
            allowed_prices.add(round(float(pricing[key]), 2))
    signal = context.get("price_signal") or {}
    signal_evidence = signal.get("evidence") or {}
    for value in (
        signal.get("target_price"),
        *(
            signal_evidence.get(key)
            for key in ("safe_floor", "break_even", "mrp", "cheapest_rival", "gap_rupees")
        ),
    ):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            allowed_prices.add(round(float(value), 2))
    allowed_prices.update(_chat_context_prices(context))
    allowed_prices.update(round(price, 2) for price in extra_prices or ())
    violations: list[str] = []
    for pin in _PINCODE_RE.findall(text):
        if allowed_pins and pin not in allowed_pins:
            violations.append(f"unknown pincode {pin}")
        elif not allowed_pins:
            violations.append(f"pincode mentioned {pin} but none were provided")
    for raw in _RUPEE_PRICE_RE.findall(text):
        price = round(float(raw.replace(",", "")), 2)
        if not any(abs(price - known) < 0.011 for known in allowed_prices):
            violations.append(f"unknown price {price}")
    return violations


_PLATFORM_PRICE_FIELDS = ("my_price", "my_checkout", "rival_price", "rival_checkout")


def _chat_context_prices(context: dict) -> set[float]:
    """Prices the chat context carries beyond the headline KPIs.

    Per-platform comparisons (shelf and checkout), portfolio rows, and the text
    of stored recommendations are all measured or already-vetted numbers, so a
    model may quote them without tripping the grounding check.
    """
    prices: set[float] = set()

    def add(value: object) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            prices.add(round(float(value), 2))

    def add_platforms(rows: object) -> None:
        for row in rows if isinstance(rows, list) else ():
            if isinstance(row, dict):
                for field in _PLATFORM_PRICE_FIELDS:
                    add(row.get(field))
                # The rupee gap to the rival is derived from the same measured pair.
                for mine, theirs in (("my_price", "rival_price"), ("my_checkout", "rival_checkout")):
                    a, b = row.get(mine), row.get(theirs)
                    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                        add(abs(float(a) - float(b)))

    add_platforms(context.get("platform_prices"))
    for item in context.get("portfolio") or ():
        if isinstance(item, dict):
            add(item.get("avg_price"))
            add(item.get("cheapest_rival"))
            add_platforms(item.get("platform_prices"))
    for key in ("pending_recommendations", "approved_actions"):
        for item in context.get(key) or ():
            if isinstance(item, dict):
                for raw in _RUPEE_PRICE_RE.findall(str(item.get("action_text") or "")):
                    add(float(raw.replace(",", "")))
    return prices


def proposed_prices(task: str, result: BaseModel) -> set[float]:
    """Structured price proposals in a recommend result (validated by guardrails)."""
    if task != "recommend":
        return set()
    prices: set[float] = set()
    for item in result.recommendations:
        value = item.evidence.get("proposed_price")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            prices.add(float(value))
    return prices


def result_text(task: str, result: BaseModel) -> str:
    """Flatten a provider result to the text the grounding check inspects."""
    if task == "summarize":
        return result.summary_text
    if task == "recommend":
        return " ".join(
            f"{item.action_text} {item.impact_text}" for item in result.recommendations
        )
    if task == "reviews":
        return " ".join([*result.loves, *result.complaints])
    if task == "chat":
        return result.reply
    if task == "parse_alert_rule":
        return result.rule_text
    return ""
