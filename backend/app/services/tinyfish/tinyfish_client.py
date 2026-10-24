"""Live TinyFish client built on the official ``tinyfish`` Python SDK.

This is the only module that talks to TinyFish. It replaces the earlier
guessed HTTP client; every call below follows docs.tinyfish.ai:

* Auth: ``X-API-Key`` header, handled by the SDK. The key comes from
  ``TINYFISH_API_KEY`` via settings and is passed to the SDK explicitly
  (pydantic-settings reads ``.env`` without exporting it to ``os.environ``).
* Browser API: ``AsyncTinyFish.browser.sessions.create(url, timeout_seconds,
  proxy_config)`` returns ``session_id`` / ``cdp_url`` / ``base_url``.
  Playwright attaches with ``connect_over_cdp(cdp_url)``. Creation takes
  10-30 s, the page may still be loading when the call returns, and the SDK
  retries 408/429/5xx/network errors itself. The SDK has no terminate call,
  so sessions end with the documented ``DELETE
  https://api.browser.tinyfish.ai/{session_id}`` (204, idempotent).
* Sessions exit through a US proxy unless told otherwise, so quick-commerce
  checks use an Indian exit (``TINYFISH_PROXY_COUNTRY``, default ``IN``).

``check()`` (the runner's per-job call) drives the app's own location picker:
open the app, type the pincode, pick the first suggestion, search the
product, read the best-matching product card, and take a screenshot. The
per-app selectors in ``FLOWS`` are the part most likely to drift when an app
changes its markup; run ``python -m scripts.check_pincode --debug-dir ...`` to
capture the page at the failing step.

Search (2a), Fetch (2b) and Agent true-price (2d) arrive in later steps.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from urllib.parse import quote_plus

import httpx
from pydantic import BaseModel, Field
from tinyfish import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncTinyFish,
    AuthenticationError,
    BadRequestError,
    BrowserProfile,
    BrowserProxyConfig,
    BrowserSession,
    CompleteEvent,
    ErrorCategory,
    NotFoundError,
    PermissionDeniedError,
    ProgressEvent,
    RateLimitError,
    RunStatus,
    StartedEvent,
)

from ...config import Settings
from .agent import AgentTrace, format_rupees
from .availability import CHECK_STRATEGY
from .base import (
    AgentStepKind,
    CheckResult,
    FetchResult,
    SearchHit,
    StepCallback,
    TinyFishClient,
    TinyFishError,
)
from .goals import agent_target_url, site_domain, site_label
from .marketplace import (
    MARKETPLACES,
    PARSERS,
    PRODUCT_URL_RE,
    fetched_pages,
    listing_urls,
)
from .pack import pack_label, same_variant

if TYPE_CHECKING:
    from playwright.async_api import Locator, Page

logger = logging.getLogger("shelfsense.tinyfish")

QuickCommerceApp = Literal["blinkit", "zepto", "instamart", "amazon", "flipkart"]
QUICK_COMMERCE_APPS: tuple[str, ...] = ("blinkit", "zepto", "instamart")

BROWSER_REST_URL = "https://api.browser.tinyfish.ai"
# Docs: session creation takes 10-30 s; suggested client timeout 60 s.
SESSION_CREATE_TIMEOUT_SECONDS = 60.0
# Inactivity timeout sent to TinyFish, so a session we fail to delete stops
# billing within minutes instead of the plan maximum (15-60 min).
SESSION_IDLE_TIMEOUT_SECONDS = 180
SDK_MAX_RETRIES = 2
# Docs: give the startup navigation a moment after connecting over CDP.
SETTLE_SECONDS = 2.0
STEP_TIMEOUT_MS = 15_000
PROBE_TIMEOUT_MS = 4_000
NAVIGATION_TIMEOUT_MS = 30_000
TERMINATE_ATTEMPTS = 3
# Docs: 409/500/503/504 on DELETE mean termination was not confirmed; retry.
TERMINATE_RETRY_STATUSES = {409, 500, 503, 504}
CREDITS_PER_SESSION = 1
AGENT_REST_URL = "https://agent.tinyfish.ai"
# Docs: Search 1-3 s (suggested timeout 10 s); Fetch up to 110 s per URL (150 s).
SEARCH_TIMEOUT_SECONDS = 15.0
FETCH_TIMEOUT_SECONDS = 150.0
MIN_PAGE_CHARS = 500
FETCH_RETRYABLE_ERRORS = {"timeout", "target_timeout", "service_busy", "internal_error"}

# How each app is checked lives in availability.CHECK_STRATEGY (re-exported here).
LIVE_APPS: tuple[str, ...] = (*QUICK_COMMERCE_APPS, "amazon", "flipkart")
# Agent API output_schema: nullable fields use `nullable`, not type arrays.
AGENT_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "location_set": {"type": "boolean"},
        "product_name": {"type": "string", "nullable": True},
        "in_stock": {"type": "boolean", "nullable": True},
        "price": {"type": "number", "nullable": True},
        "mrp": {"type": "number", "nullable": True},
        "eta_minutes": {"type": "integer", "nullable": True},
        "blocked": {"type": "boolean"},
        "notes": {"type": "string", "nullable": True},
        "exact_match": {"type": "boolean"},
    },
    "required": [
        "location_set", "product_name", "exact_match", "in_stock", "price", "mrp",
        "eta_minutes", "blocked", "notes",
    ],
}
MAX_CARDS = 24
CARD_TEXT_LIMIT = 500


@dataclass(frozen=True)
class AppFlow:
    """Where each step of the location + search flow lives on one app.

    Every tuple is a list of alternative Playwright selectors; the first one
    that becomes visible wins, so a markup change only needs a new entry.
    """

    home_url: str
    search_url: str
    open_picker: tuple[str, ...]
    location_input: tuple[str, ...]
    suggestion: tuple[str, ...]
    confirm: tuple[str, ...] = ()
    product_card: tuple[str, ...] = ()


FLOWS: dict[str, AppFlow] = {
    "blinkit": AppFlow(
        home_url="https://blinkit.com/",
        search_url="https://blinkit.com/s/?q={query}",
        open_picker=(
            "[class*='LocationBar__Container']",
            "[class*='LocationBar']",
            "text=/delivery in/i",
        ),
        location_input=(
            "input[name='select-locality']",
            "input[placeholder*='delivery location' i]",
            "input[placeholder*='location' i]",
        ),
        suggestion=(
            "[class*='LocationSearchList__LocationListContainer']",
            "[class*='LocationSearchList']",
        ),
    ),
    "zepto": AppFlow(
        home_url="https://www.zepto.com/",
        search_url="https://www.zepto.com/search?query={query}",
        open_picker=(
            "[data-testid='user-address']",
            "button[aria-label*='location' i]",
            "text=/select location/i",
        ),
        location_input=(
            "input[placeholder*='search a new address' i]",
            "input[placeholder*='address' i]",
            "input[placeholder*='location' i]",
        ),
        suggestion=(
            "[data-testid='address-search-item']",
            "[data-testid*='address-search']",
        ),
        confirm=(
            "button:has-text('Confirm & Continue')",
            "button:has-text('Confirm')",
        ),
        product_card=("[data-testid='product-card']",),
    ),
    "instamart": AppFlow(
        home_url="https://www.swiggy.com/instamart",
        search_url="https://www.swiggy.com/instamart/search?custom_back=true&query={query}",
        open_picker=(
            "[data-testid='DEFAULT_ADDRESS_CONTAINER']",
            "text=/setup your (precise )?location/i",
            "text=/select location/i",
        ),
        location_input=(
            "input[placeholder*='area' i]",
            "input[placeholder*='location' i]",
            "input#location",
        ),
        suggestion=(
            "[data-testid*='location-search-result']",
            "[data-testid*='search-result']",
        ),
        confirm=(
            "button:has-text('Confirm location')",
            "button:has-text('Confirm')",
        ),
    ),
}

# Text heuristics shared by every app; they read what a shopper reads, which
# survives markup changes better than class names.
AMOUNT_RE = re.compile(r"₹\s?(\d[\d,]*(?:\.\d{1,2})?)(?![\d.,])(?!\s*off)", re.IGNORECASE)
ETA_RE = re.compile(r"(\d{1,3})\s*(?:mins?|minutes)\b", re.IGNORECASE)
OUT_OF_STOCK_RE = re.compile(
    r"out of stock|sold out|notify me|currently unavailable|unavailable", re.IGNORECASE
)
# Letter-only boundaries: cards often render "₹27ADD" with no space.
ADD_RE = re.compile(r"(?<![a-z])add(?![a-z])", re.IGNORECASE)
UNSERVICEABLE_RE = re.compile(
    r"not serviceable|coming soon to your|(?:do not|don't|doesn't) deliver|"
    r"not available (?:at|in) your (?:location|area)|outside our delivery",
    re.IGNORECASE,
)
BLOCKED_RE = re.compile(
    r"access denied|are you a robot|verify you are human|unusual traffic|"
    r"captcha|request blocked|attention required",
    re.IGNORECASE,
)
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_NON_NAME_LINE_RE = re.compile(
    r"₹|^\s*\d+\s*(?:mins?|minutes)\b|^\s*add\s*$|%\s*off|\boff\b|out of stock|"
    r"notify me|sold out",
    re.IGNORECASE,
)

# Collects visible product cards: the smallest element holding a price and an
# ADD / out-of-stock control, widened to its card while the parent still holds
# only one such control. Returns their innerText in document order.
_CARD_TEXTS_JS = """
(maxCards) => {
  const price = /₹\\s?\\d/;
  const action = /(?<![A-Za-z])ADD(?![A-Za-z])|out of stock|sold out|notify me|unavailable/i;
  const actionAll = /(?<![A-Za-z])ADD(?![A-Za-z])|out of stock|sold out|notify me|unavailable/gi;
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const raw = el.textContent || '';
    if (raw.length > 400 || !price.test(raw) || !action.test(raw)) continue;
    let leaf = true;
    for (const child of el.children) {
      const t = child.textContent || '';
      if (price.test(t) && action.test(t)) { leaf = false; break; }
    }
    if (!leaf) continue;
    let card = el;
    while (card.parentElement && card.parentElement !== document.body) {
      const t = card.parentElement.innerText || '';
      if (t.length > 400 || (t.match(actionAll) || []).length > 1) break;
      card = card.parentElement;
    }
    if (seen.has(card)) continue;
    const box = card.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    seen.add(card);
    out.push(card.innerText);
    if (out.length >= maxCards) break;
  }
  return out;
}
"""


class ParsedCard(BaseModel):
    name: str | None = None
    price: float | None = Field(default=None, ge=0)
    mrp: float | None = Field(default=None, ge=0)
    in_stock: bool | None = None
    eta_minutes: int | None = Field(default=None, ge=0)


class AgentCheckOutput(BaseModel):
    """The agent's JSON answer, validated before it reaches the database."""

    location_set: bool = False
    product_name: str | None = None
    in_stock: bool | None = None
    price: float | None = Field(default=None, ge=0)
    mrp: float | None = Field(default=None, ge=0)
    eta_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    blocked: bool = False
    notes: str | None = None
    exact_match: bool | None = None


def build_agent_goal(platform: str, pincode: str, query: str, url: str | None) -> str:
    """Numbered goal with hard guardrails: read-only, no login, no cart."""
    find = (
        f"2. Open the product page at {url}."
        if url
        else f'2. Search for "{query}" and find the product card for exactly this product '
        f"and pack size ({pack_label(query) or 'as named'}). If that exact pack is not listed, "
        "set exact_match=false and report the closest product instead (its full name with "
        "pack size); never present a different pack as the requested one."
    )
    return (
        f"You are checking price and stock on {site_label(platform)} for delivery pincode {pincode}.\n"
        "1. If a location popup appears, or the delivery location is not already this pincode, "
        f"open the location picker, type {pincode} into the address search box and choose the "
        "first suggestion (confirm it if asked). Set location_set=true only once it is set.\n"
        f"{find}\n"
        "3. Read: the product name exactly as shown including its pack size, the selling price in rupees, the MRP if shown struck "
        "through, whether it is in stock (an ADD or + button) or out of stock (Out of stock, "
        "Sold out, Notify me), and the delivery time in minutes shown on the page. Read "
        "these from the search results card; do not open product detail pages, and do not "
        "go looking for a missing MRP (use null).\n"
        "STRICT RULES: this is read-only. Never click ADD, + or any quantity button. Never "
        "add anything to the cart. Never open the cart or checkout. Never log in or enter a "
        "phone number, OTP or payment details (if the session is already signed in, that is "
        "fine; do not change the account). If the site blocks you, shows a captcha or "
        "requires login to continue, stop and set blocked=true.\n"
        "Return only the requested JSON; use null for anything not visible."
    )


def url_slug_words(url: str | None) -> str:
    """Words from a product URL's slug: ".../mi-3i-20000-mah-power-bank/p/itm..." -> "mi 3i 20000 mah power bank"."""
    if not url:
        return ""
    path = url.split("?")[0].split("://")[-1].split("/", 1)[-1]
    slug = path.split("/p/")[0].split("/dp/")[0].rsplit("/", 1)[-1]
    return slug.replace("-", " ")


def not_listed_note(query: str, matched: str | None, price: float | None) -> str:
    wanted = pack_label(query) or "This exact model"
    closest = f"; closest listed: {matched}" if matched else ""
    if matched and price is not None:
        closest += f" at {format_rupees(price)}"
    return f"{wanted} not listed{closest}. Price not reported for a different item."


def _step_kind(purpose: str) -> AgentStepKind:
    text = purpose.lower()
    if re.search(r"pincode|location|address|deliver to", text):
        return "location"
    if "search" in text:
        return "search"
    if re.search(r"extract|read|price|return", text):
        return "extract"
    if re.search(r"navigat|go to|load", text):
        return "navigate"
    return "open"


class PincodeCheck(BaseModel):
    """What ``check_pincode`` returns: one app, one pincode, one product."""

    app: QuickCommerceApp
    pincode: str = Field(pattern=r"^\d{6}$")
    in_stock: bool | None
    price: float | None = Field(default=None, ge=0)
    # Delivery estimate in minutes, matching ``eta`` in the heatmap API.
    eta: int | None = Field(default=None, ge=0)
    screenshot_url: str | None = None
    product: str | None = None
    mrp: float | None = Field(default=None, ge=0)
    mode: Literal["live", "simulated"]


def _amount(value: str) -> float:
    return round(float(value.replace(",", "")), 2)


def parse_card(text: str) -> ParsedCard:
    """Read name, price, MRP, stock and ETA from one product card's text."""
    amounts = [_amount(match) for match in AMOUNT_RE.findall(text)]
    price = amounts[0] if amounts else None
    mrp = max(amounts) if amounts and max(amounts) > amounts[0] else None
    if OUT_OF_STOCK_RE.search(text):
        in_stock: bool | None = False
    elif ADD_RE.search(text):
        in_stock = True
    else:
        in_stock = None
    eta = ETA_RE.search(text)
    name = next(
        (
            line.strip()
            for line in text.splitlines()
            if len(line.strip()) >= 3
            and re.search(r"[a-z]", line, re.IGNORECASE)
            and not _NON_NAME_LINE_RE.search(line)
        ),
        None,
    )
    return ParsedCard(
        name=name,
        price=price,
        mrp=mrp,
        in_stock=in_stock,
        eta_minutes=int(eta.group(1)) if eta else None,
    )


def _tokens(text: str) -> set[str]:
    return {token for token in _TOKEN_RE.findall(text.lower()) if len(token) >= 2}


def pick_card(cards: list[str], query: str) -> tuple[str, int] | None:
    """The first card matching most query words, if at least half of them match."""
    wanted = _tokens(query)
    if not wanted or not cards:
        return None
    best: tuple[str, int] | None = None
    for card in cards:
        score = len(wanted & _tokens(card))
        if best is None or score > best[1]:
            best = (card, score)
    if best is None or best[1] < max(1, math.ceil(len(wanted) / 2)):
        return None
    return best


def map_sdk_error(exc: Exception) -> TinyFishError:
    """Turn an SDK exception into a TinyFishError and log it once, clearly.

    The SDK has already retried 408/429/5xx/network errors by the time one
    reaches us; ``retryable`` tells the runner whether one more job attempt
    could still help.
    """
    status = getattr(exc, "status_code", None)
    code = getattr(exc, "code", None)
    response = getattr(exc, "response", None)
    request_id = response.headers.get("X-Request-ID") if response is not None else None
    context = f"status={status} code={code} request_id={request_id}"

    if isinstance(exc, (AuthenticationError, PermissionDeniedError)):
        logger.error("TinyFish auth failed (%s): check TINYFISH_API_KEY", context)
        return TinyFishError(
            "TinyFish rejected the API key; check TINYFISH_API_KEY", retryable=False
        )
    if isinstance(exc, APIStatusError) and status == 402:
        logger.error("TinyFish wallet is out of credits (%s)", context)
        return TinyFishError("TinyFish wallet has insufficient credits", retryable=False)
    if isinstance(exc, RateLimitError):
        retry_after = response.headers.get("Retry-After") if response is not None else None
        logger.warning("TinyFish rate limit hit (%s retry_after=%s)", context, retry_after)
        return TinyFishError("TinyFish rate limit exceeded", retryable=True)
    if isinstance(exc, NotFoundError):
        logger.error("TinyFish Browser API unavailable for this account (%s)", context)
        return TinyFishError(
            "TinyFish Browser API is not enabled for this account", retryable=False
        )
    if isinstance(exc, BadRequestError):
        logger.error("TinyFish rejected the request (%s): %s", context, exc)
        return TinyFishError(f"TinyFish rejected the request: {exc}", retryable=False)
    if isinstance(exc, APITimeoutError):
        logger.warning("TinyFish request timed out: %s", exc)
        return TinyFishError("TinyFish request timed out", retryable=True)
    if isinstance(exc, APIConnectionError):
        logger.warning("TinyFish connection failed: %s", exc)
        return TinyFishError("Could not reach TinyFish", retryable=True)
    if isinstance(exc, APIStatusError):
        retryable = status is None or status >= 500 or status == 409
        logger.warning("TinyFish API error (%s): %s", context, exc)
        return TinyFishError(f"TinyFish API error (HTTP {status})", retryable=retryable)
    logger.exception("Unexpected TinyFish SDK error")
    return TinyFishError(f"Unexpected TinyFish error: {exc}", retryable=False)


class _FlowError(Exception):
    """A step of the in-browser flow did not go as expected."""

    def __init__(self, step: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.step = step
        self.retryable = retryable


async def _visible(page: Page, selectors: tuple[str, ...], timeout_ms: int) -> Locator | None:
    """The first element matching any selector once visible, else None."""
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    if not selectors:
        return None
    locator = page.locator(selectors[0])
    for selector in selectors[1:]:
        locator = locator.or_(page.locator(selector))
    target = locator.first
    try:
        await target.wait_for(state="visible", timeout=timeout_ms)
    except PlaywrightTimeoutError:
        return None
    return target


async def _page_text(page: Page) -> str:
    try:
        return await page.inner_text("body", timeout=PROBE_TIMEOUT_MS)
    except Exception:  # noqa: BLE001 - a page mid-navigation has no body yet
        return ""


async def _guard_page(page: Page, step: str) -> None:
    text = await _page_text(page)
    if BLOCKED_RE.search(text):
        raise _FlowError(step, "Page blocked automation", retryable=False)
    if UNSERVICEABLE_RE.search(text):
        raise _FlowError(step, "Store unavailable at this pincode", retryable=False)


async def set_delivery_pincode(page: Page, flow: AppFlow, pincode: str) -> None:
    """Open the app's location picker, type the pincode, take the first suggestion."""
    field = await _visible(page, flow.location_input, PROBE_TIMEOUT_MS)
    if field is None:
        picker = await _visible(page, flow.open_picker, STEP_TIMEOUT_MS)
        if picker is None:
            raise _FlowError("location", "Could not find the location picker")
        await picker.click()
        field = await _visible(page, flow.location_input, STEP_TIMEOUT_MS)
        if field is None:
            raise _FlowError("location", "Location search box did not open")
    await field.click()
    await field.fill("")
    # Typed key by key so the app's autocomplete fires as it does for people.
    await field.press_sequentially(pincode, delay=80)
    suggestion = await _visible(page, flow.suggestion, STEP_TIMEOUT_MS)
    if suggestion is None:
        raise _FlowError("location", f"No address suggestion appeared for {pincode}")
    await suggestion.click()
    if flow.confirm:
        confirm = await _visible(page, flow.confirm, PROBE_TIMEOUT_MS)
        if confirm is not None:
            await confirm.click()
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(1.5)
    await _guard_page(page, "location")


async def read_product_cards(page: Page, flow: AppFlow) -> list[str]:
    """Visible product-card texts: app-specific selectors first, else heuristics."""
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    if flow.product_card:
        first = await _visible(page, flow.product_card, STEP_TIMEOUT_MS)
        if first is not None:
            cards = page.locator(", ".join(flow.product_card))
            texts = await cards.all_inner_texts()
            if texts:
                return texts[:MAX_CARDS]
    try:
        await page.get_by_text(re.compile("₹")).first.wait_for(
            state="visible", timeout=STEP_TIMEOUT_MS
        )
    except PlaywrightTimeoutError:
        return []
    return await page.evaluate(_CARD_TEXTS_JS, MAX_CARDS)


class TinyFishLiveClient:
    """Real TinyFish client (``TinyFishClient`` protocol) on the official SDK.

    One ``check()`` = one Browser API session, always terminated afterwards.
    Each check is attempted once; the runner owns the single job-level retry
    so a job is billed at most twice.
    """

    mode = "live"

    def __init__(self, settings: Settings, *, debug_dir: Path | None = None) -> None:
        if not settings.tinyfish_api_key:
            raise TinyFishError("TINYFISH_API_KEY is not set", retryable=False)
        self._api_key = settings.tinyfish_api_key
        self.check_timeout = float(settings.tinyfish_browser_timeout_seconds)
        self.agent_timeout = float(settings.tinyfish_agent_timeout_seconds)
        # Saved, signed-in Browser Context Profiles per app (team accounts only).
        self.profiles = {
            "blinkit": settings.tinyfish_profile_blinkit.strip(),
            "zepto": settings.tinyfish_profile_zepto.strip(),
            "instamart": settings.tinyfish_profile_instamart.strip(),
        }
        self.proxy_country = settings.tinyfish_proxy_country.strip().upper() or None
        self.debug_dir = debug_dir

    def _sdk(self, timeout: float = SESSION_CREATE_TIMEOUT_SECONDS) -> AsyncTinyFish:
        return AsyncTinyFish(
            api_key=self._api_key, timeout=timeout, max_retries=SDK_MAX_RETRIES
        )

    async def check(
        self,
        platform: str,
        pincode: str,
        query: str,
        url: str | None = None,
        on_step: StepCallback | None = None,
    ) -> CheckResult:
        clean_query = " ".join(query.split())
        target_url = agent_target_url(url)
        if CHECK_STRATEGY.get(platform) == "fetch":
            return await self._fetch_check(platform, pincode, clean_query, target_url, on_step)
        flow = FLOWS.get(platform)
        if flow is None:
            raise TinyFishError(
                f"Live checks cover {', '.join(LIVE_APPS)}; {platform} is not supported yet",
                retryable=False,
            )
        if CHECK_STRATEGY.get(platform) == "agent":
            return await self._agent_check(
                platform, flow, pincode, clean_query, target_url, on_step
            )
        trace = AgentTrace(
            goal=(
                f"Browser API: set delivery pincode {pincode} on {platform}, "
                f"then read price, stock and ETA for “{clean_query}”"
            ),
            mode="live",
            on_step=on_step,
        )

        await trace.step("session", "Starting browser session")
        session = await self._create_session(flow.home_url, trace)
        trace.session_id = session.session_id
        try:
            async with asyncio.timeout(self.check_timeout):
                return await self._run_flow(
                    session, flow, platform, pincode, clean_query, target_url, trace
                )
        except TimeoutError as exc:
            await trace.step("error", f"Check timed out after {self.check_timeout:.0f}s")
            logger.warning(
                "browser check timed out app=%s pincode=%s session=%s",
                platform,
                pincode,
                session.session_id,
            )
            raise TinyFishError(
                f"TinyFish browser check timed out ({platform}/{pincode})",
                retryable=False,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            ) from exc
        finally:
            # Shielded so cancelling a run still releases the remote browser.
            await asyncio.shield(self._terminate(session.session_id))

    async def _agent_check(
        self,
        platform: str,
        flow: AppFlow,
        pincode: str,
        query: str,
        target_url: str | None,
        on_step: StepCallback | None,
    ) -> CheckResult:
        """One Agent API run (stealth browser) that sets the pincode and reads the card."""
        goal = build_agent_goal(platform, pincode, query, target_url)
        profile_id = self.profiles.get(platform) or None
        profile_options = {"use_profile": True, "profile_id": profile_id} if profile_id else {}
        trace = AgentTrace(goal=goal, mode="live", on_step=on_step)
        await trace.step("session", "Starting stealth agent session")
        run_id: str | None = None
        complete: CompleteEvent | None = None
        try:
            async with (
                asyncio.timeout(self.agent_timeout),
                self._sdk(timeout=self.agent_timeout) as client,
                client.agent.stream(
                    goal=goal,
                    url=target_url or flow.home_url,
                    browser_profile=BrowserProfile.STEALTH,
                    output_schema=AGENT_OUTPUT_SCHEMA,
                    **profile_options,
                ) as stream,
            ):
                async for event in stream:
                    if isinstance(event, StartedEvent):
                        run_id = event.run_id
                        trace.session_id = event.run_id
                        await trace.step(
                            "navigate", f"Opening {site_domain(platform)}", flow.home_url
                        )
                    elif isinstance(event, ProgressEvent):
                        await trace.step(_step_kind(event.purpose), event.purpose[:140])
                    elif isinstance(event, CompleteEvent):
                        complete = event
        except TimeoutError as exc:
            if run_id:
                await asyncio.shield(self._cancel_run(run_id))
            await trace.step("error", f"Agent timed out after {self.agent_timeout:.0f}s")
            logger.warning("agent check timed out app=%s pincode=%s run=%s", platform, pincode, run_id)
            raise TinyFishError(
                f"TinyFish agent timed out ({platform}/{pincode})",
                retryable=False,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            ) from exc
        except TinyFishError:
            raise
        except Exception as exc:
            error = map_sdk_error(exc)
            await trace.step("error", str(error))
            error.agent = trace.as_raw()
            raise error from exc

        if complete is None or complete.status != RunStatus.COMPLETED:
            run_error = complete.error if complete else None
            message = run_error.message if run_error else "Agent run did not complete"
            category = run_error.category if run_error else ErrorCategory.UNKNOWN
            if category == ErrorCategory.BILLING_FAILURE:
                logger.error("TinyFish billing failure run=%s: %s", run_id, message)
            else:
                logger.warning("agent run failed app=%s run=%s category=%s: %s", platform, run_id, category, message)
            await trace.step("error", message[:200])
            raise TinyFishError(
                f"TinyFish agent failed: {message} ({platform}/{pincode})",
                retryable=category in (ErrorCategory.SYSTEM_FAILURE, ErrorCategory.UNKNOWN),
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            )

        try:
            output = AgentCheckOutput.model_validate(complete.result_json or {})
        except ValueError as exc:
            await trace.step("error", "Agent returned an invalid result")
            raise TinyFishError(
                f"TinyFish agent returned an invalid result ({platform}/{pincode})",
                retryable=False,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            ) from exc
        if output.blocked:
            await trace.step("error", "Page blocked automation")
            logger.warning("agent blocked app=%s pincode=%s run=%s", platform, pincode, run_id)
            raise TinyFishError(
                f"{site_domain(platform)} blocked automation ({platform}/{pincode})",
                retryable=False,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            )
        if not output.location_set:
            await trace.step("error", f"Could not set delivery pincode {pincode}")
            raise TinyFishError(
                f"Could not set delivery pincode ({platform}/{pincode})",
                retryable=True,
                credits_used=CREDITS_PER_SESSION,
                agent=trace.as_raw(),
            )

        exact = output.exact_match is not False and same_variant(query, output.product_name) is not False
        notes = [output.notes] if output.notes else []
        if exact:
            parsed = ParsedCard(
                name=output.product_name,
                price=output.price,
                mrp=output.mrp if output.mrp and output.price and output.mrp > output.price else None,
                in_stock=output.in_stock,
                eta_minutes=output.eta_minutes,
            )
        else:
            # Never report another pack's price as this product's price.
            parsed = ParsedCard(name=output.product_name, in_stock=False, eta_minutes=output.eta_minutes)
            notes.insert(0, not_listed_note(query, output.product_name, output.price))
        await trace.step(
            "extract",
            "Reading price, stock and delivery time",
            _extract_detail(parsed, 1) if exact else notes[0],
        )
        await trace.step("screenshot", "Saving evidence screenshot")
        screenshot = await self._agent_screenshot(run_id) if run_id else None
        await trace.step("done", "Check complete", f"{CREDITS_PER_SESSION} credit")
        return CheckResult(
            product=parsed.name,
            in_stock=parsed.in_stock,
            price=parsed.price,
            mrp=parsed.mrp,
            eta_minutes=parsed.eta_minutes,
            screenshot_bytes=screenshot,
            screenshot_content_type="image/jpeg",
            credits_used=CREDITS_PER_SESSION,
            raw={
                "source": "tinyfish_agent_api",
                "run_id": run_id,
                "platform": platform,
                "pincode": pincode,
                "url": target_url,
                "product": output.product_name,
                "exact_match": exact,
                "closest_price": None if exact else output.price,
                "notes": notes,
                "agent": trace.as_raw(),
            },
        )

    async def _fetch_check(
        self,
        platform: str,
        pincode: str,
        query: str,
        target_url: str | None,
        on_step: StepCallback | None,
    ) -> CheckResult:
        """Read a marketplace product page with the Fetch API (Search finds it if needed)."""
        domain = MARKETPLACES[platform]
        trace = AgentTrace(
            goal=f"Fetch API: read the {domain} listing for “{query}”", mode="live", on_step=on_step
        )
        await trace.step("session", "Using TinyFish Fetch API", "no browser, read-only")
        try:
            url = target_url if target_url and domain in target_url else None
            if url is None:
                await trace.step("search", f"Finding the {domain} listing", query)
                url = await self._find_listing(platform, query)
            await trace.step("open", f"Reading {domain} product page", url)
            page = await self._fetch_page(url)
        except TinyFishError as exc:
            await trace.step("error", str(exc))
            exc.agent = trace.as_raw()
            raise
        except Exception as exc:
            error = map_sdk_error(exc)
            await trace.step("error", str(error))
            error.agent = trace.as_raw()
            raise error from exc

        text = page.get("text") or ""
        # A near-empty page is a bot check, not the product page.
        if len(text) < MIN_PAGE_CHARS or (BLOCKED_RE.search(text[:3000]) and len(text) < 3000):
            await trace.step("error", "Page blocked automation")
            raise TinyFishError(
                f"{domain} blocked the page fetch ({platform})",
                retryable=False,
                agent=trace.as_raw(),
            )
        snapshot = PARSERS[platform](text, page.get("title"))
        if snapshot.price is None and snapshot.in_stock is None:
            await trace.step("error", "No price or availability on the page")
            raise TinyFishError(
                f"Could not read price or availability from {domain} ({platform})",
                retryable=False,
                agent=trace.as_raw(),
            )
        # The product link often carries the model ("mi-3i-20000-mah-...") when the
        # page's display name drops it.
        exact = same_variant(query, f"{snapshot.name or ''} {url_slug_words(url)}".strip() or None) is not False
        if exact:
            parsed = ParsedCard(
                name=snapshot.name,
                price=snapshot.price,
                mrp=snapshot.mrp,
                in_stock=snapshot.in_stock,
                eta_minutes=snapshot.eta_minutes,
            )
        else:
            parsed = ParsedCard(name=snapshot.name, in_stock=False)
            snapshot.notes.insert(0, not_listed_note(query, snapshot.name, snapshot.price))
        detail = _extract_detail(parsed, 1) if exact else snapshot.notes[0]
        if snapshot.delivery_text:
            detail = f"{detail} · {snapshot.delivery_text}"
        await trace.step("extract", "Reading price, stock and delivery", detail)
        await trace.step("done", "Check complete", "Fetch API (listing-wide, not per pincode)")
        return CheckResult(
            product=parsed.name,
            in_stock=parsed.in_stock,
            price=parsed.price,
            mrp=parsed.mrp,
            eta_minutes=parsed.eta_minutes,
            credits_used=0,
            raw={
                "source": "tinyfish_fetch_api",
                "platform": platform,
                "pincode": pincode,
                "pincode_specific": False,
                "url": url,
                "product": snapshot.name,
                "exact_match": exact,
                "closest_price": None if exact else snapshot.price,
                "delivery_text": snapshot.delivery_text,
                "delivery_fee": snapshot.delivery_fee,
                "notes": snapshot.notes,
                "excerpt": text[:CARD_TEXT_LIMIT],
                "agent": trace.as_raw(),
            },
        )

    async def _find_listing(self, platform: str, query: str) -> str:
        key = f"{platform}|{query.lower()}"
        async with listing_urls.lock(key):
            cached = listing_urls.get(key)
            if isinstance(cached, str):
                return cached
            async with self._sdk(timeout=SEARCH_TIMEOUT_SECONDS) as client:
                found = await client.search.query(
                    query, location="IN", language="en", include_domains=MARKETPLACES[platform]
                )
            listings = [hit for hit in found.results if PRODUCT_URL_RE[platform].search(hit.url)]
            # Prefer a listing whose title names the same pack size.
            ranked = sorted(listings, key=lambda hit: same_variant(query, hit.title) is not True)
            if ranked:
                listing_urls.put(key, ranked[0].url)
                return ranked[0].url
        raise TinyFishError(
            f"No {MARKETPLACES[platform]} listing found for “{query}”; add the product link "
            "in the product's listings",
            retryable=False,
        )

    async def _fetch_page(self, url: str) -> dict:
        async with fetched_pages.lock(url):
            cached = fetched_pages.get(url)
            if isinstance(cached, dict):
                return cached
            async with self._sdk(timeout=FETCH_TIMEOUT_SECONDS) as client:
                response = await client.fetch.get_contents(urls=[url], ttl=0)
            if response.errors:
                reason = response.errors[0].error
                raise TinyFishError(
                    f"Fetch failed for {url}: {reason}",
                    retryable=reason in FETCH_RETRYABLE_ERRORS,
                )
            if not response.results:
                raise TinyFishError(f"Fetch returned nothing for {url}", retryable=True)
            page = {"title": response.results[0].title, "text": response.results[0].text}
            fetched_pages.put(url, page)
            return page

    async def _agent_screenshot(self, run_id: str) -> bytes | None:
        """JPEG of the latest run step that has one (docs: GET /v1/runs/{id}/steps/{step}/screenshot)."""
        headers = {"X-API-Key": self._api_key}
        try:
            async with httpx.AsyncClient(base_url=AGENT_REST_URL, timeout=30.0) as client:
                run = await client.get(
                    f"/v1/runs/{run_id}", params={"html": "none"}, headers=headers
                )
                run.raise_for_status()
                steps = [step for step in run.json().get("steps") or [] if step.get("screenshot")]
                for step in reversed(steps[-4:]):
                    shot = await client.get(
                        f"/v1/runs/{run_id}/steps/{step['id']}/screenshot", headers=headers
                    )
                    if shot.status_code == 200 and shot.content:
                        return shot.content
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("could not fetch screenshot for run=%s: %s", run_id, exc)
        return None

    async def _cancel_run(self, run_id: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                await client.post(
                    f"{AGENT_REST_URL}/v1/runs/{run_id}/cancel",
                    headers={"X-API-Key": self._api_key},
                )
        except httpx.HTTPError as exc:
            logger.warning("could not cancel run=%s: %s", run_id, exc)

    async def _create_session(self, url: str, trace: AgentTrace) -> BrowserSession:
        proxy = (
            BrowserProxyConfig(country_code=self.proxy_country)
            if self.proxy_country
            else None
        )
        try:
            async with self._sdk() as client:
                return await client.browser.sessions.create(
                    url=url,
                    timeout_seconds=SESSION_IDLE_TIMEOUT_SECONDS,
                    proxy_config=proxy,
                )
        except Exception as exc:
            error = map_sdk_error(exc)
            await trace.step("error", str(error))
            error.agent = trace.as_raw()
            raise error from exc

    async def _run_flow(
        self,
        session: BrowserSession,
        flow: AppFlow,
        platform: str,
        pincode: str,
        query: str,
        target_url: str | None,
        trace: AgentTrace,
    ) -> CheckResult:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import async_playwright

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(session.cdp_url)
            page = None
            step = "navigate"
            try:
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                page = context.pages[0] if context.pages else await context.new_page()
                page.set_default_timeout(STEP_TIMEOUT_MS)
                await trace.step("navigate", f"Opening {site_domain(platform)}", flow.home_url)
                await asyncio.sleep(SETTLE_SECONDS)
                await page.wait_for_load_state(
                    "domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS
                )
                await _guard_page(page, step)

                step = "location"
                await trace.step("location", f"Setting delivery pincode {pincode}")
                await set_delivery_pincode(page, flow, pincode)

                if target_url:
                    step = "open"
                    await trace.step("open", "Opening product page", target_url)
                    await page.goto(target_url, timeout=NAVIGATION_TIMEOUT_MS)
                else:
                    step = "search"
                    search_url = flow.search_url.format(query=quote_plus(query))
                    await trace.step("search", f"Searching “{query}”", search_url)
                    await page.goto(search_url, timeout=NAVIGATION_TIMEOUT_MS)
                await _guard_page(page, step)

                step = "extract"
                cards = await read_product_cards(page, flow)
                if target_url and cards:
                    # A product page shows one main card; take the first.
                    picked: tuple[str, int] | None = (cards[0], len(_tokens(query)))
                else:
                    picked = pick_card(cards, query)
                parsed = parse_card(picked[0]) if picked else ParsedCard()
                if parsed.eta_minutes is None:
                    header = ETA_RE.search((await _page_text(page))[:2000])
                    if header:
                        parsed.eta_minutes = int(header.group(1))
                await trace.step(
                    "extract",
                    "Reading price, stock and delivery time",
                    _extract_detail(parsed, len(cards)),
                )

                step = "screenshot"
                await trace.step("screenshot", "Capturing evidence screenshot")
                screenshot = await page.screenshot(type="png")
            except _FlowError as exc:
                await self._dump_debug(page, platform, pincode, exc.step)
                await trace.step("error", str(exc))
                logger.warning(
                    "browser flow failed app=%s pincode=%s step=%s session=%s error=%s",
                    platform,
                    pincode,
                    exc.step,
                    session.session_id,
                    exc,
                )
                raise TinyFishError(
                    f"{exc} ({platform}/{pincode})",
                    retryable=exc.retryable,
                    credits_used=CREDITS_PER_SESSION,
                    agent=trace.as_raw(),
                ) from exc
            except PlaywrightError as exc:
                await self._dump_debug(page, platform, pincode, step)
                await trace.step("error", f"Browser error during {step}")
                logger.warning(
                    "browser error app=%s pincode=%s step=%s session=%s error=%s",
                    platform,
                    pincode,
                    step,
                    session.session_id,
                    exc,
                )
                raise TinyFishError(
                    f"Browser error during {step} ({platform}/{pincode})",
                    retryable=True,
                    credits_used=CREDITS_PER_SESSION,
                    agent=trace.as_raw(),
                ) from exc
            finally:
                await browser.close()

        await trace.step("done", "Check complete", f"{CREDITS_PER_SESSION} credit")
        return CheckResult(
            product=parsed.name,
            in_stock=parsed.in_stock,
            price=parsed.price,
            mrp=parsed.mrp,
            eta_minutes=parsed.eta_minutes,
            screenshot_bytes=screenshot,
            screenshot_content_type="image/png",
            credits_used=CREDITS_PER_SESSION,
            raw={
                "source": "tinyfish_browser_api",
                "session_id": session.session_id,
                "platform": platform,
                "pincode": pincode,
                "url": target_url,
                "cards_seen": len(cards),
                "matched_card": picked[0][:CARD_TEXT_LIMIT] if picked else None,
                "agent": trace.as_raw(),
            },
        )

    async def _terminate(self, session_id: str) -> None:
        url = f"{BROWSER_REST_URL}/{session_id}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            for attempt in range(1, TERMINATE_ATTEMPTS + 1):
                try:
                    response = await client.delete(url, headers={"X-API-Key": self._api_key})
                except httpx.HTTPError as exc:
                    logger.warning(
                        "terminate session=%s attempt=%d failed: %s", session_id, attempt, exc
                    )
                else:
                    if response.status_code in (204, 404):
                        return
                    if response.status_code not in TERMINATE_RETRY_STATUSES:
                        logger.warning(
                            "terminate session=%s returned HTTP %s",
                            session_id,
                            response.status_code,
                        )
                        return
                    logger.warning(
                        "terminate session=%s attempt=%d returned HTTP %s",
                        session_id,
                        attempt,
                        response.status_code,
                    )
                await asyncio.sleep(attempt)
        logger.error(
            "could not confirm termination of session=%s; it ends after %ss idle",
            session_id,
            SESSION_IDLE_TIMEOUT_SECONDS,
        )

    async def _dump_debug(self, page: Page | None, platform: str, pincode: str, step: str) -> None:
        if self.debug_dir is None or page is None:
            return
        try:
            self.debug_dir.mkdir(parents=True, exist_ok=True)
            stem = self.debug_dir / f"{platform}_{pincode}_{step}"
            await page.screenshot(path=f"{stem}.png", full_page=True)
            stem.with_suffix(".html").write_text(await page.content(), encoding="utf-8")
            logger.info("saved debug capture %s.png/.html", stem)
        except Exception:  # noqa: BLE001 - debugging must never mask the real error
            logger.warning("could not save debug capture for %s/%s", platform, pincode)

    async def search(self, query: str) -> list[SearchHit]:
        raise TinyFishError(
            "TinyFish Search is not wired up yet (step 2a)", retryable=False
        )

    async def fetch(self, url: str) -> FetchResult:
        raise TinyFishError(
            "TinyFish Fetch is not wired up yet (step 2b)", retryable=False
        )


def _extract_detail(parsed: ParsedCard, cards_seen: int) -> str:
    if parsed.price is None and parsed.in_stock is None:
        return f"No matching product among {cards_seen} listings"
    parts: list[str] = []
    if parsed.price is not None:
        parts.append(format_rupees(parsed.price))
    if parsed.mrp is not None:
        parts.append(f"MRP {format_rupees(parsed.mrp)}")
    if parsed.in_stock is not None:
        parts.append("In stock" if parsed.in_stock else "Out of stock")
    if parsed.eta_minutes is not None:
        parts.append(f"{parsed.eta_minutes} min")
    return " · ".join(parts)


async def check_pincode(
    app: str,
    pincode: str,
    product: str,
    *,
    url: str | None = None,
    on_step: StepCallback | None = None,
    client: TinyFishClient | None = None,
) -> dict:
    """Check one product on one quick-commerce app at one pincode.

    Returns ``PincodeCheck`` JSON: ``{app, pincode, in_stock, price, eta,
    screenshot_url, product, mrp, mode}``, with ``eta`` in minutes. Uses the
    live Browser API when TINYFISH_API_KEY is set, otherwise the simulator.
    Raises ``ValueError`` for bad input and ``TinyFishError`` when the check fails.
    """
    from ..storage import save_screenshot
    from .base import get_tinyfish_client

    if app not in LIVE_APPS:
        raise ValueError(f"app must be one of {', '.join(LIVE_APPS)}")
    if not re.fullmatch(r"\d{6}", pincode):
        raise ValueError("pincode must be 6 digits")
    if not product.strip():
        raise ValueError("product must not be empty")

    client = client or get_tinyfish_client()
    result = await client.check(app, pincode, product, url=url, on_step=on_step)
    screenshot_url = result.screenshot_url
    if result.screenshot_bytes:
        screenshot_url = await save_screenshot(
            result.screenshot_bytes,
            product_id="adhoc",
            platform=app,
            pincode=pincode,
            content_type=result.screenshot_content_type,
        )
    return PincodeCheck(
        app=app,
        pincode=pincode,
        in_stock=result.in_stock,
        price=result.price,
        eta=result.eta_minutes,
        screenshot_url=screenshot_url,
        product=result.product,
        mrp=result.mrp,
        mode=client.mode,
    ).model_dump()
