"""Telegram integration: link codes, bot lifecycle, and message delivery.

Everything degrades gracefully: without TELEGRAM_BOT_TOKEN the link-code API
still works (codes are stored for later redemption) but the bot never starts
and delivery is a no-op logger. All bot wiring lives behind this module so the
rest of the app never imports python-telegram-bot.

Link codes carry ~69 bits of randomness, are single-use (redeemed with a
conditional UPDATE), and failed redemptions are rate-limited per chat.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import SessionLocal
from ..models.base import utcnow
from ..models.intelligence import Recommendation
from ..models.product import Product
from ..models.telegram import TelegramLink, TelegramLinkAttempt, TelegramLinkCode
from .ai import get_ai_provider, with_fallback
from .intelligence import (
    RecommendationConflict,
    approve_recommendation,
    build_context,
)

logger = logging.getLogger("shelfsense.telegram")

LINK_CODE_TTL_MINUTES = 10
# Unambiguous uppercase alphabet (no 0/O, 1/I/L, U): 30 symbols x 14 ≈ 68.7 bits.
LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
LINK_CODE_GROUP = 7
MAX_FAILED_ATTEMPTS = 5
ATTEMPT_WINDOW = timedelta(minutes=10)
CHAT_PRODUCT_LIMIT = 5
GROUP_CHAT_TYPES = {"group", "supergroup"}
_WORD_RE = re.compile(r"[a-z0-9]+")
_bot_application = None


def _load_retryable_errors() -> tuple[type[Exception], ...]:
    try:
        from telegram.error import TelegramError

        return (TelegramError,)
    except ImportError:  # pragma: no cover - dependency always present in prod
        return ()


RETRYABLE_TELEGRAM_ERRORS = _load_retryable_errors()


def generate_link_code_value() -> str:
    groups = (
        "".join(secrets.choice(LINK_CODE_ALPHABET) for _ in range(LINK_CODE_GROUP))
        for _ in range(2)
    )
    return "SS-" + "-".join(groups)


async def create_link_code(
    session: AsyncSession,
    *,
    user_id: str,
    product_id: str,
    chat_type: str = "personal",
) -> TelegramLinkCode:
    """Issue a fresh code; the product's previous unused codes stop working."""
    stored_type = "group" if chat_type == "group" else "private"
    for _attempt in range(5):
        await session.execute(
            delete(TelegramLinkCode).where(
                TelegramLinkCode.product_id == product_id,
                TelegramLinkCode.used_at.is_(None),
            )
        )
        code = TelegramLinkCode(
            code=generate_link_code_value(),
            user_id=user_id,
            product_id=product_id,
            chat_type=stored_type,
            expires_at=utcnow() + timedelta(minutes=LINK_CODE_TTL_MINUTES),
        )
        session.add(code)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            continue
        await session.refresh(code)
        return code
    raise RuntimeError("Could not generate a unique Telegram link code")


def build_deeplink(code: str, chat_type: str = "personal") -> str | None:
    """t.me link that pre-fills ``/start <code>``; None when the bot username is unknown."""
    username = get_settings().telegram_bot_username.strip().lstrip("@")
    if not username:
        return None
    param = "startgroup" if chat_type == "group" else "start"
    return f"https://t.me/{username}?{param}={code}"


async def link_attempts_exhausted(session: AsyncSession, chat_id: str) -> bool:
    """True once a chat has failed ``MAX_FAILED_ATTEMPTS`` redemptions in the window."""
    failures = await session.scalar(
        select(func.count(TelegramLinkAttempt.id)).where(
            TelegramLinkAttempt.chat_id == chat_id,
            TelegramLinkAttempt.attempted_at >= utcnow() - ATTEMPT_WINDOW,
        )
    )
    return int(failures or 0) >= MAX_FAILED_ATTEMPTS


async def _record_failed_attempt(session: AsyncSession, chat_id: str) -> None:
    session.add(TelegramLinkAttempt(chat_id=chat_id))
    await session.execute(
        delete(TelegramLinkAttempt).where(
            TelegramLinkAttempt.attempted_at < utcnow() - ATTEMPT_WINDOW
        )
    )
    await session.commit()


async def redeem_link_code(
    session: AsyncSession,
    *,
    code_value: str,
    chat_id: str,
    chat_title: str | None = None,
    telegram_user_id: str | None = None,
) -> TelegramLink | None:
    """Exchange a code for a TelegramLink; None when invalid, used, expired, or rate-limited."""
    if await link_attempts_exhausted(session, chat_id):
        return None
    now = utcnow()
    claimed = await session.execute(
        update(TelegramLinkCode)
        .where(
            TelegramLinkCode.code == code_value,
            TelegramLinkCode.used_at.is_(None),
            TelegramLinkCode.expires_at > now,
        )
        .values(used_at=now)
    )
    row = await session.get(TelegramLinkCode, code_value) if claimed.rowcount else None
    product = await session.get(Product, row.product_id) if row is not None else None
    if row is None or product is None:
        await session.rollback()
        # The same chat re-sending a code it already redeemed (Telegram's Start
        # button tapped twice) is not a failure: it is simply still linked.
        used = await session.get(TelegramLinkCode, code_value)
        if used is not None and used.used_at is not None:
            already = await session.scalar(
                select(TelegramLink).where(
                    TelegramLink.product_id == used.product_id,
                    TelegramLink.chat_id == chat_id,
                )
            )
            if already is not None:
                return already
        await _record_failed_attempt(session, chat_id)
        return None
    existing = await session.scalar(
        select(TelegramLink).where(
            TelegramLink.product_id == row.product_id,
            TelegramLink.chat_id == chat_id,
        )
    )
    if existing is not None:
        await session.commit()
        return existing
    link = TelegramLink(
        user_id=row.user_id,
        product_id=row.product_id,
        chat_id=chat_id,
        chat_title=chat_title,
        linked_by_telegram_user_id=telegram_user_id,
        alert_types=[],
    )
    session.add(link)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent redemption linked the same chat first; the code stays used.
        await session.rollback()
        return await session.scalar(
            select(TelegramLink).where(
                TelegramLink.product_id == row.product_id,
                TelegramLink.chat_id == chat_id,
            )
        )
    await session.refresh(link)
    return link


async def link_code_problem(session: AsyncSession, code_value: str) -> str:
    """Why a code did not link, in words the person in the chat can act on."""
    fresh = (
        "Ask the product owner to open the product's Telegram tab on the ShelfSense "
        "website and send you a NEW link (each link works for one chat, once)."
    )
    row = await session.get(TelegramLinkCode, code_value)
    if row is None:
        return f"That code doesn't exist. Check you copied it fully. {fresh}"
    if row.used_at is not None:
        return f"That link was already used by another chat. {fresh}"
    if row.expires_at <= utcnow():
        return f"That link expired (links last {LINK_CODE_TTL_MINUTES} minutes). {fresh}"
    return f"That code could not be used. {fresh}"


async def unlink_link(session: AsyncSession, link_id: str) -> bool:
    """Delete one link by id; the chat stays linked to its other products."""
    result = await session.execute(delete(TelegramLink).where(TelegramLink.id == link_id))
    await session.commit()
    return bool(result.rowcount)


async def unlink_chat(session: AsyncSession, *, chat_id: str) -> int:
    """Bot ``/stop``: disconnect the chat from every product."""
    result = await session.execute(
        delete(TelegramLink).where(TelegramLink.chat_id == chat_id)
    )
    await session.commit()
    return result.rowcount or 0


async def chat_links(session: AsyncSession, chat_id: str) -> list[TelegramLink]:
    return list(
        (
            await session.scalars(
                select(TelegramLink)
                .where(TelegramLink.chat_id == chat_id)
                .order_by(TelegramLink.connected_at.desc())
            )
        ).all()
    )


def get_bot_application():
    return _bot_application


def bot_is_running() -> bool:
    return _bot_application is not None


async def send_telegram_message(
    chat_id: str, text: str, reply_markup=None
) -> bool:
    """Best-effort send; logs and returns False when the bot is not running."""
    if _bot_application is None:
        logger.info("telegram disabled; would send to %s: %s", chat_id, text[:200])
        return False
    try:
        await _bot_application.bot.send_message(
            chat_id=chat_id, text=text[:4000], reply_markup=reply_markup
        )
        return True
    except RETRYABLE_TELEGRAM_ERRORS:
        logger.warning("telegram send failed chat=%s", chat_id)
        return False
    except Exception:
        logger.exception("telegram send crashed chat=%s", chat_id)
        return False


async def send_recommendation_message(
    chat_id: str, recommendation: Recommendation, *, product_name: str | None = None
) -> bool:
    """Send a recommendation with Approve and Details inline buttons."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup

    settings = get_settings()
    name = product_name or "your product"
    text = (
        f"[ShelfSense] Recommendation for {name} "
        f"({recommendation.priority} priority):\n"
        f"{recommendation.action_text}\n"
        f"Impact: {recommendation.impact_text}"
    )
    details_url = f"{settings.frontend_origin}/products/{recommendation.product_id}"
    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    "Approve", callback_data=f"approve:{recommendation.id}"
                ),
                InlineKeyboardButton("Details", url=details_url),
            ]
        ]
    )
    return await send_telegram_message(chat_id, text, reply_markup=keyboard)


RECOMMENDATION_ALERT_TYPE = "recommendations"


def _wants_recommendations(link: TelegramLink) -> bool:
    """Chat opted into recommendations ([] = everything, ["none"] = nothing)."""
    from .alerts import link_wants

    return link_wants(link, RECOMMENDATION_ALERT_TYPE)


async def _owner_allows_telegram(session: AsyncSession, user_id: str) -> bool:
    from ..models.user import UserSettings
    from .alerts import telegram_allowed

    settings_row = await session.scalar(
        select(UserSettings).where(UserSettings.user_id == user_id)
    )
    return telegram_allowed(settings_row)


async def _product_links(
    session: AsyncSession, product_id: str, user_id: str | None = None
) -> list[TelegramLink]:
    statement = select(TelegramLink).where(TelegramLink.product_id == product_id)
    if user_id is not None:
        statement = statement.where(TelegramLink.user_id == user_id)
    return list((await session.scalars(statement)).all())


async def send_recommendation_to_chats(
    session: AsyncSession, recommendation: Recommendation, *, user_id: str
) -> tuple[str, int]:
    """Manual "Send to Telegram": (status, chats reached).

    status is ``no_linked_chats``, ``bot_offline``, ``sent`` or ``failed``.
    """
    links = await _product_links(session, recommendation.product_id, user_id)
    if not links:
        return "no_linked_chats", 0
    if not bot_is_running():
        return "bot_offline", 0
    product = await session.get(Product, recommendation.product_id)
    sent = 0
    for link in links:
        if await send_recommendation_message(
            link.chat_id, recommendation, product_name=product.name if product else None
        ):
            sent += 1
    return ("sent" if sent else "failed"), sent


async def push_new_recommendations(
    session: AsyncSession, product: Product, recommendations: list[Recommendation]
) -> int:
    """Push freshly generated recommendations to chats that want them."""
    if not recommendations or not bot_is_running():
        return 0
    if not await _owner_allows_telegram(session, product.user_id):
        return 0
    sent = 0
    for link in await _product_links(session, product.id):
        if not _wants_recommendations(link):
            continue
        for recommendation in recommendations:
            if await send_recommendation_message(
                link.chat_id, recommendation, product_name=product.name
            ):
                sent += 1
    return sent


async def notify_recommendation_approved(
    session: AsyncSession,
    recommendation: Recommendation,
    *,
    product: Product,
    message: str,
) -> int:
    """Tell linked chats what an approval (web or automatic) set in motion."""
    if not bot_is_running() or not await _owner_allows_telegram(
        session, product.user_id
    ):
        return 0
    how = "Auto-approved" if recommendation.decided_via == "auto" else "Approved"
    text = (
        f"[ShelfSense] {how} for {product.name}:\n"
        f"{recommendation.action_text}\n\n{message.removeprefix('Approved — ')}"
    )
    sent = 0
    for link in await _product_links(session, product.id):
        if _wants_recommendations(link) and await send_telegram_message(
            link.chat_id, text
        ):
            sent += 1
    return sent


async def handle_approve_callback(update, context) -> bool:
    """Process approve:<rec_id>; returns True when the callback was handled."""
    del context
    query = update.callback_query
    chat = update.effective_chat
    if query is None or chat is None or not query.data:
        return False
    if not query.data.startswith("approve:"):
        return False
    recommendation_id = query.data.split(":", 1)[1]
    async with SessionLocal() as session:
        recommendation = await session.get(Recommendation, recommendation_id)
        if recommendation is None:
            await query.answer("Recommendation no longer exists.")
            return True
        link = await session.scalar(
            select(TelegramLink).where(
                TelegramLink.chat_id == str(chat.id),
                TelegramLink.product_id == recommendation.product_id,
            )
        )
        if link is None:
            await query.answer("This chat is not linked to that product.")
            return True
        if chat.type in GROUP_CHAT_TYPES:
            actor = update.effective_user
            if actor is None or str(actor.id) != link.linked_by_telegram_user_id:
                await query.answer(
                    "Only the person who connected this group can approve."
                )
                return True
        if recommendation.status != "pending":
            await query.answer(f"Already {recommendation.status}.")
            await query.edit_message_text(
                f"{recommendation.action_text}\n\nStatus: {recommendation.status}."
            )
            return True
        try:
            outcome = await approve_recommendation(
                session, recommendation, decided_via="telegram"
            )
        except RecommendationConflict as exc:
            await query.answer(exc.message[:200])
            return True
        except HTTPException as exc:
            detail = exc.detail
            if isinstance(detail, dict):
                detail = detail.get("message") or detail
            await query.answer(str(detail)[:200])
            return True
        await query.edit_message_text(
            f"{recommendation.action_text}\n\nApproved ✓ "
            f"{outcome.message.removeprefix('Approved — ')}"
        )
        await query.answer("Recommendation approved.")
    return True


async def _handle_start(update, context) -> None:
    """Bot /start <code> and /link <code>: link the chat to a product."""
    args = context.args or []
    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None:
        return
    if not args:
        from .telegram_features import main_menu

        async with SessionLocal() as session:
            linked = bool(await chat_links(session, str(chat.id)))
        if linked:
            await message.reply_text("ShelfSense menu:", reply_markup=main_menu())
        else:
            await message.reply_text(
                "Welcome to ShelfSense! Open your product's Telegram tab on the "
                "ShelfSense website and tap the link (or send /link <code>) to connect."
            )
        return
    sender = update.effective_user
    async with SessionLocal() as session:
        if await link_attempts_exhausted(session, str(chat.id)):
            await message.reply_text(
                "Too many invalid codes from this chat. Wait 10 minutes and try "
                "again with a fresh code."
            )
            return
        link = await redeem_link_code(
            session,
            code_value=args[0].strip(),
            chat_id=str(chat.id),
            chat_title=chat.title,
            telegram_user_id=str(sender.id) if sender is not None else None,
        )
        if link is None:
            await message.reply_text(await link_code_problem(session, args[0].strip()))
            return
        product = await session.get(Product, link.product_id)
        name = product.name if product else "your product"
    from .telegram_features import main_menu

    await message.reply_text(
        f"Connected ✓ to {name}\n\nYou'll get stock and price alerts here. Try the menu:",
        reply_markup=main_menu(),
    )


async def _handle_status(update, context) -> None:
    """Bot /status: full report across all 4 apps for each linked product."""
    from .telegram_features import send_report

    del context
    message, chat = update.effective_message, update.effective_chat
    if message is not None and chat is not None:
        await send_report(message, str(chat.id))


async def _handle_products(update, context) -> None:
    from .telegram_features import send_products

    del context
    message, chat = update.effective_message, update.effective_chat
    if message is not None and chat is not None:
        await send_products(message, str(chat.id))


async def _handle_last(update, context) -> None:
    from .telegram_features import send_last_checked

    del context
    message, chat = update.effective_message, update.effective_chat
    if message is not None and chat is not None:
        await send_last_checked(message, str(chat.id))


def products_for_question(products: list[Product], question: str) -> list[Product]:
    """Products whose name words appear in the question; all of them when none do."""
    asked = set(_WORD_RE.findall(question.lower()))
    matched = [
        product
        for product in products
        if {word for word in _WORD_RE.findall(product.name.lower()) if len(word) > 2}
        & asked
    ]
    return matched or products


async def _handle_ask(update, context) -> None:
    """Bot /ask <question>: answer via the AI chat for the products it concerns."""
    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None:
        return
    question = " ".join(context.args or []).strip()
    if not question:
        await message.reply_text("Usage: /ask <question about your products>")
        return
    async with SessionLocal() as session:
        links = await chat_links(session, str(chat.id))
        if not links:
            await message.reply_text(
                "This chat is not connected. Use /start <code> first."
            )
            return
        products = [
            product
            for link in links[:CHAT_PRODUCT_LIMIT]
            if (product := await session.get(Product, link.product_id)) is not None
        ]
        provider = get_ai_provider()
        answers: list[str] = []
        targets = products_for_question(products, question)
        for product in targets:
            context_data = await build_context(session, product.id)
            if context_data is None:
                continue
            result, _source = await with_fallback(
                provider, "chat", context_data, question, []
            )
            answers.append(
                result.reply if len(targets) == 1 else f"{product.name}: {result.reply}"
            )
    if not answers:
        await message.reply_text("No check data yet for your linked products.")
        return
    await message.reply_text("\n\n".join(answers)[:4000])


GREETINGS = {"hi", "hii", "hello", "hey", "hlo", "menu", "help", "start", "namaste"}


async def _handle_text(update, context) -> None:
    """Plain messages in a private chat: greetings get the menu, anything else is /ask."""
    from types import SimpleNamespace

    from .telegram_features import main_menu

    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None or not message.text:
        return
    text = message.text.strip()
    async with SessionLocal() as session:
        linked = bool(await chat_links(session, str(chat.id)))
    if not linked:
        await message.reply_text(
            "This chat is not connected yet. Open your product's Telegram tab on the "
            "ShelfSense website and tap the link, or send /link <code>."
        )
        return
    if text.lower().strip("!.? ") in GREETINGS:
        await message.reply_text(
            "Hi! Tap a button, or just ask me something like "
            "\"where am I out of stock?\"",
            reply_markup=main_menu(),
        )
        return
    await _handle_ask(update, SimpleNamespace(args=text.split()))


async def _handle_stop(update, context) -> None:
    """Bot /stop: disconnect this chat from all products."""
    del context
    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None:
        return
    async with SessionLocal() as session:
        removed = await unlink_chat(session, chat_id=str(chat.id))
    if removed:
        await message.reply_text(
            "Disconnected ✓. Alerts and briefings will stop for this chat."
        )
    else:
        await message.reply_text("This chat was not connected.")


async def _handle_menu(update, context) -> None:
    from .telegram_features import main_menu

    del context
    message = update.effective_message
    if message is not None:
        await message.reply_text("ShelfSense menu:", reply_markup=main_menu())


async def _handle_compare(update, context) -> None:
    from .telegram_features import send_compare

    del context
    message, chat = update.effective_message, update.effective_chat
    if message is not None and chat is not None:
        await send_compare(message, str(chat.id))


async def _handle_check(update, context) -> None:
    from .telegram_features import start_check_flow

    del context
    message, chat = update.effective_message, update.effective_chat
    if message is not None and chat is not None:
        await start_check_flow(message, str(chat.id))


async def _handle_callback(update, context) -> None:
    from .telegram_features import handle_check_callback, handle_product_callback

    query = update.callback_query
    data = (query.data or "") if query is not None else ""
    if data.startswith("menu:"):
        await query.answer()
        action = data.split(":", 1)[1]
        if action == "status":
            await _handle_status(update, context)
        elif action == "compare":
            await _handle_compare(update, context)
        elif action == "check":
            await _handle_check(update, context)
        elif action == "products":
            await _handle_products(update, context)
        elif action == "last":
            await _handle_last(update, context)
        return
    if await handle_product_callback(update, context):
        return
    if await handle_check_callback(update, context):
        return
    await handle_approve_callback(update, context)


async def start_bot() -> bool:
    """Start polling the Telegram bot; False when no token is configured."""
    global _bot_application
    settings = get_settings()
    if not settings.telegram_enabled:
        return False
    if _bot_application is not None:
        return True
    try:
        from telegram.ext import (
            Application,
            CallbackQueryHandler,
            CommandHandler,
            MessageHandler,
            filters,
        )

        application = Application.builder().token(settings.telegram_bot_token).build()
        application.add_handler(CommandHandler(["start", "link"], _handle_start))
        application.add_handler(CommandHandler("status", _handle_status))
        application.add_handler(CommandHandler("ask", _handle_ask))
        application.add_handler(CommandHandler("stop", _handle_stop))
        application.add_handler(CommandHandler(["menu", "help"], _handle_menu))
        application.add_handler(CommandHandler("compare", _handle_compare))
        application.add_handler(CommandHandler("check", _handle_check))
        application.add_handler(CommandHandler("products", _handle_products))
        application.add_handler(CommandHandler(["last", "lastchecked"], _handle_last))
        application.add_handler(
            MessageHandler(
                filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE, _handle_text
            )
        )
        application.add_handler(CallbackQueryHandler(_handle_callback))
        await application.initialize()
        from .telegram_features import configure_bot_profile

        await configure_bot_profile(application.bot)
        await application.start()
        if application.updater is not None:
            await application.updater.start_polling()
        _bot_application = application
        logger.info("telegram bot started")
        return True
    except Exception:
        logger.exception("telegram bot failed to start")
        _bot_application = None
        return False


async def stop_bot() -> None:
    global _bot_application
    application = _bot_application
    if application is None:
        return
    _bot_application = None
    try:
        if application.updater is not None:
            await application.updater.stop()
        await application.stop()
        await application.shutdown()
    except Exception:
        logger.exception("telegram bot shutdown failed")
