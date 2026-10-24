"""Natural-language goal templates for TinyFish web agents."""

from __future__ import annotations

DOMAINS: dict[str, str] = {
    "blinkit": "blinkit.com",
    "zepto": "zepto.com",
    "instamart": "swiggy.com/instamart",
    "amazon": "amazon.in",
    "flipkart": "flipkart.com",
}
SITES: dict[str, str] = {
    "blinkit": "Blinkit (blinkit.com)",
    "zepto": "Zepto (zepto.com)",
    "instamart": "Swiggy Instamart (instamart.swiggy.com)",
    "amazon": "Amazon.in (amazon.in)",
    "flipkart": "Flipkart (flipkart.com)",
}

CHECK_OUTPUT_SCHEMA = (
    '{"product": string|null, "in_stock": bool|null, "price": number|null, '
    '"mrp": number|null, "eta_minutes": number|null, "rating": number|null}'
)
NULL_RESULT = (
    '{"product": null, "in_stock": null, "price": null, "mrp": null, '
    '"eta_minutes": null, "rating": null}'
)
SEARCH_RESULT_SCHEMA = (
    '{"results": [{"name": string, "url": string, "platform": string, '
    '"price": number|null}]}'
)
FETCH_RESULT_SCHEMA = '{"title": string, "text": string}'


def site_label(platform: str) -> str:
    return SITES.get(platform, platform)


def site_domain(platform: str) -> str:
    return DOMAINS.get(platform, f"{platform}.com")


def agent_target_url(url: str | None) -> str | None:
    """The product URL an agent may open, or None to search by query instead.

    Non-http(s) URLs are internal identity placeholders from the runner; they
    only keep simulated results distinct, so agents never see them.
    """
    return url if url and url.startswith(("http://", "https://")) else None


def build_check_goal(
    platform: str, pincode: str, query: str, url: str | None = None
) -> str:
    site = site_label(platform)
    url = agent_target_url(url)
    if url:
        open_step = f"Open the product page at {url}."
    else:
        open_step = f'Search for "{query}". Open the best matching product.'
    return (
        f"Open {site}. Set the delivery location to pincode {pincode}. {open_step} "
        f"Return ONLY JSON {CHECK_OUTPUT_SCHEMA}. Prices are in rupees as plain "
        f"numbers, never strings. If the product is not found, return {NULL_RESULT}."
    )


def build_search_goal(query: str) -> str:
    return (
        f"Open Blinkit, Zepto, Instamart, Amazon.in and Flipkart. "
        f'Search for "{query}". Return ONLY JSON {SEARCH_RESULT_SCHEMA}. '
        "Include only listings that clearly match the query."
    )


def build_fetch_goal(url: str) -> str:
    return f"Open {url}. Return ONLY JSON {FETCH_RESULT_SCHEMA}."
