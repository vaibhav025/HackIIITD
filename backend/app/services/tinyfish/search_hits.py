"""Turn TinyFish Search results into competitor listings.

Competitor discovery runs one TinyFish web search per marketplace (restricted to
that site's domain) and keeps only real product pages: search, category and
combo-pack pages are dropped. The title is tidied into a product name and the
first rupee amount in the snippet, when there is one, is taken as the price.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from .base import SearchHit

# Platform -> domain TinyFish Search is restricted to. Instamart lives on swiggy.com.
SEARCH_DOMAINS: dict[str, str] = {
    "blinkit": "blinkit.com",
    "zepto": "zeptonow.com",
    "instamart": "swiggy.com",
    "amazon": "amazon.in",
    "flipkart": "flipkart.com",
}

# Product detail pages only (no search, category or brand pages).
PRODUCT_PAGE_RE: dict[str, re.Pattern[str]] = {
    "blinkit": re.compile(r"blinkit\.com/prn?/.+/prid/\d+"),
    "zepto": re.compile(r"zeptonow\.com/pn/.+/pvid/[0-9a-f-]+"),
    "instamart": re.compile(r"swiggy\.com/instamart/(?:p|item)/"),
    "amazon": re.compile(r"amazon\.in/.*(?:/dp/|/gp/product/)[A-Z0-9]{10}"),
    "flipkart": re.compile(r"flipkart\.com/.+/p/itm[0-9a-z]+"),
}

_PRICE_RE = re.compile(r"(?:₹|Rs\.?|INR)\s?(\d[\d,]*(?:\.\d{1,2})?)", re.IGNORECASE)
# Marketplace boilerplate around the product name in page titles.
_TITLE_NOISE = [
    re.compile(r"^\s*buy\s+", re.IGNORECASE),
    re.compile(r"\s+-\s+buy\s+at\s+.*$", re.IGNORECASE),
    re.compile(r"\s+(?:online|price in india|at best price).*$", re.IGNORECASE),
    re.compile(r"\s*[|:-]\s*(?:amazon|flipkart|blinkit|zepto|swiggy|instamart)\b.*$", re.IGNORECASE),
    re.compile(r"\s+price(?:\s*-\s*buy)?\s*$", re.IGNORECASE),
]
# Gift hampers and multi-product bundles are not like-for-like rivals.
_BUNDLE_RE = re.compile(r"\bcombo\b|\bhamper\b|\bgift\s+(?:box|pack)\b|,.*,", re.IGNORECASE)
# Add-ons sold *for* a product (an AirPods case is not an AirPods rival), unless that's what is sold.
_ACCESSORY_RE = re.compile(
    r"\b(?:case|cover|skin|sticker|screen\s*guard|tempered|nano\s+glass|protector|strap|charger|cable|adapter|stand|holder)\b",
    re.IGNORECASE,
)


def platform_of(url: str) -> str | None:
    host = (urlsplit(url).hostname or "").lower()
    for platform, domain in SEARCH_DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            if platform == "instamart" and "/instamart/" not in url:
                return None
            return platform
    return None


def clean_title(title: str) -> str:
    name = " ".join(title.split())
    for pattern in _TITLE_NOISE:
        name = pattern.sub("", name)
    return name.strip(" -|:")


def snippet_price(snippet: str | None) -> float | None:
    """First rupee amount that isn't the MRP (MRP is the ceiling, not the selling price)."""
    if not snippet:
        return None
    for match in _PRICE_RE.finditer(snippet):
        before = snippet[max(0, match.start() - 4) : match.start()].upper()
        if "MRP" in before:
            continue
        value = float(match.group(1).replace(",", ""))
        if value > 1:  # "Rs.1" placeholders on some listing pages
            return value
    return None


def listings_from_results(platform: str, results: list, query: str = "") -> list[SearchHit]:
    """Product-page hits for one platform, in search-rank order, without duplicates."""
    pattern = PRODUCT_PAGE_RE[platform]
    wants_accessory = bool(_ACCESSORY_RE.search(query))
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for result in results:
        url = str(getattr(result, "url", "") or "")
        if not pattern.search(url) or platform_of(url) != platform:
            continue
        name = clean_title(str(getattr(result, "title", "") or ""))
        if not name or _BUNDLE_RE.search(name):
            continue
        if not wants_accessory and _ACCESSORY_RE.search(name):
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        snippet = str(getattr(result, "snippet", "") or "")
        hits.append(
            SearchHit(
                name=name,
                url=url.split("?")[0],
                platform=platform,
                price=snippet_price(snippet),
                snippet=snippet[:300] or None,
                raw={"source": "tinyfish_search", "title": getattr(result, "title", None)},
            )
        )
    return hits


def interleave(groups: list[list[SearchHit]]) -> list[SearchHit]:
    """Round-robin across platforms so the top of the list covers every marketplace."""
    out: list[SearchHit] = []
    for rank in range(max((len(g) for g in groups), default=0)):
        out.extend(group[rank] for group in groups if rank < len(group))
    return out
