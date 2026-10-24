"""AI provider selection: Gemini when configured, deterministic fallback otherwise.

With no GEMINI_API_KEY the fallback answers instantly and offline, so every
AI-backed feature works in mock mode. When Gemini is enabled and a call fails,
helpers in app.services.intelligence catch AIProviderError and retry with the
fallback — the user always gets an answer.
"""

from __future__ import annotations

import logging

from ...config import get_settings
from .base import (
    AIProvider,
    AIProviderError,
    grounding_violations,
    proposed_prices,
    result_text,
)
from .fallback import FallbackAIProvider
from .gemini_client import GeminiAIProvider

logger = logging.getLogger("shelfsense.ai")

__all__ = [
    "AIProvider",
    "AIProviderError",
    "FallbackAIProvider",
    "GeminiAIProvider",
    "get_ai_provider",
    "with_fallback",
]

GROUNDED_TASKS = ("summarize", "recommend", "chat")


def get_ai_provider() -> AIProvider:
    settings = get_settings()
    if settings.gemini_enabled:
        try:
            return GeminiAIProvider(
                api_key=settings.gemini_api_key, model=settings.gemini_model
            )
        except Exception:
            logger.exception("Gemini provider init failed; using fallback")
    return FallbackAIProvider()


async def with_fallback(primary: AIProvider, task: str, *args, **kwargs):
    """Run a provider task, falling back to rules when Gemini errors.

    Gemini outputs also pass a grounding check: any pincode or price that is
    not present in the supplied context rejects the answer and the deterministic
    fallback is used instead. Returns ``(result, source_name)`` so callers can
    persist which provider actually produced the answer.
    """
    fallback = FallbackAIProvider()
    if primary.name == fallback.name:
        return await getattr(primary, task)(*args, **kwargs), fallback.name
    try:
        result = await getattr(primary, task)(*args, **kwargs)
    except AIProviderError:
        logger.warning("Gemini %s failed; using rule-based fallback", task)
        return await getattr(fallback, task)(*args, **kwargs), fallback.name
    if task in GROUNDED_TASKS:
        context = args[0] if args else kwargs.get("context", {})
        violations = grounding_violations(
            result_text(task, result), context, proposed_prices(task, result)
        )
        if violations:
            logger.warning(
                "Gemini %s failed grounding check (%s); using fallback",
                task,
                "; ".join(violations),
            )
            return await getattr(fallback, task)(*args, **kwargs), fallback.name
    return result, primary.name
