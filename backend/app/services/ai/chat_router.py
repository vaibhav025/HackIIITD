"""Rule-based chat assistant used when Gemini is not configured or fails.

The router classifies a message into how-to topics (answered from the in-app
help catalogue plus links to the real screens) and data questions (answered
only from the numbers in the chat context). Anything else is politely
declined. Matching uses whole words and phrases, so generic words such as
"today" or "what is" never turn an off-topic question into a data answer.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from .base import ChatAction, ChatEvidence, ChatOut

PLATFORM_LABELS = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Instamart",
    "amazon": "Amazon",
    "flipkart": "Flipkart",
}
_PLATFORM_ALIASES = {"swiggy": "instamart", "swiggy instamart": "instamart"}
_CHANGE_LABELS = {
    "price_rise": "price rose",
    "price_drop": "price dropped",
    "went_oos": "went out of stock",
    "back_in_stock": "came back in stock",
    "rating_change": "rating changed",
}


def _re(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


# Phrasing that asks how something works rather than for a number.
_HOW_TO = _re(
    r"\b(how (do|can|could|should|would|does|will) (i|we|you|it|this|shelfsense)"
    r"|how to|where (do|can|is|are|should)|what (is|are|does) (a |an |the )?"
    r"|what's|explain|tell me (more )?about|guide me|steps? to|set ?up|setup"
    r"|walk me through|is there a way|help (me )?with|can i|can you)\b"
)
_GREETING = _re(r"^\s*(hi+|hello|hey|hlo|namaste|good (morning|afternoon|evening)|thanks|thank you)\b[\s!.?]*$")
_PLATFORM = _re(r"\b(blinkit|zepto|swiggy instamart|instamart|swiggy|amazon|flipkart)\b")

# How-to topics: (key, pattern). Order is priority when several match.
_TOPICS: list[tuple[str, re.Pattern[str]]] = [
    ("telegram", _re(r"\b(telegram|bot|tg)\b")),
    ("add_product", _re(
        r"\b(add|create|track|monitor|new|set up|list)\b(\s+\w+){0,3}\s+products?\b"
        r"|\bproducts?\b\s+(to )?(add|create)\b"
    )),
    ("pincodes", _re(
        r"\b(add|change|edit|select|choose|pick|remove|manage|update|set)\b(\s+\w+){0,3}\s+"
        r"(pin ?codes?|pins|locations?|areas?|platforms?)\b"
    )),
    ("alerts", _re(r"\b(alerts?|notif\w*|notify|alarm\w*)\b")),
    ("plans", _re(r"\b(plans?|upgrade|downgrade|subscription|billing|pro|brand plan)\b")),
    ("credits", _re(r"\b(credits?|quota|ledger)\b")),
    ("recommendations", _re(
        r"\b(approv\w*|recommend\w*|suggestions?|dismiss\w*|accept\w*|declin\w*|summar(y|ies))\b"
    )),
    ("heatmap", _re(r"\b(heat ?maps?|hot ?zones?|map)\b")),
    ("runs", _re(r"\b(runs?|checks?|scans?|schedul\w*|refresh\w*|agents?)\b")),
    ("weekly", _re(r"\b(weekly|week|report|csv|export|changelog)\b")),
    ("getting_started", _re(
        r"\b(get(ting)? started|onboard\w*|begin|first steps?|shelfsense|this app|use the app)\b"
    )),
]

# Data questions about the seller's own numbers.
_CREDITS_LEFT = _re(
    r"\b(credits?|checks?|runs?)\b.{0,30}\b(left|remaining|remain|available|have|used|spent)\b"
    r"|\b(left|remaining|quota|budget|usage)\b"
)
_PRICE = _re(
    r"\b(prices?|priced|pricing|cheap\w*|expensive|costl\w*|costs?|rivals?|competitors?"
    r"|competition|undercut\w*|checkout|true price|mrp|gap|beat|beating)\b"
)
_CHECKOUT = _re(r"\b(checkout|check out|true price|final price|fees?|delivery fee|landed)\b")
_STOCK = _re(
    r"\b(stock\w*|oos|out[\s-]of[\s-]stock|availab\w*|unavailable|sold out|shelf|shelves"
    r"|missing|stockouts?)\b"
)
_CHEAPEST_PLATFORM = _re(
    r"\b(cheapest|lowest|best|most expensive|highest)\b.{0,25}\b(platform|app|marketplace|channel|site)s?\b"
    r"|\bwhich (platform|app|marketplace|channel)s?\b"
)
_CHANGES = _re(
    r"\b(chang\w*|moved?|movements?|what happened|went|dropp?ed|drops?|rose|rises?|risen"
    r"|increas\w*|decreas\w*|latest|recent\w*|new since|lately)\b"
)
_PRIORITY = _re(
    r"\b(should i|do first|priorit\w*|next steps?|to-?do|focus|what to do|action items?|urgent"
    r"|pending|attention|fix first)\b"
)
_APPROVED = _re(r"\b(approved|accepted|actions? (i|we) (took|approved|accepted)|decided)\b")
_RATING = _re(r"\b(ratings?|reviews?|stars?)\b")
_WEEKLY = _re(r"\b(weekly|this week|last week|week over week|trend\w*|compare\w*)\b")
_OVERVIEW = _re(
    r"\b(how am i doing|how are (my )?products doing|how is (my )?\w+ doing|overview|status"
    r"|summari[sz]e|health|performance|snapshot|update me|catch me up)\b"
)


def _money(value: float | None) -> str:
    return "n/a" if value is None else f"₹{value:.2f}"


def _pct(a: float, b: float) -> float:
    return round(abs(a / b - 1) * 100, 1) if b else 0.0


def _platform_label(platform: str) -> str:
    return PLATFORM_LABELS.get(platform, platform.title())


def _platforms_named(text: str) -> set[str]:
    named = set()
    for match in _PLATFORM.findall(text):
        key = match.lower()
        named.add(_PLATFORM_ALIASES.get(key, key))
    return named


class _Answer:
    """Accumulates reply paragraphs, evidence and de-duplicated actions."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.evidence: list[ChatEvidence] = []
        self.actions: list[ChatAction] = []

    def say(self, text: str) -> None:
        if text and text not in self.parts:
            self.parts.append(text)

    def cite(self, metric: str, value: float | str | None) -> None:
        if value is not None and not any(item.metric == metric for item in self.evidence):
            self.evidence.append(ChatEvidence(metric=metric[:60], value=value))

    def link(self, label: str, path: str) -> None:
        if not any(action.path == path for action in self.actions):
            self.actions.append(ChatAction(label=label, path=path))

    def out(self) -> ChatOut:
        return ChatOut(
            reply="\n\n".join(self.parts), evidence=self.evidence, actions=self.actions[:4]
        )


class _Ctx:
    """Typed accessors over the chat context dict."""

    def __init__(self, context: dict) -> None:
        self.raw = context
        portfolio = context.get("portfolio") or []
        self.portfolio: list[dict] = portfolio if len(portfolio) > 1 else []
        self.product_id: str | None = context.get("product_id")
        # With a portfolio the top-level numbers belong to its first (worst) product.
        self.name: str = (
            self.portfolio[0]["product_name"]
            if self.portfolio
            else context.get("product_name") or "your product"
        )
        self.has_product = bool(self.product_id)

    def get(self, key: str, default=None):
        value = self.raw.get(key)
        return default if value is None else value

    @property
    def has_checks(self) -> bool:
        return bool(self.get("total_pins", 0)) or bool(self.raw.get("platform_prices"))

    def product_link(self, answer: _Answer, suffix: str = "", label: str = "Open product") -> None:
        if self.product_id:
            answer.link(label, f"/products/{self.product_id}{suffix}")


# ---------------------------------------------------------------- how-to topics


def _topic_body(slug: str) -> str:
    from ..help_topics import get_help_topic  # the static help catalogue

    topic = get_help_topic(slug)
    return topic["body"] if topic else ""


def _howto_telegram(ctx: _Ctx, answer: _Answer) -> None:
    body = _topic_body("telegram")
    answer.say(
        body
        or (
            "To get alerts on Telegram: open a product's Telegram page, choose a "
            "personal chat or a group, tap \"Get a code\", and send /start <code> "
            "to the ShelfSense bot before the code expires. Then choose which "
            "alerts to receive (stock-outs, price moves, rival stock-outs, new "
            "recommendations, morning briefing) and send a test alert. Once "
            "linked you can also ask the bot questions with /ask."
        )
    )
    answer.say("Settings → Telegram lists every connected chat and lets you disconnect one.")
    if ctx.product_id:
        answer.link("Connect Telegram", f"/products/{ctx.product_id}/telegram")
    elif not ctx.get("product_count", 0):
        answer.say("Telegram links are per product, so add a product first.")
        answer.link("Add a product", "/products")
    answer.link("Telegram settings", "/settings#telegram")


def _howto_add_product(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(
        "Go to Products → \"Add product\". Enter the product name and the search "
        "query shoppers would type (brand optional), pick the platforms and "
        "delivery pincodes you sell in, and confirm the rival products to compare "
        "against. Then launch the first check; results stream in live and fill "
        "the heatmap, weekly trends and recommendations."
    )
    count = ctx.get("product_count", 0)
    limit = ctx.raw.get("product_limit")
    plan = str(ctx.get("plan", "free")).title()
    if limit is not None:
        answer.say(f"You track {count} of {limit} products allowed on the {plan} plan.")
        answer.cite("product_count", count)
        if count >= limit:
            answer.link("Upgrade plan", "/settings#plan")
    answer.link("Add a product", "/products")


def _howto_pincodes(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(
        "Pincodes and platforms are set per product: open the product's Settings "
        "→ \"Pincodes & platforms\", select the delivery pincodes and the "
        "platforms (Zepto, Instamart, Amazon, Flipkart), and save. The next check "
        "covers exactly that selection."
    )
    limit = ctx.raw.get("pincode_limit")
    if limit is not None:
        answer.say(
            f"Your {str(ctx.get('plan', 'free')).title()} plan allows up to {limit} pincodes per product."
        )
    if ctx.product_id:
        answer.link("Edit pincodes", f"/products/{ctx.product_id}/settings#pincodes")
    else:
        answer.link("Choose a product", "/products")


def _howto_alerts(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(
        "Alert rules live in each product's Settings → \"Alert rules\": you out of "
        "stock anywhere or in named areas, a rival out of stock, price change by "
        "X%, price gap versus rivals, or rating below a threshold. You can also "
        "type a rule in plain English and ShelfSense turns it into a rule. Alerts "
        "show in the notification bell and, when Telegram is linked, in your chat."
    )
    if ctx.product_id:
        answer.link("Alert rules", f"/products/{ctx.product_id}/settings#rules")
        answer.link("Connect Telegram", f"/products/{ctx.product_id}/telegram")
    else:
        answer.link("Choose a product", "/products")
        answer.link("Telegram settings", "/settings#telegram")


def _howto_plans(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("credits"))
    _credits_data(ctx, answer)
    answer.link("Plans & billing", "/settings#plan")


def _howto_recommendations(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("recommendations"))
    answer.say(
        "Open a product to see its recommendation cards and tap Approve or "
        "Dismiss. Approving records your decision (and can notify your Telegram "
        "chat); ShelfSense never changes your listings or prices by itself. "
        "Price moves are kept within the floor, margin and max-change guardrails "
        "in product Settings."
    )
    pending = ctx.get("pending_count", 0)
    approved = ctx.get("approved_count", 0)
    answer.say(f"Right now you have {pending} pending and {approved} approved recommendation(s).")
    answer.cite("pending_recommendations", pending)
    _recommendation_link(ctx, answer)


def _howto_heatmap(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("heatmap"))
    if ctx.has_checks:
        _heatmap_line(ctx, answer)
    answer.link("Open heatmap", f"/heatmap?product={ctx.product_id}" if ctx.product_id else "/heatmap")


def _howto_runs(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("runs"))
    answer.say(
        "Start one from a product page with \"Run check\"; scheduled checks follow "
        "the product's check frequency in Settings."
    )
    ctx.product_link(answer, label="Run a check")
    answer.link("Watch agents", "/agents")


def _howto_weekly(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("weekly"))
    if ctx.has_checks:
        _weekly_data(ctx, answer)
    ctx.product_link(answer, label="Open weekly report")


def _howto_getting_started(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(_topic_body("getting-started"))
    if not ctx.get("product_count", 0):
        answer.link("Add your first product", "/products")
    else:
        answer.link("Open dashboard", "/dashboard")


_HOWTO: dict[str, Callable[[_Ctx, _Answer], None]] = {
    "telegram": _howto_telegram,
    "add_product": _howto_add_product,
    "pincodes": _howto_pincodes,
    "alerts": _howto_alerts,
    "plans": _howto_plans,
    "credits": _howto_plans,
    "recommendations": _howto_recommendations,
    "heatmap": _howto_heatmap,
    "runs": _howto_runs,
    "weekly": _howto_weekly,
    "getting_started": _howto_getting_started,
}
# Topics that are always guidance, even without "how do I" phrasing.
_ALWAYS_HOWTO = {"telegram", "add_product", "pincodes", "alerts", "plans", "getting_started"}


# ---------------------------------------------------------------- data answers


def _no_data(ctx: _Ctx, answer: _Answer) -> None:
    if not ctx.get("product_count", 1):
        answer.say(
            "You haven't added a product yet, so there is no shelf data to read. "
            "Add one and run its first check."
        )
        answer.link("Add a product", "/products")
    else:
        answer.say(
            f"There is no check data for {ctx.name} yet. Run a check and I can "
            "answer with real prices and stock."
        )
        ctx.product_link(answer, label="Run a check")


def _platform_rows(rows: list[dict], wanted: set[str]) -> list[dict]:
    return [row for row in rows if not wanted or row["platform"] in wanted]


def _platform_price_line(row: dict, checkout_first: bool) -> tuple[str, int]:
    """One platform's comparison and -1/0/1 for cheaper/equal/dearer (checkout when measured)."""
    label = _platform_label(row["platform"])
    mine, rival = row.get("my_price"), row.get("rival_price")
    mine_out, rival_out = row.get("my_checkout"), row.get("rival_checkout")
    rival_name = row.get("rival_name") or "the cheapest rival"
    if mine is None and rival is None:
        return f"• {label}: no in-stock prices on the latest check.", 0
    if mine is None:
        return (
            f"• {label}: you were not in stock anywhere checked; {rival_name} sells at {_money(rival)}.",
            0,
        )
    if rival is None:
        return f"• {label}: you {_money(mine)}; no in-stock rival to compare.", 0
    use_checkout = mine_out is not None and rival_out is not None
    a, b = (mine_out, rival_out) if use_checkout else (mine, rival)
    basis = "at checkout" if use_checkout else "on the shelf"
    if abs(a - b) < 0.005:
        verdict, sign = f"level with {rival_name} {basis}", 0
    elif a < b:
        verdict, sign = f"{_money(b - a)} ({_pct(a, b)}%) cheaper than {rival_name} {basis}", -1
    else:
        verdict, sign = f"{_money(a - b)} ({_pct(a, b)}%) dearer than {rival_name} {basis}", 1
    if use_checkout:
        prices = (
            f"you {_money(mine)} shelf / {_money(mine_out)} checkout vs "
            f"{_money(rival)} / {_money(rival_out)}"
        )
    else:
        prices = f"you {_money(mine)} vs {_money(rival)}"
        if checkout_first:
            prices += " (checkout total not measured on this platform)"
    return f"• {label}: {prices} — {verdict}.", sign


def _price_block(
    name: str, rows: list[dict], wanted: set[str], checkout_first: bool, answer: _Answer
) -> bool:
    shown = _platform_rows(rows, wanted)
    if not shown:
        return False
    lines: list[str] = []
    tally = {-1: 0, 0: 0, 1: 0}
    compared = 0
    for row in shown:
        line, sign = _platform_price_line(row, checkout_first)
        lines.append(line)
        if row.get("my_price") is not None and row.get("rival_price") is not None:
            compared += 1
            tally[sign] += 1
        for field in ("my_price", "my_checkout", "rival_price", "rival_checkout"):
            answer.cite(f"{row['platform']}_{field}:{name}", row.get(field))
    if compared:

        def share(count: int) -> str:
            if count == compared:
                return "every platform compared" if compared > 1 else "the one platform compared"
            return f"{count} of {compared} platforms"

        if tally[1] == 0 and tally[-1]:
            bottom = f"you are cheaper on {share(tally[-1])}"
        elif tally[-1] == 0 and tally[1]:
            bottom = f"you are dearer than the cheapest rival on {share(tally[1])}"
        else:
            bottom = (
                f"cheaper on {tally[-1]}, dearer on {tally[1]}"
                + (f", level on {tally[0]}" if tally[0] else "")
                + f" of {compared} platform(s)"
            )
        lines.append(f"Bottom line: {bottom}.")
    answer.say(f"{name} vs rivals, by platform (latest checks):\n" + "\n".join(lines))
    return True


def _price_data(ctx: _Ctx, answer: _Answer, text: str) -> None:
    wanted = _platforms_named(text)
    checkout_first = bool(_CHECKOUT.search(text))
    if ctx.portfolio:
        shown = False
        for item in ctx.portfolio:
            shown |= _price_block(
                item["product_name"], item.get("platform_prices") or [], wanted, checkout_first, answer
            )
        if shown:
            if checkout_first:
                answer.say(
                    "Checkout totals (item + handling + delivery − offers) are measured "
                    "by TinyFish agent checks on Zepto and Instamart; Amazon and Flipkart "
                    "compare shelf prices."
                )
            answer.cite("avg_price", ctx.raw.get("avg_price"))
            for item in ctx.portfolio[:2]:
                answer.link(f"Open {item['product_name'][:30]}", f"/products/{item['product_id']}")
            return
    elif _price_block(ctx.name, ctx.raw.get("platform_prices") or [], wanted, checkout_first, answer):
        if checkout_first and not any(
            row.get("my_checkout") is not None for row in ctx.raw.get("platform_prices") or []
        ):
            answer.say(
                "No checkout totals were measured on these platforms, so this compares "
                "shelf prices. Zepto and Instamart agent checks capture the true price "
                "at checkout."
            )
        answer.cite("avg_price", ctx.raw.get("avg_price"))
        answer.cite("cheapest_rival", ctx.raw.get("cheapest_rival"))
        ctx.product_link(answer, label="Compare rivals")
        ctx.product_link(answer, "/settings#guardrails", label="Price guardrails")
        return
    # No per-platform rows (e.g. Telegram /ask): headline numbers only.
    avg_price, rival = ctx.raw.get("avg_price"), ctx.raw.get("cheapest_rival")
    if avg_price is None and rival is None:
        if wanted:
            answer.say(f"No price data for {ctx.name} on {', '.join(map(_platform_label, sorted(wanted)))} yet.")
        else:
            _no_data(ctx, answer)
        return
    line = f"{ctx.name} averages {_money(avg_price)}; the cheapest rival is {_money(rival)}."
    if avg_price is not None and rival:
        gap = round((avg_price / rival - 1) * 100, 1)
        line += (
            f" You are {gap}% above the cheapest rival."
            if gap > 0
            else f" You are {abs(gap)}% below the cheapest rival."
            if gap < 0
            else " You match the cheapest rival."
        )
    answer.say(line)
    answer.cite("avg_price", avg_price)
    answer.cite("cheapest_rival", rival)


def _stock_line(name: str, in_stock: int, total: int, oos: list[str]) -> str:
    where = f"out of stock in {', '.join(oos[:8])}" + (f" (+{len(oos) - 8} more)" if len(oos) > 8 else "") if oos else "no stock-outs"
    return f"{name}: {in_stock} of {total} pins in stock; {where}."


def _stock_data(ctx: _Ctx, answer: _Answer, text: str) -> None:
    wanted = _platforms_named(text)
    if ctx.portfolio:
        lines = []
        for item in ctx.portfolio:
            rows = _platform_rows(item.get("platform_prices") or [], wanted)
            if wanted and rows:
                oos = sorted({pin for row in rows for pin in row["oos_pins"]})
                lines.append("• " + _stock_line(
                    item["product_name"],
                    sum(row["pins_in_stock"] for row in rows),
                    sum(row["pins_checked"] for row in rows),
                    oos,
                ))
            else:
                lines.append("• " + _stock_line(
                    item["product_name"], item.get("in_stock") or 0, item.get("total_pins") or 0, item.get("oos_pins") or []
                ))
            answer.cite(f"in_stock:{item['product_name']}", item.get("in_stock"))
        answer.say(f"Across your {len(ctx.portfolio)} products:\n" + "\n".join(lines))
        worst = max(ctx.portfolio, key=lambda item: len(item.get("oos_pins") or []))
        if worst.get("oos_pins"):
            answer.link(f"Open {worst['product_name'][:30]} heatmap", f"/heatmap?product={worst['product_id']}")
        return
    if not ctx.has_checks:
        _no_data(ctx, answer)
        return
    rows = _platform_rows(ctx.raw.get("platform_prices") or [], wanted)
    oos_pins: list[str] = ctx.get("oos_pins", [])
    answer.say(_stock_line(ctx.name, ctx.get("in_stock", 0), ctx.get("total_pins", 0), oos_pins))
    by_platform = [
        f"• {_platform_label(row['platform'])}: {row['pins_in_stock']}/{row['pins_checked']} in stock"
        + (f", out in {', '.join(row['oos_pins'][:8])}" if row["oos_pins"] else "")
        for row in rows
    ]
    if by_platform and (wanted or oos_pins):
        answer.say("By platform:\n" + "\n".join(by_platform))
    answer.cite("in_stock", ctx.get("in_stock"))
    answer.cite("oos_pins", len(oos_pins))
    if ctx.product_id:
        answer.link("Open heatmap", f"/heatmap?product={ctx.product_id}")


def _cheapest_platform(ctx: _Ctx, answer: _Answer) -> None:
    items = ctx.portfolio or [
        {"product_id": ctx.product_id, "product_name": ctx.name, "platform_prices": ctx.raw.get("platform_prices") or []}
    ]
    said = False
    for item in items:
        rows = [row for row in item.get("platform_prices") or [] if row.get("my_price") is not None]
        if not rows:
            continue
        key = (lambda row: row["my_checkout"]) if all(row.get("my_checkout") is not None for row in rows) else (lambda row: row["my_price"])
        basis = "checkout total" if all(row.get("my_checkout") is not None for row in rows) else "shelf price"
        low, high = min(rows, key=key), max(rows, key=key)
        line = f"{item['product_name']}: your lowest {basis} is on {_platform_label(low['platform'])} ({_money(key(low))})"
        if high is not low:
            line += f", highest on {_platform_label(high['platform'])} ({_money(key(high))})"
        rivals = [row for row in item.get("platform_prices") or [] if row.get("rival_price") is not None]
        if rivals:
            best = min(rivals, key=lambda row: row["rival_price"])
            line += f". The cheapest rival offer is on {_platform_label(best['platform'])} ({best.get('rival_name') or 'rival'} at {_money(best['rival_price'])})"
        answer.say(line + ".")
        answer.cite(f"{low['platform']}_lowest:{item['product_name']}", key(low))
        if item.get("product_id"):
            answer.link(f"Open {item['product_name'][:30]}", f"/products/{item['product_id']}")
        said = True
    if not said:
        _no_data(ctx, answer)


def _changes_data(ctx: _Ctx, answer: _Answer) -> None:
    changes = ctx.raw.get("recent_changes") or []
    if not changes:
        if ctx.has_checks:
            answer.say(
                f"No price, stock or rating changes detected for {ctx.name} yet. "
                "Changes are found by comparing consecutive checks, so they appear after the next run."
            )
            ctx.product_link(answer, label="Run a check")
        else:
            _no_data(ctx, answer)
        return
    lines = []
    for change in changes[:6]:
        what = _CHANGE_LABELS.get(change.get("kind"), str(change.get("kind")))
        old, new = change.get("old_value"), change.get("new_value")
        if change.get("kind") in ("price_rise", "price_drop"):
            what += f" {_money(old)} → {_money(new)}"
        elif change.get("kind") == "rating_change":
            what += f" {old} → {new}"
        lines.append(f"• {_platform_label(str(change.get('platform')))} {change.get('pincode')}: {what}")
    answer.say(f"Latest detected changes for {ctx.name} (yours and rivals'):\n" + "\n".join(lines))
    answer.cite("recent_changes", len(changes))
    ctx.product_link(answer, label="Open weekly changelog")


def _recommendation_link(ctx: _Ctx, answer: _Answer) -> None:
    pending = ctx.raw.get("pending_recommendations") or []
    target = ctx.product_id if not ctx.portfolio else (pending[0]["product_id"] if pending else None)
    if target:
        answer.link("Review recommendations", f"/products/{target}")
    else:
        answer.link("Open dashboard", "/dashboard")


def _priority_data(ctx: _Ctx, answer: _Answer) -> None:
    pending = ctx.raw.get("pending_recommendations") or []
    if pending:
        multi = len({item["product_id"] for item in pending}) > 1
        lines = [
            f"{index}. [{item['priority']}] "
            + (f"{item['product_name']}: " if multi else "")
            + item["action_text"]
            for index, item in enumerate(pending[:3], start=1)
        ]
        total = ctx.get("pending_count", len(pending))
        answer.say(
            f"Start with your highest-priority pending recommendation(s) ({total} pending):\n"
            + "\n".join(lines)
        )
        answer.cite("pending_recommendations", total)
        _recommendation_link(ctx, answer)
        return
    # No pending cards: derive a priority straight from the numbers.
    if not ctx.has_checks and not ctx.portfolio:
        _no_data(ctx, answer)
        return
    oos: list[str] = ctx.get("oos_pins", [])
    rival, avg_price = ctx.raw.get("cheapest_rival"), ctx.raw.get("avg_price")
    if oos:
        answer.say(
            f"No pending recommendations, but {ctx.name} is out of stock in {len(oos)} pin(s) "
            f"({', '.join(oos[:5])}). Fix availability there first."
        )
        answer.cite("oos_pins", len(oos))
        if ctx.product_id:
            answer.link("Open heatmap", f"/heatmap?product={ctx.product_id}")
    elif avg_price is not None and rival and avg_price / rival - 1 >= 0.05:
        answer.say(
            f"No pending recommendations. Your main gap is price: {ctx.name} averages "
            f"{_money(avg_price)} vs the cheapest rival at {_money(rival)}."
        )
        answer.cite("avg_price", avg_price)
    else:
        answer.say(
            f"Nothing urgent: no pending recommendations and {ctx.name} has no stock-outs "
            "on the latest check. Keep the check schedule running."
        )
    ctx.product_link(answer)


def _approved_data(ctx: _Ctx, answer: _Answer) -> None:
    approved = ctx.raw.get("approved_actions") or []
    count = ctx.get("approved_count", 0)
    if not approved:
        answer.say("You haven't approved any recommendations yet.")
        _recommendation_link(ctx, answer)
        return
    lines = [f"• {item['product_name']}: {item['action_text']}" for item in approved]
    answer.say(f"You have approved {count} recommendation(s). Most recent:\n" + "\n".join(lines))
    answer.cite("approved_recommendations", count)


def _credits_data(ctx: _Ctx, answer: _Answer) -> None:
    used = ctx.get("credits_used_today", 0)
    budget = ctx.raw.get("daily_credit_budget")
    plan = str(ctx.get("plan", "free")).title()
    line = f"You've used {used} credit(s) today on the {plan} plan"
    line += f"; {max(budget - used, 0)} of {budget} remain." if budget else " with no daily limit."
    line += (
        " Each Zepto or Instamart check is a TinyFish agent run and uses one credit; "
        "Amazon and Flipkart page reads are free."
    )
    answer.say(line)
    answer.cite("credits_used_today", used)
    if budget:
        answer.cite("credits_remaining", max(budget - used, 0))


def _rating_data(ctx: _Ctx, answer: _Answer) -> None:
    rating = ctx.raw.get("rating")
    if rating is None:
        answer.say(f"No rating was captured for {ctx.name} on the latest checks.")
        return
    answer.say(f"{ctx.name} averages a {rating:.1f}★ rating across the latest checks.")
    answer.cite("rating", rating)
    ctx.product_link(answer, label="Open reviews")


def _weekly_data(ctx: _Ctx, answer: _Answer) -> None:
    this_price, last_price = ctx.raw.get("this_week_avg_price"), ctx.raw.get("last_week_avg_price")
    if this_price is None and last_price is None:
        answer.say(f"Not enough history for a weekly comparison of {ctx.name} yet.")
        return
    if last_price is None:
        trend = f"averages {_money(this_price)} over the last 7 days (no checks in the 7 days before to compare)"
    elif this_price is None:
        trend = f"had no checks in the last 7 days; the 7 days before averaged {_money(last_price)}"
    else:
        trend = f"averages {_money(this_price)} over the last 7 days vs {_money(last_price)} the 7 days before"
    answer.say(
        f"{ctx.name} {trend}, with {ctx.get('this_week_oos_count', 0)} out-of-stock "
        "check(s) this week."
    )
    answer.cite("this_week_avg_price", this_price)


def _heatmap_line(ctx: _Ctx, answer: _Answer) -> None:
    answer.say(
        f"{ctx.name} heatmap now: {ctx.get('in_stock', 0)} in stock, "
        f"{len(ctx.get('oos_pins', []))} out of stock, {ctx.get('price_gap_pins', 0)} price-gap, "
        f"{ctx.get('stale_pins', 0)} stale pins, {ctx.get('hot_zone_count', 0)} hot zone(s)."
    )
    answer.cite("in_stock", ctx.get("in_stock"))


def _overview(ctx: _Ctx, answer: _Answer, text: str) -> None:
    if ctx.portfolio:
        _stock_data(ctx, answer, text)
    elif ctx.has_checks:
        _heatmap_line(ctx, answer)
        _price_data(ctx, answer, text)
    else:
        _no_data(ctx, answer)
        return
    pending = ctx.get("pending_count", 0)
    if pending:
        answer.say(f"{pending} recommendation(s) are waiting for your decision.")
        _recommendation_link(ctx, answer)


# ---------------------------------------------------------------- router


def _decline() -> ChatOut:
    return ChatOut(
        reply=(
            "Sorry, I can only help with ShelfSense: your prices versus rivals "
            "(including the true price at checkout), stock and out-of-stock pincodes, "
            "recommendations, credits and plans, and setting up things like Telegram "
            "alerts. Try \"Which pincodes are out of stock right now?\""
        ),
        actions=[ChatAction(label="Browse help topics", path="/help")],
    )


def _greeting(ctx: _Ctx) -> ChatOut:
    return ChatOut(
        reply=(
            "Hi! Ask me about your prices versus rivals, stock-outs by pincode, what to "
            "fix first, credits left, or how to connect Telegram, add products and "
            "pincodes."
        ),
        actions=[ChatAction(label="Open dashboard", path="/dashboard")],
    )


def answer_chat(context: dict, message: str) -> ChatOut:
    """Route one message to how-to guidance, a data answer, or a polite decline."""
    text = " ".join(message.split())
    ctx = _Ctx(context)
    if _GREETING.match(text):
        return _greeting(ctx)
    answer = _Answer()
    how_to = bool(_HOW_TO.search(text))
    topics = [key for key, pattern in _TOPICS if pattern.search(text)]

    # Data intents (checked before guidance so "how many credits are left" is a number).
    wants_credits = bool(_CREDITS_LEFT.search(text)) and any(
        word in text.lower() for word in ("credit", "check", "run", "quota", "budget", "usage", "left", "remaining")
    ) and not how_to
    wants_cheapest_platform = bool(_CHEAPEST_PLATFORM.search(text))
    wants_price = bool(_PRICE.search(text)) and not wants_cheapest_platform
    wants_stock = bool(_STOCK.search(text))
    wants_changes = bool(_CHANGES.search(text)) and not how_to
    wants_approved = bool(_APPROVED.search(text)) and not how_to
    wants_priority = bool(_PRIORITY.search(text)) and not wants_approved
    wants_rating = bool(_RATING.search(text))
    wants_weekly = bool(_WEEKLY.search(text)) and not how_to
    wants_overview = bool(_OVERVIEW.search(text))
    platforms_only = bool(_PLATFORM.search(text))

    guidance = [
        key
        for key in topics
        if key in _ALWAYS_HOWTO or (how_to and not (wants_price or wants_stock))
    ]
    if wants_credits and "credits" in guidance:
        guidance.remove("credits")
    if wants_credits and "plans" in guidance and not how_to:
        guidance.remove("plans")
    if "runs" in guidance and (wants_credits or len(guidance) > 1):
        guidance.remove("runs")
    for key in guidance[:2]:
        _HOWTO[key](ctx, answer)

    data_handlers: list[Callable[[], None]] = []
    if wants_stock:
        data_handlers.append(lambda: _stock_data(ctx, answer, text))
    if wants_cheapest_platform:
        data_handlers.append(lambda: _cheapest_platform(ctx, answer))
    if wants_price:
        data_handlers.append(lambda: _price_data(ctx, answer, text))
    if wants_approved:
        data_handlers.append(lambda: _approved_data(ctx, answer))
    elif wants_priority:
        data_handlers.append(lambda: _priority_data(ctx, answer))
    if wants_changes and not (wants_price or wants_stock):
        data_handlers.append(lambda: _changes_data(ctx, answer))
    if wants_credits:
        data_handlers.append(lambda: _credits_data(ctx, answer))
    if wants_rating and not guidance:
        data_handlers.append(lambda: _rating_data(ctx, answer))
    if wants_weekly and not guidance:
        data_handlers.append(lambda: _weekly_data(ctx, answer))
    if not data_handlers and not guidance:
        if wants_overview or platforms_only:
            data_handlers.append(lambda: _overview(ctx, answer, text))
        elif "heatmap" in topics:
            data_handlers.append(lambda: _howto_heatmap(ctx, answer))
        elif "recommendations" in topics:
            data_handlers.append(lambda: _priority_data(ctx, answer))
        elif "runs" in topics:
            data_handlers.append(lambda: _howto_runs(ctx, answer))
        elif topics:
            data_handlers.append(lambda: _HOWTO[topics[0]](ctx, answer))
    for handler in data_handlers:
        handler()
    if not answer.parts:
        return _decline()
    return answer.out()
