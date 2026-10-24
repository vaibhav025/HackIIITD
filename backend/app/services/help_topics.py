"""Static in-app help topics served to the chat sidebar and /help endpoints.

Keep these in step with the code they describe: plan limits in
``services/plans.py``, credit costs in ``services/tinyfish/availability.py``
and the runner, and heatmap rules in ``services/heatmap.py``.
"""

from __future__ import annotations

HELP_TOPICS: list[dict] = [
    {
        "slug": "getting-started",
        "title": "Getting started",
        "body": (
            "Add a product with its name, an optional brand, and the search "
            "query a shopper would type. Then pick the pincodes you sell in "
            "and the apps you compete on: Zepto, Swiggy Instamart, Amazon.in "
            "and Flipkart are checked live; Blinkit blocks automated "
            "browsers, so live mode skips it. Confirm the competitors you "
            "want tracked and press Re-check now. ShelfSense streams every "
            "agent step live, then fills the heatmap, weekly trends, and AI "
            "summary automatically."
        ),
    },
    {
        "slug": "runs",
        "title": "Checks and runs",
        "body": (
            "A run checks your product and each confirmed competitor on "
            "every selected app and pincode. Scheduled runs follow each "
            "product's frequency: Free runs weekly, Pro and Brand as "
            "often as every 3 hours. Zepto and Instamart checks are "
            "TinyFish agent sessions that set the delivery pincode (3-8 "
            "minutes each in live mode); each attempt costs one credit, even "
            "if it fails, and a failed attempt may be retried once. Amazon "
            "and Flipkart pages are read with the Fetch API in seconds, are "
            "the same for every pincode, and cost no credits. Blinkit is not "
            "checked live. A run ends as done, partial (some checks failed) "
            "or failed (none returned data). Watch every step on the Agents "
            "page."
        ),
    },
    {
        "slug": "heatmap",
        "title": "Reading the heatmap",
        "body": (
            "Each pin shows the worst app at that pincode from its freshest "
            "check: out of stock when the shelf is empty, price gap when "
            "your price is 5% or more above the cheapest in-stock rival "
            "checked in the last 24 hours, not checked recently when your "
            "latest check is missing, failed, or older than 24 hours, "
            "otherwise in stock. Apps that live mode never checks (Blinkit "
            "by default) are marked not available in live mode and do not "
            "count against a pin. Hot zones mark clusters of three or more "
            "out-of-stock pins within 3 km. Use the snapshot control to see "
            "the map as it was 6 hours, 24 hours, or 7 days ago."
        ),
    },
    {
        "slug": "weekly",
        "title": "Weekly report",
        "body": (
            "The weekly view compares the last 7 days against the previous 7: "
            "average price, out-of-stock count, rating, and a price-rank "
            "proxy. The changelog lists every detected price, stock, and "
            "rating change. Download the CSV for spreadsheets or finance."
        ),
    },
    {
        "slug": "recommendations",
        "title": "AI summaries and recommendations",
        "body": (
            "After each run ShelfSense writes a short summary and a handful of "
            "recommendations grounded in your check numbers. Approve one to "
            "act on it, dismiss it, or mark it done; every decision stays in "
            "history for your team. With no Gemini key configured a "
            "deterministic rule-based engine produces the same structure "
            "offline."
        ),
    },
    {
        "slug": "credits",
        "title": "Credits and plans",
        "body": (
            "Every TinyFish agent attempt (Zepto, Instamart, Blinkit) costs "
            "one credit, including attempts that fail; Amazon and Flipkart "
            "page reads are free. All credits are recorded in the ledger and "
            "daily budgets reset at midnight UTC. Free: 3 products, 5 "
            "pincodes and 3 competitors per product, weekly checks, 100 "
            "credits a day. Pro: 25 products, 100 pincodes and 10 "
            "competitors per product, checks every 3 hours, 1,000 credits a "
            "day. Brand: unlimited products, pincodes and credits, checks "
            "every 3 hours, and up to 25 competitors per product. A manual "
            "check that "
            "needs more credits than remain today is refused; scheduled "
            "checks pause until the budget resets. Change plans locally from "
            "settings; no payment provider is involved."
        ),
    },
]


def list_help_topics() -> list[dict]:
    return [dict(topic) for topic in HELP_TOPICS]


def get_help_topic(slug: str) -> dict | None:
    for topic in HELP_TOPICS:
        if topic["slug"] == slug:
            return dict(topic)
    return None
