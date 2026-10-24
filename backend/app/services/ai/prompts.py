"""Prompt builders for the Gemini provider.

Every prompt embeds the evidence numbers so the model can only summarise what
we measured, plus the guardrail instructions it must follow. Builders return
``(system_instruction, contents)`` where ``contents`` is a list of structured
turns (``{"role": "user" | "model", "parts": [{"text": ...}]}``).
"""

from __future__ import annotations

import json

Turn = dict
HISTORY_TURNS = 6

GUARDRAIL_RULES = """\
You are ShelfSense AI, an assistant that helps quick-commerce sellers in India
understand price and shelf-visibility data. Follow these rules:
- Only use the numbers provided in the context. Never invent prices, pins, or stats.
- Prices are Indian Rupees. Never suggest illegal, deceptive, or anti-competitive
  behaviour (price fixing, cartels, fake reviews, sabotage of competitors).
- Keep advice actionable and short. Reply with a single JSON object only,
  matching the requested schema. No markdown, no commentary.
"""


def _context_block(context: dict) -> str:
    return json.dumps(context, default=str, ensure_ascii=False)


def _turn(role: str, text: str) -> Turn:
    return {"role": role, "parts": [{"text": text}]}


def _single(text: str) -> list[Turn]:
    return [_turn("user", text)]


def summarize_prompt(context: dict) -> tuple[str, list[Turn]]:
    system = (
        GUARDRAIL_RULES
        + "\nTask: write a 2-3 sentence seller-facing summary of the product's "
        "price and stock position. Reply with JSON: "
        '{"summary_text": "..."}'
    )
    return system, _single(f"Context:\n{_context_block(context)}")


def recommend_prompt(context: dict) -> tuple[str, list[Turn]]:
    system = (
        GUARDRAIL_RULES
        + "\nTask: propose up to 3 concrete recommendations. Priority must be "
        '"high", "medium", or "low". Every recommendation must cite evidence '
        "from the context. When a recommendation proposes a new price, put that "
        "number in evidence.proposed_price; it must respect context.pricing "
        "(floor_price, cost_price plus min_margin_pct, max_change_pct versus "
        "avg_price). Otherwise set evidence.proposed_price to null. Set "
        "evidence.kind to one of price (a concrete new price), pricing (review "
        "pricing without a concrete price), restock (fix availability), recheck "
        "(re-run failed or stale checks), rating, or other. Price advice must "
        "follow context.price_signal: when its outcome is \"silent\" give no "
        "price or pricing recommendation; when it is \"adjust\" you may propose "
        "a price between evidence.safe_floor and evidence.mrp (when set) and "
        "below avg_price, ideally price_signal.target_price; when it is "
        "\"hold\" never propose matching the rival — use evidence.kind "
        "margin_risk to warn that matching would be below the safe floor and "
        "suggest competing on stock, delivery, or bundles. Reply with "
        'JSON: {"recommendations": [{"priority": "...", "action_text": "...", '
        '"impact_text": "...", "evidence": {"kind": "...", '
        '"proposed_price": number|null, ...}}]}'
    )
    return system, _single(f"Context:\n{_context_block(context)}")


def reviews_prompt(context: dict) -> tuple[str, list[Turn]]:
    system = (
        GUARDRAIL_RULES
        + "\nTask: list the seller's own product strengths (loves) and weak "
        "spots (complaints) as shoppers would experience them, derived only "
        "from the seller's availability, price, and rating signals in the "
        "context. These describe the seller's product, never a competitor's "
        "(3-5 short bullet phrases each). Reply with JSON: "
        '{"loves": ["..."], "complaints": ["..."]}'
    )
    return system, _single(f"Context:\n{_context_block(context)}")


def chat_prompt(
    context: dict, message: str, history: list[dict]
) -> tuple[str, list[Turn]]:
    system = (
        GUARDRAIL_RULES
        + "\nTask: answer the seller's question about their product data, or "
        "explain how to use ShelfSense (adding products, pincodes, alerts, "
        "approvals, credits and plans, Telegram linking). "
        "If the question is unrelated to ShelfSense, politely say you can "
        "only help with the seller's ShelfSense data and how to use the app. "
        "Reply with JSON: "
        '{"reply": "...", "actions": [{"label": "...", "path": "..."}], '
        '"evidence": [{"metric": "...", "value": ...}]}. '
        "Action paths must be in-app paths such as /products/<id>, "
        "/products/<id>/settings, /heatmap?product=<id>, /dashboard, /agents."
        f"\n\nContext:\n{_context_block(context)}"
    )
    contents: list[Turn] = []
    for entry in history[-HISTORY_TURNS:]:
        text = str(entry.get("content") or "").strip()
        if not text:
            continue
        role = "model" if entry.get("role") == "assistant" else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].append({"text": text})
        else:
            contents.append(_turn(role, text))
    if contents and contents[-1]["role"] == "user":
        contents[-1]["parts"].append({"text": message})
    else:
        contents.append(_turn("user", message))
    return system, contents


def parse_alert_rule_prompt(text: str) -> tuple[str, list[Turn]]:
    system = (
        GUARDRAIL_RULES
        + "\nTask: convert the seller's natural-language alert request into a "
        "structured rule. kind must be one of oos_any, oos_area, rival_oos, "
        "price_change_pct, price_gap_pct, rating_below, custom. Use oos_area "
        "when the request names places: put area or locality names in "
        "rule_json.areas and any 6-digit pincodes in rule_json.pincodes. "
        "threshold is a number when relevant (percent for price, rating points "
        'for rating). Reply with JSON: {"kind": "...", "threshold": ..., '
        '"rule_text": "...", "rule_json": {"areas": [...], "pincodes": [...]}}'
    )
    return system, _single(f"Request:\n{text}")
