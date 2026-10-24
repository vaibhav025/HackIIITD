"""Telegram bot features: menu, products, full 4-app report, last checked,
/compare, /check (live TinyFish run) and photo alerts.

Kept apart from ``telegram.py`` (linking, lifecycle, delivery) so each stays
readable. A chat may act on a product when it is linked to that product, or to
another product of the same owner (the owner shared a code with this chat). In
groups only the person who linked the group may start a paid check or change
alerts.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import SessionLocal
from ..models.checks import CheckResult
from ..models.intelligence import Alert
from ..models.product import Pincode, Product, ProductPincode
from ..models.telegram import TelegramLink
from ..models.user import Subscription
from .events import run_events
from .plans import remaining_credits_today
from .runner import create_run, schedule_run

logger = logging.getLogger("shelfsense.telegram")

APP_LABELS = {
    "zepto": "Zepto",
    "instamart": "Instamart",
    "amazon": "Amazon",
    "flipkart": "Flipkart",
    "blinkit": "Blinkit",
}
# Report order: quick commerce first, then marketplaces.
REPORT_APPS = ("zepto", "instamart", "amazon", "flipkart")
PHOTO_TYPES = {".png", ".jpg", ".jpeg", ".webp"}
PROGRESS_EDIT_SECONDS = 4.0
CHECK_WATCH_SECONDS = 20 * 60
MAX_PINCODE_BUTTONS = 6
MAX_PRODUCTS = 10
GROUP_CHAT_TYPES = {"group", "supergroup"}

BOT_COMMANDS = [
    ("menu", "Show the ShelfSense menu"),
    ("products", "All your products, with report and check buttons"),
    ("status", "Full report: all 4 apps for each product"),
    ("last", "When each product and app was last checked"),
    ("compare", "Compare prices across Zepto, Instamart, Amazon, Flipkart"),
    ("check", "Run a live TinyFish check now"),
    ("ask", "Ask a question about your products"),
    ("link", "Connect this chat with a code from the website"),
    ("stop", "Disconnect this chat"),
]
BOT_SHORT_DESCRIPTION = (
    "Price and stock alerts for Zepto, Instamart, Amazon and Flipkart, pincode by pincode."
)
BOT_DESCRIPTION = (
    "ShelfSense watches your products on Zepto, Instamart, Amazon and Flipkart across "
    "Delhi pincodes using TinyFish web agents.\n\n"
    "• Alerts when you go out of stock or a rival undercuts you, with screenshot proof\n"
    "• /products and /status: a report across all 4 apps\n"
    "• /check runs a live agent check from Telegram\n"
    "• Approve recommendations with one tap\n\n"
    "Open your product's Telegram tab on the ShelfSense website and tap the link to connect."
)


async def configure_bot_profile(bot) -> None:
    """Set the "/" command list and the bot's descriptions (best effort)."""
    from telegram import BotCommand

    try:
        await bot.set_my_commands([BotCommand(name, text) for name, text in BOT_COMMANDS])
        await bot.set_my_short_description(BOT_SHORT_DESCRIPTION)
        await bot.set_my_description(BOT_DESCRIPTION)
    except Exception:
        logger.warning("could not set bot commands/description", exc_info=True)


# --------------------------------------------------------------------- helpers


def _keyboard(rows):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup

    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(text, url=data[4:])
                if data.startswith("url:")
                else InlineKeyboardButton(text, callback_data=data)
                for text, data in row
            ]
            for row in rows
        ]
    )


def main_menu():
    origin = get_settings().frontend_origin.rstrip("/")
    rows = [
        [("📦 Products", "menu:products"), ("📊 Report", "menu:status")],
        [("🕒 Last checked", "menu:last"), ("💰 Compare", "menu:compare")],
        [("🔍 Check now", "menu:check")],
    ]
    # Telegram only accepts public http(s) URLs on buttons, not localhost.
    if origin.startswith("https://"):
        rows.append([("🗺 Open heatmap", f"url:{origin}/heatmap")])
    return _keyboard(rows)


def live_apps() -> list[str]:
    """Apps a check can run on right now, in report order."""
    settings = get_settings()
    if not settings.tinyfish_enabled:
        return list(REPORT_APPS)
    return [app for app in REPORT_APPS if app in settings.live_platforms]


async def _linked_products(session: AsyncSession, chat_id: str) -> list[Product]:
    links = (
        await session.scalars(
            select(TelegramLink)
            .where(TelegramLink.chat_id == chat_id)
            .order_by(TelegramLink.connected_at.desc())
        )
    ).all()
    products = []
    for link in links:
        product = await session.get(Product, link.product_id)
        if product is not None:
            products.append(product)
    return products


async def _owner_products(session: AsyncSession, chat_id: str) -> list[Product]:
    """Every product of the accounts that linked this chat (newest first)."""
    owners = {
        row
        for row in (
            await session.scalars(
                select(TelegramLink.user_id).where(TelegramLink.chat_id == chat_id)
            )
        ).all()
    }
    if not owners:
        return []
    return list(
        (
            await session.scalars(
                select(Product)
                .where(Product.user_id.in_(owners))
                .order_by(Product.created_at.desc())
                .limit(MAX_PRODUCTS)
            )
        ).all()
    )


async def _access(session: AsyncSession, chat_id: str, product_id: str) -> tuple[Product, TelegramLink] | None:
    """The product and a link proving this chat may act on it, else None."""
    product = await session.get(Product, product_id)
    if product is None:
        return None
    link = await session.scalar(
        select(TelegramLink).where(
            TelegramLink.chat_id == chat_id, TelegramLink.user_id == product.user_id
        ).order_by((TelegramLink.product_id == product_id).desc())
    )
    return (product, link) if link is not None else None


def _group_blocked(update, link: TelegramLink) -> bool:
    chat = update.effective_chat
    if chat is None or chat.type not in GROUP_CHAT_TYPES:
        return False
    actor = update.effective_user
    return actor is None or str(actor.id) != link.linked_by_telegram_user_id


def _money(value: float | None) -> str:
    if value is None:
        return "—"
    return f"₹{value:,.0f}" if value == int(value) else f"₹{value:,.2f}"


def time_ago(when: datetime | None, now: datetime | None = None) -> str:
    if when is None:
        return "never"
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    seconds = max(int(((now or datetime.now(UTC)) - when).total_seconds()), 0)
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} h ago"
    return f"{seconds // 86400} d ago"


# --------------------------------------------------------------------- per-app rollup


@dataclass
class AppSummary:
    platform: str
    cheapest: float | None
    in_stock: int
    total: int
    listing_wide: bool
    last_checked: datetime | None = None
    failed: int = 0
    not_listed: int = 0
    simulated: bool = False


async def compare_summary(session: AsyncSession, product_id: str) -> list[AppSummary]:
    """Latest result per (app, pincode) for the seller's own listing, rolled up per app."""
    rows = (
        await session.scalars(
            select(CheckResult)
            .where(CheckResult.product_id == product_id, CheckResult.competitor_id.is_(None))
            .order_by(CheckResult.checked_at.desc())
        )
    ).all()
    latest: dict[tuple[str, str], CheckResult] = {}
    for row in rows:
        latest.setdefault((row.platform, row.pincode), row)
    apps: dict[str, AppSummary] = {}
    for (platform, _pincode), row in latest.items():
        app = apps.setdefault(
            platform,
            AppSummary(platform, None, 0, 0, (row.raw or {}).get("pincode_specific") is False),
        )
        if app.last_checked is None or row.checked_at > app.last_checked:
            app.last_checked = row.checked_at
        raw = row.raw or {}
        if not str(raw.get("source", "")).startswith(("tinyfish_", "demo_cache")):
            app.simulated = True
        if raw.get("exact_match") is False:
            app.not_listed += 1
        if row.status != "ok":
            app.failed += 1
            continue
        app.total += 1
        if row.in_stock:
            app.in_stock += 1
            if row.price is not None and (app.cheapest is None or row.price < app.cheapest):
                app.cheapest = row.price
    return sorted(apps.values(), key=lambda a: (a.cheapest is None, a.cheapest or 0))


def compare_text(product_name: str, apps: list[AppSummary]) -> str:
    if not apps:
        return f"{product_name}: no check results yet. Tap 🔍 Check now."
    best = next((a for a in apps if a.cheapest is not None), None)
    lines = [f"💰 {product_name}"]
    for app in apps:
        label = APP_LABELS.get(app.platform, app.platform)
        if app.cheapest is None:
            stock = "out of stock" if app.total else "no data"
            if app.total and app.not_listed == app.total:
                stock = "exact pack not listed"
            lines.append(f"• {label}: {stock}{' 🧪 simulated' if app.simulated else ''}")
            continue
        mark = " ⭐ cheapest" if app is best else ""
        scope = " (listing-wide)" if app.listing_wide else f" · {app.in_stock}/{app.total} pins in stock"
        lines.append(f"• {label}: {_money(app.cheapest)}{scope}{mark}{' 🧪 simulated' if app.simulated else ''}")
    return "\n".join(lines)


def report_text(product_name: str, apps: list[AppSummary], now: datetime | None = None) -> str:
    """Every app in REPORT_APPS, checked or not, with when it was last checked."""
    by_app = {app.platform: app for app in apps}
    lines = [f"📊 {product_name}"]
    for platform in REPORT_APPS:
        label = APP_LABELS[platform]
        app = by_app.get(platform)
        if app is None:
            lines.append(f"⚪ {label}: not checked yet")
            continue
        when = time_ago(app.last_checked, now)
        if app.total == 0:
            lines.append(f"⚠️ {label}: last check failed · {when}")
            continue
        if not app.in_stock and app.not_listed == app.total:
            lines.append(f"⛔ {label}: exact pack not listed · {when}")
            continue
        icon = "✅" if app.in_stock else "❌"
        if app.in_stock:
            state = "listing-wide" if app.listing_wide else f"{app.in_stock}/{app.total} pins in stock"
        else:
            state = "out of stock (listing-wide)" if app.listing_wide else "out of stock"
        parts = [_money(app.cheapest)] if app.cheapest is not None else []
        tail = [" 🧪 simulated"] if app.simulated else []
        lines.append(f"{icon} {label}: " + " · ".join([*parts, state, when]) + "".join(tail))
    checked = [a.last_checked for a in apps if a.last_checked]
    lines.append(f"🕒 Last checked: {time_ago(max(checked), now) if checked else 'never'}")
    return "\n".join(lines)


def last_checked_text(product_name: str, apps: list[AppSummary], now: datetime | None = None) -> str:
    by_app = {app.platform: app for app in apps}
    parts = [
        f"{APP_LABELS[p]} {time_ago(by_app[p].last_checked, now) if p in by_app else 'never'}"
        for p in REPORT_APPS
    ]
    return f"🕒 {product_name}\n" + " · ".join(parts)


# --------------------------------------------------------------------- commands


async def _not_connected(message) -> None:
    await message.reply_text("This chat is not connected. Use /link <code> first.")


async def send_report(message, chat_id: str) -> None:
    async with SessionLocal() as session:
        products = await _linked_products(session, chat_id)
        if not products:
            await _not_connected(message)
            return
        blocks = [
            report_text(p.name, await compare_summary(session, p.id)) for p in products[:5]
        ]
    await message.reply_text(
        "\n\n".join(blocks)
        + "\n\nTap 📦 Products for your other products, or 🔍 Check now to refresh.",
        reply_markup=_keyboard([[("📦 Products", "menu:products"), ("🔍 Check now", "menu:check")]]),
    )


async def send_last_checked(message, chat_id: str) -> None:
    async with SessionLocal() as session:
        products = await _owner_products(session, chat_id)
        if not products:
            await _not_connected(message)
            return
        blocks = [
            last_checked_text(p.name, await compare_summary(session, p.id)) for p in products
        ]
    await message.reply_text("\n\n".join(blocks))


async def send_compare(message, chat_id: str) -> None:
    async with SessionLocal() as session:
        products = await _linked_products(session, chat_id)
        if not products:
            await _not_connected(message)
            return
        blocks = [
            compare_text(product.name, await compare_summary(session, product.id))
            for product in products[:5]
        ]
    await message.reply_text("\n\n".join(blocks))


async def send_products(message, chat_id: str) -> None:
    async with SessionLocal() as session:
        products = await _owner_products(session, chat_id)
        if not products:
            await _not_connected(message)
            return
        linked = {p.id for p in await _linked_products(session, chat_id)}
    lines = ["📦 Your products (🔔 = alerts on in this chat):"]
    rows = []
    for index, product in enumerate(products, start=1):
        bell = "🔔" if product.id in linked else "🔕"
        lines.append(f"{index}. {bell} {product.name}")
        rows.append(
            [
                (f"{index}. 📊 Report", f"prd:r:{product.id}"),
                ("🔍 Check", f"chk:p:{product.id}"),
                ("🔕 Alerts off" if product.id in linked else "🔔 Alerts on",
                 f"prd:{'u' if product.id in linked else 'a'}:{product.id}"),
            ]
        )
    await message.reply_text("\n".join(lines), reply_markup=_keyboard(rows))


async def handle_product_callback(update, context) -> bool:
    """prd:r (report) / prd:a (alerts on) / prd:u (alerts off); True when handled."""
    del context
    query = update.callback_query
    chat = update.effective_chat
    if query is None or chat is None or not (query.data or "").startswith("prd:"):
        return False
    _, action, product_id = (query.data.split(":") + ["", ""])[:3]
    chat_id = str(chat.id)
    async with SessionLocal() as session:
        access = await _access(session, chat_id, product_id)
        if access is None:
            await query.answer("This chat can't see that product.")
            return True
        product, link = access
        if action == "r":
            await query.answer()
            await query.message.reply_text(
                report_text(product.name, await compare_summary(session, product.id)),
                reply_markup=_keyboard([[("🔍 Check now", f"chk:p:{product.id}")]]),
            )
            return True
        if _group_blocked(update, link):
            await query.answer("Only the person who connected this group can change alerts.")
            return True
        existing = await session.scalar(
            select(TelegramLink).where(
                TelegramLink.chat_id == chat_id, TelegramLink.product_id == product.id
            )
        )
        if action == "a" and existing is None:
            session.add(
                TelegramLink(
                    user_id=product.user_id,
                    product_id=product.id,
                    chat_id=chat_id,
                    chat_title=link.chat_title,
                    linked_by_telegram_user_id=link.linked_by_telegram_user_id,
                    alert_types=[],
                )
            )
            with contextlib.suppress(IntegrityError):
                await session.commit()
            await query.answer("Alerts on")
            await query.message.reply_text(f"🔔 Alerts on for {product.name}.")
        elif action == "u" and existing is not None:
            remaining = await session.scalar(
                select(TelegramLink.id).where(
                    TelegramLink.chat_id == chat_id, TelegramLink.product_id != product.id
                ).limit(1)
            )
            if remaining is None:
                await query.answer("Keep at least one product, or use /stop to disconnect.")
                return True
            await session.delete(existing)
            await session.commit()
            await query.answer("Alerts off")
            await query.message.reply_text(f"🔕 Alerts off for {product.name}.")
        else:
            await query.answer("Already set.")
    return True


# --------------------------------------------------------------------- /check


async def start_check_flow(message, chat_id: str) -> None:
    async with SessionLocal() as session:
        products = await _owner_products(session, chat_id)
    if not products:
        await _not_connected(message)
        return
    if len(products) == 1:
        await _ask_app(message, products[0])
        return
    rows = [[(p.name[:40], f"chk:p:{p.id}")] for p in products]
    await message.reply_text("Which product should I check?", reply_markup=_keyboard(rows))


async def _ask_app(message, product: Product, *, edit: bool = False) -> None:
    apps = live_apps()
    rows = [
        [(APP_LABELS[p], f"chk:a:{product.id}:{p}") for p in apps[i : i + 2]]
        for i in range(0, len(apps), 2)
    ]
    if len(apps) > 1:
        rows.append([(f"🧩 All {len(apps)} apps", f"chk:a:{product.id}:all")])
    text = f"🔍 Live check for {product.name}\nWhich app?"
    if edit:
        await message.edit_text(text, reply_markup=_keyboard(rows))
    else:
        await message.reply_text(text, reply_markup=_keyboard(rows))


def _platforms_for(choice: str) -> list[str]:
    return live_apps() if choice == "all" else [choice]


def _cost_note(platforms: list[str], jobs_per_app: int = 1) -> str:
    from .tinyfish.tinyfish_client import CHECK_STRATEGY

    if not get_settings().tinyfish_enabled:
        return "Simulated check (no TinyFish key), a few seconds."
    agent = [p for p in platforms if CHECK_STRATEGY.get(p) == "agent"]
    fetch = [p for p in platforms if CHECK_STRATEGY.get(p) == "fetch"]
    parts = []
    if agent:
        credits = len(agent) * jobs_per_app
        parts.append(
            f"{', '.join(APP_LABELS[p] for p in agent)}: TinyFish agent, "
            f"{credits} credit{'s' if credits != 1 else ''}, 3–8 min"
        )
    if fetch:
        parts.append(
            f"{', '.join(APP_LABELS[p] for p in fetch)}: TinyFish Fetch, free, ~10 s "
            "(same for every pincode)"
        )
    return "\n".join(parts)


async def _pincode_choices(session: AsyncSession, product_id: str) -> list[str]:
    selected = sorted(
        set(
            (
                await session.scalars(
                    select(ProductPincode.pincode).where(ProductPincode.product_id == product_id)
                )
            ).all()
        )
    )
    if selected:
        return selected[:MAX_PINCODE_BUTTONS]
    return list(
        (await session.scalars(select(Pincode.code).order_by(Pincode.code).limit(MAX_PINCODE_BUTTONS))).all()
    )


async def handle_check_callback(update, context) -> bool:
    """chk:p / chk:a / chk:c / chk:r / chk:x callbacks; True when handled."""
    del context
    query = update.callback_query
    chat = update.effective_chat
    if query is None or chat is None or not (query.data or "").startswith("chk:"):
        return False
    parts = query.data.split(":")
    action, product_id = parts[1], parts[2] if len(parts) > 2 else ""
    chat_id = str(chat.id)
    if action == "x":
        await query.answer("Cancelled")
        await query.edit_message_text("Check cancelled. Nothing was run.")
        return True
    async with SessionLocal() as session:
        access = await _access(session, chat_id, product_id)
        if access is None:
            await query.answer("This chat is not linked to that product.")
            return True
        product, link = access
        if action == "p":
            await query.answer()
            await _ask_app(query.message, product, edit=True)
            return True
        choice = parts[3] if len(parts) > 3 else ""
        if choice != "all" and choice not in live_apps():
            await query.answer("That app can't be checked live right now.")
            return True
        platforms = _platforms_for(choice)
        label = "all apps" if choice == "all" else APP_LABELS[choice]
        if action == "a":
            pins = await _pincode_choices(session, product_id)
            areas = {
                row.code: row.area_name
                for row in (await session.scalars(select(Pincode).where(Pincode.code.in_(pins)))).all()
            }
            rows = [
                [(f"{pin} · {areas.get(pin, '')}".strip(" ·")[:30], f"chk:c:{product_id}:{choice}:{pin}")]
                for pin in pins
            ] or [[("Cancel", "chk:x")]]
            await query.answer()
            await query.edit_message_text(
                f"🔍 {product.name} on {label}\nWhich pincode?", reply_markup=_keyboard(rows)
            )
            return True
        pincode = parts[4] if len(parts) > 4 else ""
        if action == "c":
            await query.answer()
            await query.edit_message_text(
                f"Run a live check?\n\n{product.name}\n{label} · {pincode}\n\n{_cost_note(platforms)}",
                reply_markup=_keyboard(
                    [[("✅ Run check", f"chk:r:{product_id}:{choice}:{pincode}"), ("✖ Cancel", "chk:x")]]
                ),
            )
            return True
        if action != "r":
            return False
        if _group_blocked(update, link):
            await query.answer("Only the person who connected this group can run checks.")
            return True
        plan = await session.scalar(select(Subscription.plan).where(Subscription.user_id == product.user_id)) or "free"
        remaining = await remaining_credits_today(session, product.user_id, plan)
        if remaining is not None and remaining < 1:
            await query.answer("No credits left today.")
            return True
        # Make the apps part of the product's selection so the heatmap shows them.
        for platform in platforms:
            exists = await session.get(ProductPincode, (product.id, pincode, platform))
            if exists is None:
                session.add(ProductPincode(product_id=product.id, pincode=pincode, platform=platform))
        await session.commit()
        try:
            run, jobs = await create_run(
                session, product, trigger="manual", platforms=platforms, pincodes=[pincode]
            )
        except HTTPException as exc:
            detail = exc.detail.get("message") if isinstance(exc.detail, dict) else exc.detail
            await query.answer()
            await query.edit_message_text(f"Could not start the check: {detail}")
            return True
        except Exception:
            logger.exception("telegram check failed to start product=%s", product_id)
            await query.answer()
            await query.edit_message_text(
                "A check is already running for this product. Try again when it finishes."
            )
            return True
        schedule_run(run.id, product_id=product.id, user_id=product.user_id, jobs=jobs)
    await query.answer("Check started")
    await query.edit_message_text(f"⏳ Checking {product.name} on {label} · {pincode}…")
    task = asyncio.create_task(_follow_check(query.message, run.id, product.name, label, pincode))
    _watchers.add(task)
    task.add_done_callback(_watchers.discard)
    return True


_watchers: set[asyncio.Task] = set()


async def _follow_check(message, run_id: str, product_name: str, label: str, pincode: str) -> None:
    """Edit the progress message as agent steps arrive, then send the results."""
    past, queue = run_events.subscribe(run_id)
    header = f"⏳ Checking {product_name} on {label} · {pincode}"
    steps: list[str] = []
    finished: list[str] = []
    last_edit = 0.0
    deadline = time.monotonic() + CHECK_WATCH_SECONDS
    try:
        pending = list(past)
        while time.monotonic() < deadline:
            if not pending:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                except TimeoutError:
                    continue
                if event is None:
                    break
                pending.append(event)
            event = pending.pop(0)
            kind = event.get("type")
            if kind == "agent_step":
                step = event.get("step") or {}
                steps.append(f"• {step.get('label', '')}"[:90])
            elif kind in ("result", "job_failed"):
                app = str(event.get("job_key", "")).split(":")[0]
                finished.append(f"{'✔' if kind == 'result' else '✖'} {APP_LABELS.get(app, app)} done")
            elif kind == "run_done":
                break
            else:
                continue
            if time.monotonic() - last_edit >= PROGRESS_EDIT_SECONDS:
                last_edit = time.monotonic()
                with contextlib.suppress(Exception):
                    await message.edit_text("\n".join([header, *finished, "", *steps[-5:]]))
    finally:
        run_events.unsubscribe(run_id, queue)
    await _send_check_results(message, run_id, product_name, pincode)


def _result_line(row: CheckResult) -> str:
    label = APP_LABELS.get(row.platform, row.platform)
    if row.status != "ok":
        return f"⚠️ {label}: check failed ({(row.error or 'unknown error')[:80]})"
    if (row.raw or {}).get("exact_match") is False:
        notes = (row.raw or {}).get("notes") or []
        return f"⛔ {label}: {notes[0] if notes else 'exact pack not listed'}"
    stock = "✅ in stock" if row.in_stock else ("❌ out of stock" if row.in_stock is False else "❔ unknown")
    eta = ""
    if row.eta_minutes is not None:
        eta = f" · 🚚 {row.eta_minutes} min" if row.eta_minutes < 120 else f" · 🚚 ~{round(row.eta_minutes / 1440)} d"
    source = (row.raw or {}).get("source")
    how = " (listing-wide)" if source == "tinyfish_fetch_api" else (" (cached)" if source == "demo_cache" else "")
    return f"{label}: {_money(row.price)} · {stock}{eta}{how}"


async def _send_check_results(message, run_id: str, product_name: str, pincode: str) -> None:
    async with SessionLocal() as session:
        rows = (
            await session.scalars(
                select(CheckResult)
                .where(CheckResult.run_id == run_id, CheckResult.competitor_id.is_(None))
                .order_by(CheckResult.checked_at)
            )
        ).all()
    if not rows:
        with contextlib.suppress(Exception):
            await message.edit_text(f"⌛ {product_name} · {pincode}: still running. See the Agents page.")
        return
    order = {app: index for index, app in enumerate(REPORT_APPS)}
    rows = sorted(rows, key=lambda r: order.get(r.platform, 99))
    text = f"✅ Check finished · {product_name} · {pincode}\n" + "\n".join(_result_line(r) for r in rows)
    with contextlib.suppress(Exception):
        await message.edit_text(text)
    for row in rows:
        photo = _photo_path(row.screenshot_url)
        if photo is not None:
            with contextlib.suppress(Exception):
                await message.reply_photo(
                    photo=photo.read_bytes(),
                    caption=f"Proof: {APP_LABELS.get(row.platform, row.platform)} · {pincode}",
                )


# --------------------------------------------------------------------- photo alerts


def _photo_path(url: str | None) -> Path | None:
    from ..api.media import local_media_path

    path = local_media_path(url)
    if path is None or path.suffix.lower() not in PHOTO_TYPES or not path.exists():
        return None
    return path


async def alert_photo(session: AsyncSession, alert: Alert) -> Path | None:
    """Evidence screenshot for an alert: latest result at its app and pincode."""
    evidence = alert.evidence or {}
    platform, pincode = evidence.get("platform"), evidence.get("pincode")
    if not platform or not pincode:
        return None
    url = await session.scalar(
        select(CheckResult.screenshot_url)
        .where(
            CheckResult.product_id == alert.product_id,
            CheckResult.platform == platform,
            CheckResult.pincode == pincode,
            CheckResult.screenshot_url.is_not(None),
        )
        .order_by(CheckResult.checked_at.desc())
        .limit(1)
    )
    return _photo_path(url)


async def send_alert(chat_id: str, text: str, photo: Path | None) -> bool:
    """Alert with its screenshot attached when one exists; text-only otherwise."""
    from .telegram import get_bot_application, send_telegram_message

    application = get_bot_application()
    if photo is not None and application is not None:
        try:
            await application.bot.send_photo(chat_id=chat_id, photo=photo.read_bytes(), caption=text[:1000])
            return True
        except Exception:
            logger.warning("alert photo failed chat=%s; sending text", chat_id, exc_info=True)
    return await send_telegram_message(chat_id, text)
