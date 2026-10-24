"""Demo mode: replay real TinyFish results saved earlier, so a demo never breaks.

``data/demo_results.json`` holds results captured from genuine live runs
(``python -m scripts.export_demo_cache``), with their evidence screenshots in
``data/demo_screenshots/``. ``CachedFallbackClient`` answers from that cache
when ``TINYFISH_DEMO=true``, or when a live check fails. Every cached answer
says so in its agent trace and in ``raw["source"] == "demo_cache"``.
"""

from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

from .agent import AgentTrace
from .base import (
    CheckResult,
    FetchResult,
    SearchHit,
    StepCallback,
    TinyFishClient,
    TinyFishError,
)

logger = logging.getLogger("shelfsense.tinyfish")

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
CACHE_PATH = DATA_DIR / "demo_results.json"
SCREENSHOT_DIR = DATA_DIR / "demo_screenshots"
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return {token for token in _TOKEN_RE.findall(text.lower()) if len(token) >= 2}


@lru_cache
def load_cache(path: Path = CACHE_PATH) -> tuple[dict, ...]:
    if not path.exists():
        return ()
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.exception("demo cache %s is unreadable", path)
        return ()
    return tuple(entry for entry in entries if isinstance(entry, dict))


def find_cached(platform: str, pincode: str, query: str) -> dict | None:
    """Saved result for this app and pincode whose product matches the query."""
    wanted = _tokens(query)
    best: tuple[int, dict] | None = None
    for entry in load_cache():
        if entry.get("platform") != platform or entry.get("pincode") != pincode:
            continue
        score = len(wanted & _tokens(str(entry.get("query", ""))))
        if score >= max(1, len(wanted) // 2) and (best is None or score > best[0]):
            best = (score, entry)
    return best[1] if best else None


async def cached_result(
    entry: dict, *, reason: str, on_step: StepCallback | None
) -> CheckResult:
    trace = AgentTrace(goal=f"Demo cache: {reason}", mode="live", on_step=on_step)
    captured = entry.get("checked_at", "an earlier live run")
    await trace.step("done", "Showing cached live result", f"{reason} · captured {captured}")
    screenshot = None
    name = entry.get("screenshot")
    if name:
        path = (SCREENSHOT_DIR / name).resolve()
        if path.is_relative_to(SCREENSHOT_DIR.resolve()) and path.exists():
            screenshot = path.read_bytes()
    return CheckResult(
        product=entry.get("product"),
        in_stock=entry.get("in_stock"),
        price=entry.get("price"),
        mrp=entry.get("mrp"),
        eta_minutes=entry.get("eta_minutes"),
        screenshot_bytes=screenshot,
        screenshot_content_type="image/jpeg",
        credits_used=0,
        raw={
            "source": "demo_cache",
            "cached_from": entry.get("run_id"),
            "captured_at": captured,
            "reason": reason,
            "exact_match": entry.get("exact_match", True),
            "notes": entry.get("notes") or [],
            "agent": trace.as_raw(),
        },
    )


class CachedFallbackClient:
    """Wraps a client: cache first in demo mode, cache on failure otherwise."""

    def __init__(self, inner: TinyFishClient, *, demo: bool) -> None:
        self.inner = inner
        self.demo = demo
        self.mode = inner.mode

    async def check(
        self,
        platform: str,
        pincode: str,
        query: str,
        url: str | None = None,
        on_step: StepCallback | None = None,
    ) -> CheckResult:
        entry = find_cached(platform, pincode, query)
        if self.demo and entry is not None:
            return await cached_result(entry, reason="demo mode", on_step=on_step)
        try:
            return await self.inner.check(platform, pincode, query, url=url, on_step=on_step)
        except TinyFishError as exc:
            if entry is None:
                raise
            logger.warning(
                "live check failed app=%s pincode=%s (%s); using cached result",
                platform,
                pincode,
                exc,
            )
            result = await cached_result(
                entry, reason=f"live check failed: {exc}", on_step=on_step
            )
            result.credits_used = exc.credits_used
            return result

    async def search(self, query: str) -> list[SearchHit]:
        return await self.inner.search(query)

    async def fetch(self, url: str) -> FetchResult:
        return await self.inner.fetch(url)
