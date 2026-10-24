"""Which apps are checked, how, and what each check costs.

Shared by the runner (job filtering, credit estimates), the heatmap (apps that
can never be checked live) and the Agents page app list, so all three agree.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from ...config import Settings

# How each app is checked, from live tests on 2026-10-18 (pincode 110017):
# plain Browser API sessions were 403'd by Blinkit, got a blank page on Zepto,
# and hit a phone-login wall on Instamart search once a location was set. The
# Agent API in stealth mode read Zepto and Instamart correctly (~3 min each).
# Blinkit blocked even the stealth agent, so its checks fail fast as "blocked".
# Amazon.in and Flipkart pages are read with the Fetch API (seconds, no
# browser); Fetch cannot enter a pincode, so those results are listing-wide.
CHECK_STRATEGY: dict[str, Literal["agent", "browser", "fetch"]] = {
    "blinkit": "agent",
    "zepto": "agent",
    "instamart": "agent",
    "amazon": "fetch",
    "flipkart": "fetch",
}
APP_LABELS = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Swiggy Instamart",
    "amazon": "Amazon.in",
    "flipkart": "Flipkart",
}
UNAVAILABLE_REASONS = {
    "blinkit": "Blinkit blocks automated browsers, including TinyFish stealth mode",
}
NOT_LIVE_REASON = "Not enabled in TINYFISH_LIVE_PLATFORMS"


def is_fetch_platform(platform: str) -> bool:
    """Amazon / Flipkart: one listing-wide page read, not a per-pincode agent."""
    return CHECK_STRATEGY.get(platform) == "fetch"


def credit_cost(platform: str) -> int:
    """Credits one successful check costs: agent sessions 1, Fetch page reads 0."""
    return 0 if is_fetch_platform(platform) else 1


def skipped_platforms(settings: Settings, platforms: Iterable[str]) -> list[str]:
    """Selected apps a run leaves out because they are not checked live."""
    if not settings.tinyfish_enabled:
        return []
    return sorted({p for p in platforms if p not in settings.live_platforms})


def unavailable_reason(platform: str) -> str:
    return UNAVAILABLE_REASONS.get(platform, NOT_LIVE_REASON)
