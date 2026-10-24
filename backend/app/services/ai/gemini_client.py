"""Gemini provider using the official google-genai SDK.

All SDK and wire-format details stay inside this module. Any failure
(misconfiguration, transport error, malformed JSON) raises AIProviderError so
the caller can transparently switch to the rule-based fallback.
"""

from __future__ import annotations

import asyncio
import logging

from google import genai
from google.genai import types

from .base import (
    AIProviderError,
    AlertRuleOut,
    ChatOut,
    RecommendOut,
    ReviewsOut,
    SummaryOut,
    parse_json_payload,
)
from .prompts import (
    chat_prompt,
    parse_alert_rule_prompt,
    recommend_prompt,
    reviews_prompt,
    summarize_prompt,
)

logger = logging.getLogger("shelfsense.ai.gemini")

DEFAULT_MODEL = "gemini-2.5-flash"
GENERATION_TIMEOUT_SECONDS = 30.0

# The shared chat prompt only covers data questions; the in-app assistant also
# explains how to use ShelfSense, grounded in the static help catalogue.
CHAT_HOW_TO_RULES = (
    "\nYou may also answer how-to questions about using ShelfSense (adding "
    "products, choosing pincodes and platforms, connecting Telegram, alert "
    "rules, credits and plans, approving or dismissing recommendations, the "
    "heatmap, checks and runs, the weekly report) using context.help_topics. "
    "Useful action paths: /products (add a product), /products/<id>/telegram "
    "(connect Telegram), /settings#telegram, /settings#plan, "
    "/products/<id>/settings#pincodes, /products/<id>/settings#rules. Politely "
    "decline questions unrelated to ShelfSense (weather, news, general trivia)."
)


class GeminiAIProvider:
    name = "gemini"

    def __init__(self, api_key: str, model: str = "") -> None:
        if not api_key:
            raise AIProviderError("Gemini API key is missing")
        self._client = genai.Client(api_key=api_key)
        self._model = model or DEFAULT_MODEL

    async def _generate(self, system: str, contents: list[dict]) -> dict:
        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        response_mime_type="application/json",
                        temperature=0.2,
                        max_output_tokens=1024,
                    ),
                ),
                timeout=GENERATION_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise AIProviderError(
                f"Gemini timed out after {GENERATION_TIMEOUT_SECONDS:.0f}s"
            ) from exc
        except Exception as exc:  # SDK raises many transport/quota error types
            raise AIProviderError(f"Gemini request failed: {exc}") from exc
        try:
            # Blocked or truncated candidates can make ``.text`` raise or be None.
            text = (response.text or "").strip()
        except Exception as exc:
            raise AIProviderError(f"Gemini response unreadable: {exc}") from exc
        if not text:
            raise AIProviderError("Gemini returned an empty response")
        return parse_json_payload(text)

    async def summarize(self, context: dict) -> SummaryOut:
        system, contents = summarize_prompt(context)
        try:
            return SummaryOut.model_validate(await self._generate(system, contents))
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError(f"Bad summary payload: {exc}") from exc

    async def recommend(self, context: dict) -> RecommendOut:
        system, contents = recommend_prompt(context)
        try:
            return RecommendOut.model_validate(await self._generate(system, contents))
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError(f"Bad recommendation payload: {exc}") from exc

    async def reviews(self, context: dict) -> ReviewsOut:
        system, contents = reviews_prompt(context)
        try:
            return ReviewsOut.model_validate(await self._generate(system, contents))
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError(f"Bad reviews payload: {exc}") from exc

    async def chat(
        self, context: dict, message: str, history: list[dict]
    ) -> ChatOut:
        from ..help_topics import list_help_topics

        grounded = {
            **context,
            "help_topics": [
                {"title": topic["title"], "body": topic["body"]}
                for topic in list_help_topics()
            ],
        }
        system, contents = chat_prompt(grounded, message, history)
        system += CHAT_HOW_TO_RULES
        try:
            return ChatOut.model_validate(await self._generate(system, contents))
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError(f"Bad chat payload: {exc}") from exc

    async def parse_alert_rule(self, text: str) -> AlertRuleOut:
        system, contents = parse_alert_rule_prompt(text)
        try:
            return AlertRuleOut.model_validate(await self._generate(system, contents))
        except AIProviderError:
            raise
        except Exception as exc:
            raise AIProviderError(f"Bad alert-rule payload: {exc}") from exc
