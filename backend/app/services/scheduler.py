"""In-process scheduler: due-product scans and Telegram morning briefings.

Single process only (no Redis/Celies): one AsyncScheduler runs two interval
jobs. Everything is a no-op when nothing is due, so mock-mode dev and tests
are unaffected. Jobs create runs through the same runner used by the API.
"""

from __future__ import annotations

import contextlib
import inspect
import logging
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import HTTPException
from sqlalchemy import select

from ..config import get_settings
from ..db import SessionLocal
from ..models.base import utcnow
from ..models.checks import ChangeEvent, CheckRun
from ..models.intelligence import AISummary, Alert
from ..models.product import Product, ProductPincode
from ..models.telegram import TelegramLink
from ..models.user import Subscription, User, UserSettings
from .alerts import link_wants, telegram_allowed
from .plans import (
    FREQUENCY_HOURS,
    limits_for,
    remaining_credits_today,
)

logger = logging.getLogger("shelfsense.scheduler")

SCAN_INTERVAL_SECONDS = 900
BRIEFING_INTERVAL_SECONDS = 60
FIRST_SCAN_DELAY_SECONDS = 20
BRIEFING_HISTORY_LIMIT = 1000
# "Check more often when prices are volatile": a price move at least this big
# within the window promotes the product one frequency step faster.
VOLATILE_CHANGE_PCT = 5.0
VOLATILE_WINDOW = timedelta(hours=48)

_scheduler: AsyncIOScheduler | None = None
_briefings_sent: set[tuple[str, str]] = set()


def is_due(last: datetime | None, interval_hours: float, now: datetime) -> bool:
    if last is None:
        return True
    return now - last >= timedelta(hours=interval_hours)


def boosted_interval_hours(
    interval_hours: float, minimum_hours: int | None
) -> float:
    """The next faster schedule than ``interval_hours`` the plan allows."""
    floor = minimum_hours or 0
    faster = [
        hours
        for hours in FREQUENCY_HOURS.values()
        if hours < interval_hours and hours >= floor
    ]
    return float(max(faster)) if faster else interval_hours


async def prices_volatile(session, product_id: str, now: datetime) -> bool:
    """A recent own or rival price move of at least ``VOLATILE_CHANGE_PCT``."""
    events = (
        await session.scalars(
            select(ChangeEvent).where(
                ChangeEvent.product_id == product_id,
                ChangeEvent.kind.in_(("price_rise", "price_drop")),
                ChangeEvent.detected_at >= now - VOLATILE_WINDOW,
            )
        )
    ).all()
    for event in events:
        if event.old_value in (None, 0) or event.new_value is None:
            continue
        pct = abs(event.new_value - event.old_value) / event.old_value * 100
        if pct >= VOLATILE_CHANGE_PCT:
            return True
    return False


def _prune_briefing_history() -> None:
    if len(_briefings_sent) <= BRIEFING_HISTORY_LIMIT:
        return
    _briefings_sent.clear()


async def recover_orphaned_runs() -> int:
    """Mark queued/running runs that no live task owns as failed.

    Single process: the runner keeps a set of active run IDs; anything still
    queued or running outside that set is left over from a previous boot and
    would block the active-run guard forever.
    """
    from .runner import active_run_ids

    async with SessionLocal() as session:
        stale = list(
            (
                await session.scalars(
                    select(CheckRun).where(CheckRun.status.in_(("queued", "running")))
                )
            ).all()
        )
        live = active_run_ids()
        recovered = 0
        for run in stale:
            if run.id in live:
                continue
            run.status = "failed"
            run.finished_at = utcnow()
            recovered += 1
        if recovered:
            await session.commit()
            logger.warning("recovered %s orphaned run(s)", recovered)
        return recovered


async def scan_due_products() -> int:
    """Create scheduled runs for products whose frequency window elapsed."""
    from .runner import build_jobs, create_run, schedule_run

    now = utcnow()
    await recover_orphaned_runs()
    started = 0
    # Credits left today per user (None = unlimited), drawn down as runs start.
    budget_left: dict[str, int | None] = {}
    async with SessionLocal() as session:
        products = list((await session.scalars(select(Product))).all())
        for product in products:
            if product.paused:
                continue
            interval_hours = FREQUENCY_HOURS.get(product.check_frequency)
            if interval_hours is None:
                interval_hours = 24
            plan = await session.scalar(
                select(Subscription.plan).where(Subscription.user_id == product.user_id)
            )
            plan_name = plan or "free"
            minimum = limits_for(plan_name).minimum_frequency_hours
            if minimum is not None and interval_hours < minimum:
                logger.warning(
                    "skipping product=%s: %sh interval is below the %s plan "
                    "minimum of %sh",
                    product.id,
                    interval_hours,
                    plan_name,
                    minimum,
                )
                continue
            if product.volatile_boost and await prices_volatile(
                session, product.id, now
            ):
                boosted = boosted_interval_hours(float(interval_hours), minimum)
                if boosted < interval_hours:
                    logger.info(
                        "volatile prices: product=%s checked every %sh instead of %sh",
                        product.id,
                        boosted,
                        interval_hours,
                    )
                    interval_hours = boosted
            active = await session.scalar(
                select(CheckRun.id)
                .where(
                    CheckRun.product_id == product.id,
                    CheckRun.status.in_(("queued", "running")),
                )
                .limit(1)
            )
            if active:
                continue
            last_run = await session.scalar(
                select(CheckRun)
                .where(CheckRun.product_id == product.id)
                .order_by(CheckRun.started_at.desc().nullslast())
                .limit(1)
            )
            last_at = last_run.finished_at or last_run.started_at if last_run else None
            if not is_due(last_at, float(interval_hours), now):
                continue
            pairs = list(
                (
                    await session.scalars(
                        select(ProductPincode).where(
                            ProductPincode.product_id == product.id
                        )
                    )
                ).all()
            )
            if not pairs:
                continue
            platforms = sorted({row.platform for row in pairs})
            pincodes = sorted({row.pincode for row in pairs})
            if product.user_id not in budget_left:
                budget_left[product.user_id] = await remaining_credits_today(
                    session, product.user_id, plan_name
                )
            remaining = budget_left[product.user_id]
            if remaining is not None:
                # Same estimate as a manual check: one credit per job.
                estimated = len(await build_jobs(session, product, platforms, pincodes))
                if estimated > remaining:
                    logger.info(
                        "skipping product=%s: run needs %s credits but only %s of "
                        "the %s plan daily budget remain",
                        product.id,
                        estimated,
                        remaining,
                        plan_name,
                    )
                    continue
            try:
                run, jobs = await create_run(
                    session,
                    product,
                    trigger="scheduled",
                    platforms=platforms,
                    pincodes=pincodes,
                )
            except HTTPException as exc:
                logger.warning(
                    "scheduled run creation failed product=%s detail=%s",
                    product.id,
                    exc.detail,
                )
                continue
            if remaining is not None:
                budget_left[product.user_id] = max(remaining - len(jobs), 0)
            scheduled = schedule_run(
                run.id, product_id=product.id, user_id=product.user_id, jobs=jobs
            )
            # The production runner returns a Task. Await a coroutine only so
            # dependency-injected/testing scheduling hooks are also supported.
            if inspect.iscoroutine(scheduled):
                await scheduled
            started += 1
            logger.info(
                "scheduled run started product=%s run=%s jobs=%s",
                product.id,
                run.id,
                len(jobs),
            )
    return started


async def build_briefing_text(
    session, product: Product, alert_count: int = 3
) -> str | None:
    summary = await session.scalar(
        select(AISummary)
        .where(AISummary.product_id == product.id)
        .order_by(AISummary.created_at.desc())
        .limit(1)
    )
    alerts = list(
        (
            await session.scalars(
                select(Alert)
                .where(Alert.product_id == product.id, Alert.read.is_(False))
                .order_by(Alert.created_at.desc())
                .limit(alert_count)
            )
        ).all()
    )
    lines = [f"ShelfSense briefing — {product.name}"]
    if summary is not None:
        lines.append(summary.summary_text)
    if alerts:
        lines.append("Recent alerts:")
        lines.extend(f"- {alert.message}" for alert in alerts)
    if len(lines) == 1:
        lines.append("No recent check data yet. Run a check to get started.")
    return "\n".join(lines)


def _local_now(user: User) -> datetime:
    try:
        return datetime.now(ZoneInfo(user.timezone))
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.now(UTC)


def _local_time_text(value: datetime) -> str:
    return value.strftime("%H:%M")


async def send_briefings() -> int:
    """Send one morning briefing per linked chat whose time has arrived.

    Only chats that opted into "briefing" (or into everything) get one, and
    never while the user has switched Telegram alerts off.
    """
    from .telegram import send_telegram_message

    settings = get_settings()
    if not settings.telegram_enabled:
        return 0
    _prune_briefing_history()
    sent = 0
    async with SessionLocal() as session:
        links = list((await session.scalars(select(TelegramLink))).all())
        for link in links:
            user = await session.get(User, link.user_id)
            if user is None or not link_wants(link, "briefing"):
                continue
            settings_row = await session.get(UserSettings, user.id)
            if not telegram_allowed(settings_row):
                continue
            local_now = _local_now(user)
            today = local_now.date().isoformat()
            wanted: str | None = None
            if link.briefing_time:
                wanted = link.briefing_time
            elif settings_row is not None and settings_row.briefing_time:
                wanted = settings_row.briefing_time
            if wanted is None or wanted != _local_time_text(local_now):
                continue
            key = (link.id, today)
            if key in _briefings_sent or link.last_briefing_date == today:
                continue
            product = await session.get(Product, link.product_id)
            if product is None:
                continue
            text = await build_briefing_text(session, product)
            if text is None:
                continue
            delivered = await send_telegram_message(link.chat_id, text)
            if delivered:
                _briefings_sent.add(key)
                link.last_briefing_date = today
                await session.commit()
                sent += 1
    return sent


async def _scan_job() -> None:
    with contextlib.suppress(Exception):
        await scan_due_products()


async def _briefing_job() -> None:
    with contextlib.suppress(Exception):
        await send_briefings()


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        _scan_job,
        "interval",
        seconds=SCAN_INTERVAL_SECONDS,
        next_run_time=datetime.now(UTC) + timedelta(seconds=FIRST_SCAN_DELAY_SECONDS),
        id="scan_due_products",
        replace_existing=True,
    )
    scheduler.add_job(
        _briefing_job,
        "interval",
        seconds=BRIEFING_INTERVAL_SECONDS,
        id="send_briefings",
        replace_existing=True,
    )
    scheduler.start()
    _scheduler = scheduler
    logger.info("scheduler started")


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("scheduler stopped")
