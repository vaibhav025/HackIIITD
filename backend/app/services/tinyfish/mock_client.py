"""Simulated TinyFish web agent used whenever the API key is absent.

Each check plays out like a real agent session — browser start, navigation,
delivery pincode, search, product page, extraction, true-price checkout
(quick commerce only, never placing an order), screenshot — streaming every
step through ``on_step`` with realistic pacing (about 1.5-4 s per session).
Amazon and Flipkart mirror live mode's Fetch API reads: listing-wide (the
same result for every pincode, ``pincode_specific: False``) and free.

Outcomes are deterministic per (query, pincode, platform, url): ~5% of
sessions fail, ~15% come back out of stock, and prices drift enough to
produce price gaps. Only the pacing is randomised. Tests can make sessions
instant with ``MockTinyFishClient(delay=(0, 0))`` or the
``TINYFISH_SIM_DELAY_SCALE`` setting.
"""

from __future__ import annotations

import asyncio
import hashlib
import random

from ...config import get_settings
from ...models.base import utcnow
from .agent import AgentTrace, format_rupees
from .availability import is_fetch_platform
from .base import (
    CheckResult,
    FetchResult,
    SearchHit,
    StepCallback,
    TinyFishError,
    TruePrice,
)
from .goals import agent_target_url, build_check_goal, site_domain
from .screenshot import render_product_screenshot

QUICK_COMMERCE = {"blinkit", "zepto", "instamart"}
MOCK_DOMAIN = "mock.shelfsense.local"
SEARCH_PLATFORMS = ("blinkit", "zepto", "instamart", "amazon", "flipkart")
SESSION_SECONDS = (1.5, 4.0)
CREDITS_PER_SESSION = 1
# Relative share of a session's wall time spent in each step.
STEP_WEIGHTS = {
    "session": 0.10,
    "navigate": 0.20,
    "location": 0.14,
    "search": 0.16,
    "open": 0.12,
    "extract": 0.14,
    "checkout": 0.09,
    "screenshot": 0.05,
}
SEARCH_VARIANTS = ("Value Pack", "Combo Pack", "Store Brand", "Family Pack", "Mini Pack")
FAILURES = ("Page blocked automation (simulated)", "Store unavailable at this pincode")


def _digest(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def default_session_seconds() -> tuple[float, float]:
    scale = max(float(getattr(get_settings(), "tinyfish_sim_delay_scale", 1.0)), 0.0)
    low, high = SESSION_SECONDS
    return (low * scale, high * scale)


def _eta_label(eta_minutes: int) -> str:
    if eta_minutes < 120:
        return f"{eta_minutes} min"
    days = max(round(eta_minutes / 1440), 1)
    return f"{days} day{'s' if days > 1 else ''}"


def compute_true_price(price: float, seed: int) -> TruePrice:
    """Deterministic checkout breakdown: item + handling + delivery − offer."""
    handling = (2.0, 4.0, 4.0, 5.0, 6.0)[seed % 5]
    delivery = 0.0 if (seed // 5) % 10 < 7 else (15.0, 25.0)[(seed // 50) % 2]
    offer = min((0.0, 0.0, 2.0, 5.0)[(seed // 100) % 4], round(price * 0.2, 2))
    final = round(price + handling + delivery - offer, 2)
    return {
        "item": price,
        "handling_fee": handling,
        "delivery_fee": delivery,
        "offer": offer,
        "final": final,
    }


class MockTinyFishClient:
    mode = "simulated"

    def __init__(self, delay: tuple[float, float] | None = None) -> None:
        self.delay = delay if delay is not None else default_session_seconds()

    async def check(
        self,
        platform: str,
        pincode: str,
        query: str,
        url: str | None = None,
        on_step: StepCallback | None = None,
    ) -> CheckResult:
        clean_query = " ".join(query.split())
        if is_fetch_platform(platform):
            return await self._fetch_check(platform, pincode, clean_query, url, on_step)
        digest = _digest(f"{clean_query.lower()}|{pincode}|{platform}|{url or ''}")
        roll = int(digest[0:6], 16) % 100
        price_units = int(digest[6:12], 16) % 4500
        misc = int(digest[12:18], 16)
        fee_seed = int(digest[18:24], 16)
        failure = FAILURES[int(digest[24:26], 16) % 2] if roll < 5 else None
        quick = platform in QUICK_COMMERCE
        target_url = agent_target_url(url)

        trace = AgentTrace(
            goal=build_check_goal(platform, pincode, clean_query, url),
            mode="simulated",
            on_step=on_step,
        )
        kinds = ["session", "navigate", "location", "open", "extract", "screenshot"]
        if target_url is None:
            kinds.append("search")
        if quick:
            kinds.append("checkout")
        pacer = _Pacer(random.uniform(*self.delay), kinds)

        async def fail(message: str) -> TinyFishError:
            await trace.step("error", message)
            return TinyFishError(
                f"{message} ({platform}/{pincode})",
                retryable=False,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            )

        await trace.step("session", "Starting browser session", trace.session_id)
        await pacer.pause("session")
        domain = site_domain(platform)
        await trace.step("navigate", f"Opening {domain}", f"https://{domain}")
        await pacer.pause("navigate")
        if failure == FAILURES[0]:
            raise await fail(failure)
        await trace.step("location", f"Setting delivery pincode {pincode}")
        await pacer.pause("location")
        if failure == FAILURES[1]:
            raise await fail(failure)
        if target_url is None:
            await trace.step("search", f"Searching “{clean_query}”")
            await pacer.pause("search")
            await trace.step("open", "Opening best match", clean_query)
        else:
            await trace.step("open", "Opening product page", clean_query)
        await pacer.pause("open")

        price = round(15 + price_units / 100, 2)
        mrp = round(price + 3 + misc % 7, 2)
        eta_minutes = 8 + misc % 24 if quick else 1440 + misc % 2880
        in_stock = roll >= 20
        stock_label = "In stock" if in_stock else "Out of stock"
        await trace.step(
            "extract",
            "Reading price, stock and delivery time",
            f"{format_rupees(price)} · MRP {format_rupees(mrp)} · {stock_label} · "
            f"{_eta_label(eta_minutes)}",
        )
        await pacer.pause("extract")
        if quick and in_stock:
            breakdown = compute_true_price(price, fee_seed)
            await trace.step(
                "checkout",
                "Computing true price at checkout",
                f"Item {format_rupees(breakdown['item'])} + handling "
                f"{format_rupees(breakdown['handling_fee'])} + delivery "
                f"{format_rupees(breakdown['delivery_fee'])} − offer "
                f"{format_rupees(breakdown['offer'])} = {format_rupees(breakdown['final'])}",
            )
            await pacer.pause("checkout")
            trace.true_price = breakdown
        await trace.step("screenshot", "Capturing evidence screenshot")
        screenshot = render_product_screenshot(
            platform=platform,
            pincode=pincode,
            query=clean_query,
            title=clean_query,
            price=price,
            mrp=mrp,
            in_stock=in_stock,
            eta_minutes=eta_minutes,
            true_price=trace.true_price,
            session_id=trace.session_id,
            captured_at=utcnow(),
        )
        await pacer.pause("screenshot")
        await trace.step("done", "Check complete", f"{CREDITS_PER_SESSION} credit")
        return CheckResult(
            product=clean_query,
            in_stock=in_stock,
            price=price,
            mrp=mrp,
            eta_minutes=eta_minutes,
            rating=round(3.6 + (misc // 7) % 15 / 10, 1),
            screenshot_bytes=screenshot,
            screenshot_content_type="image/svg+xml",
            credits_used=CREDITS_PER_SESSION,
            raw={
                "simulated": True,
                "platform": platform,
                "pincode": pincode,
                "url": url,
                "agent": trace.as_raw(),
            },
        )

    async def _fetch_check(
        self,
        platform: str,
        pincode: str,
        clean_query: str,
        url: str | None,
        on_step: StepCallback | None,
    ) -> CheckResult:
        """Simulated Fetch API read of a marketplace listing, like live mode:
        listing-wide (the same answer for every pincode) and free of credits."""
        digest = _digest(f"{clean_query.lower()}|{platform}|{url or ''}")
        roll = int(digest[0:6], 16) % 100
        price_units = int(digest[6:12], 16) % 4500
        misc = int(digest[12:18], 16)
        target_url = agent_target_url(url)
        domain = site_domain(platform)
        trace = AgentTrace(
            goal=f"Fetch API: read the {domain} listing for “{clean_query}”",
            mode="simulated",
            on_step=on_step,
        )
        kinds = ["session", "open", "extract", "screenshot"]
        if target_url is None:
            kinds.append("search")
        pacer = _Pacer(random.uniform(*self.delay) / 2, kinds)

        await trace.step("session", "Using TinyFish Fetch API", "no browser, read-only")
        await pacer.pause("session")
        if target_url is None:
            await trace.step("search", f"Finding the {domain} listing", clean_query)
            await pacer.pause("search")
        await trace.step("open", f"Reading {domain} product page", target_url)
        await pacer.pause("open")
        if roll < 5:
            await trace.step("error", "Page blocked automation")
            raise TinyFishError(
                f"{domain} blocked the page fetch (simulated, {platform})",
                retryable=False,
                credits_used=0,
                agent=trace.as_raw(),
            )
        price = round(15 + price_units / 100, 2)
        mrp = round(price + 3 + misc % 7, 2)
        eta_minutes = 1440 + misc % 2880
        in_stock = roll >= 20
        stock_label = "In stock" if in_stock else "Out of stock"
        delivery_text = f"Delivery in {_eta_label(eta_minutes)}"
        await trace.step(
            "extract",
            "Reading price, stock and delivery",
            f"{format_rupees(price)} · MRP {format_rupees(mrp)} · {stock_label} · "
            f"{delivery_text}",
        )
        await pacer.pause("extract")
        await trace.step("screenshot", "Rendering the listing as evidence")
        screenshot = render_product_screenshot(
            platform=platform,
            pincode=pincode,
            query=clean_query,
            title=clean_query,
            price=price,
            mrp=mrp,
            in_stock=in_stock,
            eta_minutes=eta_minutes,
            true_price=None,
            session_id=trace.session_id,
            captured_at=utcnow(),
        )
        await pacer.pause("screenshot")
        await trace.step("done", "Check complete", "Fetch API (listing-wide, not per pincode)")
        return CheckResult(
            product=clean_query,
            in_stock=in_stock,
            price=price,
            mrp=mrp,
            eta_minutes=eta_minutes,
            rating=round(3.6 + (misc // 7) % 15 / 10, 1),
            screenshot_bytes=screenshot,
            screenshot_content_type="image/svg+xml",
            credits_used=0,
            raw={
                "simulated": True,
                "platform": platform,
                "pincode": pincode,
                "pincode_specific": False,
                "url": url,
                "delivery_text": delivery_text,
                "agent": trace.as_raw(),
            },
        )

    async def search(self, query: str) -> list[SearchHit]:
        """Simulated TinyFish Search: one deterministic listing per platform."""
        await asyncio.sleep(random.uniform(*self.delay) / 2)
        clean_query = " ".join(query.split())
        digest = _digest(clean_query.lower())
        hits: list[SearchHit] = []
        for index, platform in enumerate(SEARCH_PLATFORMS):
            window = digest[index * 4 : index * 4 + 4]
            price = round(15 + int(window, 16) % 4500 / 100, 2)
            slug = _digest(f"{clean_query}|{platform}")[:8]
            variant = SEARCH_VARIANTS[int(window, 16) % len(SEARCH_VARIANTS)]
            hits.append(
                SearchHit(
                    name=f"{clean_query} ({variant})",
                    url=f"https://{MOCK_DOMAIN}/{platform}/{slug}",
                    platform=platform,
                    price=price,
                    snippet=f"Simulated TinyFish Search listing on {site_domain(platform)}",
                    raw={"simulated": True},
                )
            )
        return hits

    async def fetch(self, url: str) -> FetchResult:
        await asyncio.sleep(random.uniform(*self.delay) / 2)
        return FetchResult(
            url=url,
            status="ok",
            text=f"Simulated page content for {url}",
            credits_used=1,
            raw={"simulated": True},
        )


class _Pacer:
    """Spreads a session's wall-time budget across its steps with jitter."""

    def __init__(self, budget_seconds: float, kinds: list[str]) -> None:
        total_weight = sum(STEP_WEIGHTS[kind] for kind in kinds)
        self._per_weight = budget_seconds / total_weight if budget_seconds > 0 else 0.0

    async def pause(self, kind: str) -> None:
        if self._per_weight <= 0:
            return
        await asyncio.sleep(
            self._per_weight * STEP_WEIGHTS[kind] * random.uniform(0.8, 1.2)
        )
