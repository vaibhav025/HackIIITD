"""Competitor suggestions: TinyFish Search when it is live, honest demo hints otherwise.

The live path asks TinyFish Search for listings matching the product's query.
Without it (no API key, or Search not available on this account) suggestions
are clearly marked ``source="demo"``: generic "top listing" rivals built from
the product's query with the seller's own brand removed, with no made-up URLs,
so tracking one really checks whatever other brand tops that search.
"""

from __future__ import annotations

import logging
import re

from .tinyfish.base import TinyFishError, get_tinyfish_client, tinyfish_mode

logger = logging.getLogger("shelfsense.competitor_discovery")

DEMO_PLATFORMS = ("blinkit", "zepto", "instamart")
SUGGESTION_LIMIT = 6
_PLATFORM_LABEL = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Instamart",
    "amazon": "Amazon",
    "flipkart": "Flipkart",
}


def _clean(text: str | None) -> str:
    return " ".join((text or "").split())


def generic_query(query: str, brand: str | None) -> str:
    """The product query without the seller's own brand (the rival category)."""
    cleaned = _clean(query)
    if brand and brand.strip():
        stripped = re.sub(re.escape(brand.strip()), " ", cleaned, flags=re.IGNORECASE)
        stripped = _clean(stripped)
        if stripped:
            return stripped
    return cleaned


def demo_suggestions(query: str, brand: str | None = None) -> list[dict[str, str | None]]:
    category = generic_query(query, brand)
    return [
        {
            "name": f"Top “{category}” listing on {_PLATFORM_LABEL[platform]}",
            "platform": platform,
            "search_query": category,
            "url": None,
        }
        for platform in DEMO_PLATFORMS
    ]


async def discover_competitors(
    query: str, brand: str | None = None
) -> tuple[list[dict], str]:
    """Return ``(suggestions, source)`` where source is "tinyfish" or "demo"."""
    if tinyfish_mode() == "live":
        try:
            hits = await get_tinyfish_client().search(generic_query(query, brand))
        except TinyFishError as exc:
            logger.info("TinyFish Search unavailable, using demo suggestions: %s", exc)
        except Exception:  # a flaky search must not break the page
            logger.exception("TinyFish Search failed, using demo suggestions")
        else:
            found = [
                {
                    "name": hit.name,
                    "platform": hit.platform,
                    "url": hit.url,
                    "search_query": hit.name,
                }
                for hit in hits
                if hit.platform
            ]
            if found:
                return found[:SUGGESTION_LIMIT], "tinyfish"
    return demo_suggestions(query, brand), "demo"
