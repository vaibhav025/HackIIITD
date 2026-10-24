"""KPI aggregation, sparklines, weekly comparisons, reviews, change detection.

History reads are bounded to ``HISTORY_WINDOW`` and daily buckets follow the
product owner's timezone.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.checks import ChangeEvent, CheckResult
from ..models.intelligence import AISummary, Recommendation, ReviewInsight
from ..models.product import Competitor, Product
from ..models.user import User
from .heatmap import HISTORY_WINDOW, mean, selected_pairs, take_latest

PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}
PRICE_CHANGE_MIN = 1.0
RATING_CHANGE_MIN = 0.1
OVERVIEW_RECOMMENDATION_LIMIT = 5
CHANGELOG_LIMIT = 100
# Leading characters spreadsheet apps evaluate as formulas.
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: object) -> object:
    """Neutralise spreadsheet formula injection in exported text cells."""
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return f"'{value}"
    return value


async def product_timezone(session: AsyncSession, product_id: str) -> tzinfo:
    """The owner's IANA timezone for day buckets; UTC when unknown or invalid."""
    name = await session.scalar(
        select(User.timezone)
        .join(Product, Product.user_id == User.id)
        .where(Product.id == product_id)
    )
    try:
        return ZoneInfo(name) if name else UTC
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def compare_results(old: CheckResult, new: CheckResult) -> list[dict]:
    """Detect price, stock, and rating changes between two results for one key."""
    events: list[dict] = []
    if (
        old.price is not None
        and new.price is not None
        and abs(new.price - old.price) >= PRICE_CHANGE_MIN
    ):
        events.append(
            {
                "kind": "price_rise" if new.price > old.price else "price_drop",
                "old_value": round(old.price, 2),
                "new_value": round(new.price, 2),
            }
        )
    if old.in_stock is True and new.in_stock is False:
        events.append({"kind": "went_oos", "old_value": 1.0, "new_value": 0.0})
    elif old.in_stock is False and new.in_stock is True:
        events.append({"kind": "back_in_stock", "old_value": 0.0, "new_value": 1.0})
    if (
        old.rating is not None
        and new.rating is not None
        and abs(new.rating - old.rating) >= RATING_CHANGE_MIN
    ):
        events.append(
            {
                "kind": "rating_change",
                "old_value": round(old.rating, 2),
                "new_value": round(new.rating, 2),
            }
        )
    return events


async def detect_changes(
    session: AsyncSession, run_id: str, product_id: str
) -> list[ChangeEvent]:
    """Compare a finished run's results against the previous known result."""
    new_rows = list(
        (
            await session.scalars(
                select(CheckResult).where(
                    CheckResult.run_id == run_id,
                    CheckResult.product_id == product_id,
                    CheckResult.status == "ok",
                )
            )
        ).all()
    )
    if not new_rows:
        return []
    oldest = min(row.checked_at for row in new_rows)
    prior_rows = list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.run_id != run_id,
                    CheckResult.status == "ok",
                    CheckResult.checked_at < oldest,
                    CheckResult.checked_at >= oldest - HISTORY_WINDOW,
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )
    prior = take_latest(
        prior_rows, lambda row: (row.competitor_id, row.platform, row.pincode)
    )
    events: list[ChangeEvent] = []
    for row in new_rows:
        old = prior.get((row.competitor_id, row.platform, row.pincode))
        if old is None:
            continue
        for change in compare_results(old, row):
            events.append(
                ChangeEvent(
                    product_id=product_id,
                    competitor_id=row.competitor_id,
                    platform=row.platform,
                    pincode=row.pincode,
                    detected_at=datetime.now(UTC),
                    **change,
                )
            )
    if events:
        session.add_all(events)
        await session.commit()
    return events


def _history_start(now: datetime | None) -> datetime:
    return (now if now is not None else datetime.now(UTC)) - HISTORY_WINDOW


async def _latest_seller_rows(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> dict[tuple, CheckResult]:
    rows = list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_(None),
                    CheckResult.checked_at >= _history_start(now),
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )
    return take_latest(rows, lambda row: (row.platform, row.pincode))


async def _latest_rival_rows(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> dict[tuple, CheckResult]:
    rows = list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_not(None),
                    CheckResult.checked_at >= _history_start(now),
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )
    return take_latest(
        rows, lambda row: (row.competitor_id, row.platform, row.pincode)
    )


def _day_list(start: datetime, end: datetime, tz: tzinfo = UTC) -> list[str]:
    first = start.astimezone(tz).date()
    last = end.astimezone(tz).date()
    days: list[str] = []
    cursor = first
    while cursor <= last:
        days.append(cursor.isoformat())
        cursor = cursor + timedelta(days=1)
    return days


def _iso_day(value: datetime, tz: tzinfo = UTC) -> str:
    return value.astimezone(tz).date().isoformat()


def local_days_start(now: datetime, days: int, tz: tzinfo) -> datetime:
    """UTC instant of local midnight ``days`` days before ``now``'s local date."""
    local = (now.astimezone(tz) - timedelta(days=days)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return local.astimezone(UTC)


async def compute_overview(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> dict:
    now = now if now is not None else datetime.now(UTC)
    tz = await product_timezone(session, product_id)
    pairs = await selected_pairs(session, product_id)
    seller_latest = {
        key: row
        for key, row in (await _latest_seller_rows(session, product_id, now=now)).items()
        if key[0] in pairs.get(key[1], ())
    }
    rival_latest = {
        key: row
        for key, row in (await _latest_rival_rows(session, product_id, now=now)).items()
        if key[1] in pairs.get(key[2], ())
    }
    seller_cells = list(seller_latest.values())
    seller_ok = [row for row in seller_cells if row.status == "ok"]
    rival_prices = [
        row.price
        for row in rival_latest.values()
        if row.status == "ok" and row.in_stock is True and row.price is not None
    ]

    spark_start = local_days_start(now, 6, tz)
    days = _day_list(spark_start, now, tz)
    seller_window = list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_(None),
                    CheckResult.status == "ok",
                    CheckResult.checked_at >= spark_start,
                    CheckResult.checked_at <= now,
                )
            )
        ).all()
    )
    rival_window = list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_not(None),
                    CheckResult.status == "ok",
                    CheckResult.checked_at >= spark_start,
                    CheckResult.checked_at <= now,
                )
            )
        ).all()
    )
    price_series: list[float | None] = []
    stock_series: list[float] = []
    rating_series: list[float | None] = []
    rival_series: list[float | None] = []
    for day in days:
        day_rows = [
            row for row in seller_window if _iso_day(row.checked_at, tz) == day
        ]
        price_series.append(
            mean([row.price for row in day_rows if row.price is not None])
        )
        stock_series.append(
            float(sum(1 for row in day_rows if row.in_stock is True))
        )
        rating_series.append(
            mean([row.rating for row in day_rows if row.rating is not None])
        )
        rival_day = [
            row.price
            for row in rival_window
            if _iso_day(row.checked_at, tz) == day
            and row.in_stock is True
            and row.price is not None
        ]
        rival_series.append(min(rival_day) if rival_day else None)

    summary_row = await session.scalar(
        select(AISummary)
        .where(AISummary.product_id == product_id)
        .order_by(AISummary.created_at.desc())
        .limit(1)
    )
    pending = list(
        (
            await session.scalars(
                select(Recommendation)
                .where(
                    Recommendation.product_id == product_id,
                    Recommendation.status == "pending",
                )
                .order_by(Recommendation.created_at.desc())
                .limit(20)
            )
        ).all()
    )
    pending.sort(key=lambda row: PRIORITY_RANK.get(row.priority, 9))
    return {
        "kpis": {
            "avg_price": {
                "value": mean(
                    [row.price for row in seller_ok if row.price is not None]
                ),
                "sparkline": price_series,
            },
            "cheapest_rival": {
                "value": min(rival_prices) if rival_prices else None,
                "sparkline": rival_series,
            },
            "in_stock": {
                "value": sum(1 for row in seller_cells if row.in_stock is True),
                "total": len(seller_cells),
                "sparkline": stock_series,
            },
            "rating": {
                "value": mean([row.rating for row in seller_ok if row.rating is not None]),
                "sparkline": rating_series,
            },
        },
        "summary": (
            {
                "summary_text": summary_row.summary_text,
                "evidence": summary_row.evidence,
                "source": summary_row.source,
                "created_at": summary_row.created_at,
            }
            if summary_row
            else None
        ),
        "recommendations": [
            {
                "id": row.id,
                "product_id": row.product_id,
                "priority": row.priority,
                "action_text": row.action_text,
                "impact_text": row.impact_text,
                "evidence": row.evidence,
                "status": row.status,
                "created_at": row.created_at,
            }
            for row in pending[:OVERVIEW_RECOMMENDATION_LIMIT]
        ],
    }


async def compute_competitor_rows(
    session: AsyncSession, product_id: str, *, now: datetime | None = None
) -> list[dict]:
    product = await session.get(Product, product_id)
    if product is None:
        return []
    seller_latest = await _latest_seller_rows(session, product_id, now=now)
    rival_latest = await _latest_rival_rows(session, product_id, now=now)
    names = {
        row.id: row.name
        for row in (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    }
    groups: dict[tuple[str | None, str], list[CheckResult]] = {}
    for (platform, _pincode), row in seller_latest.items():
        groups.setdefault((None, platform), []).append(row)
    for (competitor_id, platform, _pincode), row in rival_latest.items():
        groups.setdefault((competitor_id, platform), []).append(row)

    rows: list[dict] = []
    for (competitor_id, platform), members in groups.items():
        ok = [member for member in members if member.status == "ok"]
        rows.append(
            {
                "entity_id": competitor_id,
                "name": product.name if competitor_id is None else names.get(
                    competitor_id, "Competitor"
                ),
                "is_seller": competitor_id is None,
                "platform": platform,
                "price": mean([row.price for row in ok if row.price is not None]),
                "in_stock": sum(1 for row in members if row.in_stock is True),
                "total": len(members),
                "rating": mean([row.rating for row in ok if row.rating is not None]),
                "eta_minutes": mean(
                    [float(row.eta_minutes) for row in ok if row.eta_minutes is not None]
                ),
                "price_delta_pct": None,
                "checked_at": max(member.checked_at for member in members),
            }
        )
    rows.sort(
        key=lambda row: (0 if row["is_seller"] else 1, row["platform"], row["name"])
    )
    seller_price = {
        row["platform"]: row["price"] for row in rows if row["is_seller"]
    }
    for row in rows:
        if row["is_seller"]:
            row["price_delta_pct"] = 0.0
            continue
        base = seller_price.get(row["platform"])
        if base is None or row["price"] is None or base == 0:
            row["price_delta_pct"] = None
        else:
            row["price_delta_pct"] = round((row["price"] / base - 1) * 100, 2)
    return rows


async def daily_entity_rows(
    session: AsyncSession,
    product_id: str,
    *,
    platform: str | None,
    start: datetime,
    now: datetime,
) -> list[dict]:
    product = await session.get(Product, product_id)
    if product is None:
        return []
    competitor_rows = list(
        (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    )
    if platform is not None:
        competitor_rows = [row for row in competitor_rows if row.platform == platform]
    seller_statement = select(CheckResult).where(
        CheckResult.product_id == product_id,
        CheckResult.competitor_id.is_(None),
        CheckResult.status == "ok",
        CheckResult.checked_at >= start,
        CheckResult.checked_at <= now,
    )
    rival_statement = select(CheckResult).where(
        CheckResult.product_id == product_id,
        CheckResult.competitor_id.is_not(None),
        CheckResult.status == "ok",
        CheckResult.checked_at >= start,
        CheckResult.checked_at <= now,
    )
    if platform is not None:
        seller_statement = seller_statement.where(CheckResult.platform == platform)
        rival_statement = rival_statement.where(CheckResult.platform == platform)
    seller_rows = list((await session.scalars(seller_statement)).all())
    rival_rows = list((await session.scalars(rival_statement)).all())

    tz = await product_timezone(session, product_id)
    days = _day_list(start, now, tz)
    entities: list[tuple[str | None, str, str, list[CheckResult]]] = [
        (
            None,
            product.name,
            platform or "all",
            seller_rows,
        )
    ]
    for competitor in competitor_rows:
        entities.append(
            (
                competitor.id,
                competitor.name,
                competitor.platform,
                [
                    row
                    for row in rival_rows
                    if row.competitor_id == competitor.id
                ],
            )
        )

    output: list[dict] = []
    for entity_id, name, entity_platform, rows in entities:
        for day in days:
            day_rows = [row for row in rows if _iso_day(row.checked_at, tz) == day]
            prices = [row.price for row in day_rows if row.price is not None]
            ratings = [row.rating for row in day_rows if row.rating is not None]
            output.append(
                {
                    "date": day,
                    "entity_id": entity_id,
                    "name": name,
                    "platform": entity_platform,
                    "is_seller": entity_id is None,
                    "avg_price": mean(prices),
                    "checks": len(day_rows),
                    "in_stock": sum(
                        1 for row in day_rows if row.in_stock is True
                    ),
                    "avg_rating": mean(ratings),
                }
            )
    return output


def _window_stats(
    rows: list[CheckResult], rival_cheapest: dict[tuple, float]
) -> dict:
    prices = [row.price for row in rows if row.price is not None]
    ratings = [row.rating for row in rows if row.rating is not None]
    ranks: list[float] = []
    for row in rows:
        if row.price is None:
            continue
        cheaper = sum(
            1
            for (r_platform, r_pincode, _rival), price in rival_cheapest.items()
            if r_platform == row.platform
            and r_pincode == row.pincode
            and price < row.price
        )
        ranks.append(float(1 + cheaper))
    return {
        "avg_price": mean(prices),
        "oos_count": sum(1 for row in rows if row.in_stock is False),
        "rating": mean(ratings),
        "search_rank": mean(ranks),
    }


def _rival_cheapest(rival_rows: list[CheckResult]) -> dict[tuple, float]:
    cheapest: dict[tuple, float] = {}
    for row in rival_rows:
        if row.in_stock is not True or row.price is None:
            continue
        key = (row.platform, row.pincode, row.competitor_id)
        current = cheapest.get(key)
        if current is None or row.price < current:
            cheapest[key] = row.price
    return cheapest


async def compute_weekly(
    session: AsyncSession,
    product_id: str,
    *,
    platform: str | None = None,
    now: datetime | None = None,
) -> dict:
    now = now if now is not None else datetime.now(UTC)
    this_start = now - timedelta(days=7)
    last_start = now - timedelta(days=14)
    seller_statement = select(CheckResult).where(
        CheckResult.product_id == product_id,
        CheckResult.competitor_id.is_(None),
        CheckResult.status == "ok",
        CheckResult.checked_at >= last_start,
        CheckResult.checked_at <= now,
    )
    rival_statement = select(CheckResult).where(
        CheckResult.product_id == product_id,
        CheckResult.competitor_id.is_not(None),
        CheckResult.status == "ok",
        CheckResult.checked_at >= last_start,
        CheckResult.checked_at <= now,
    )
    if platform is not None:
        seller_statement = seller_statement.where(CheckResult.platform == platform)
        rival_statement = rival_statement.where(CheckResult.platform == platform)
    seller_rows = list((await session.scalars(seller_statement)).all())
    rival_rows = list((await session.scalars(rival_statement)).all())
    this_week_rows = [row for row in seller_rows if row.checked_at >= this_start]
    last_week_rows = [
        row for row in seller_rows if this_start > row.checked_at >= last_start
    ]
    this_rivals = [row for row in rival_rows if row.checked_at >= this_start]
    last_rivals = [
        row for row in rival_rows if this_start > row.checked_at >= last_start
    ]

    tz = await product_timezone(session, product_id)
    series_start = local_days_start(now, 6, tz)
    daily = await daily_entity_rows(
        session, product_id, platform=platform, start=series_start, now=now
    )
    days = _day_list(series_start, now, tz)
    by_entity: dict[tuple, dict] = {}
    order: list[tuple] = []
    for row in daily:
        key = (row["entity_id"], row["name"], row["platform"], row["is_seller"])
        if key not in by_entity:
            by_entity[key] = {
                "entity_id": row["entity_id"],
                "name": row["name"],
                "platform": row["platform"],
                "is_seller": row["is_seller"],
                "prices": [],
                "in_stock": [],
                "checks": [],
            }
            order.append(key)
        by_entity[key]["prices"].append(row["avg_price"])
        by_entity[key]["in_stock"].append(row["in_stock"])
        by_entity[key]["checks"].append(row["checks"])

    changelog_statement = (
        select(ChangeEvent)
        .where(
            ChangeEvent.product_id == product_id,
            ChangeEvent.detected_at >= last_start,
        )
        .order_by(ChangeEvent.detected_at.desc())
        .limit(CHANGELOG_LIMIT)
    )
    if platform is not None:
        changelog_statement = changelog_statement.where(
            ChangeEvent.platform == platform
        )
    changelog = list((await session.scalars(changelog_statement)).all())
    return {
        "platform": platform,
        "this_week": _window_stats(this_week_rows, _rival_cheapest(this_rivals)),
        "last_week": _window_stats(last_week_rows, _rival_cheapest(last_rivals)),
        "series": {
            "days": days,
            "entities": [by_entity[key] for key in order],
        },
        "changelog": [
            {
                "id": row.id,
                "competitor_id": row.competitor_id,
                "platform": row.platform,
                "pincode": row.pincode,
                "kind": row.kind,
                "old_value": row.old_value,
                "new_value": row.new_value,
                "detected_at": row.detected_at,
            }
            for row in changelog
        ],
    }


def build_weekly_csv(daily_rows: list[dict], this_week_start: datetime) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "date",
            "week",
            "entity",
            "platform",
            "avg_price",
            "checks",
            "in_stock",
            "avg_rating",
        ]
    )
    cutoff = this_week_start.date()
    for row in daily_rows:
        date_value = datetime.fromisoformat(row["date"]).date()
        writer.writerow(
            [
                row["date"],
                "this_week" if date_value >= cutoff else "last_week",
                csv_safe(row["name"]),
                csv_safe(row["platform"]),
                row["avg_price"] if row["avg_price"] is not None else "",
                row["checks"],
                row["in_stock"],
                row["avg_rating"] if row["avg_rating"] is not None else "",
            ]
        )
    return buffer.getvalue()


async def compute_reviews(session: AsyncSession, product_id: str) -> dict:
    """Review signals, kept apart by whose they are.

    ``loves``/``complaints`` describe the seller's own product; the
    ``rival_*`` lists come only from competitor review insights, so the UI
    never presents the seller's own weak spots as a rival's.
    """
    product = await session.get(Product, product_id)
    if product is None:
        return {
            "loves": [],
            "complaints": [],
            "rival_loves": [],
            "rival_complaints": [],
            "items": [],
        }
    rows = list(
        (
            await session.scalars(
                select(ReviewInsight).where(ReviewInsight.product_id == product_id)
            )
        ).all()
    )
    names = {
        row.id: row.name
        for row in (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    }
    rows.sort(
        key=lambda row: (
            row.competitor_id is not None,
            names.get(row.competitor_id or "", ""),
        )
    )
    merged: dict[str, list[str]] = {
        "loves": [],
        "complaints": [],
        "rival_loves": [],
        "rival_complaints": [],
    }
    items: list[dict] = []
    for row in rows:
        own = row.competitor_id is None
        name = product.name if own else names.get(row.competitor_id, "Competitor")
        items.append(
            {
                "entity_id": row.competitor_id,
                "name": name,
                "loves": row.loves,
                "complaints": row.complaints,
                "updated_at": row.updated_at,
            }
        )
        prefix = "" if own else "rival_"
        for key, values in (("loves", row.loves), ("complaints", row.complaints)):
            bucket = merged[prefix + key]
            for value in values:
                if value not in bucket:
                    bucket.append(value)
    return {**merged, "items": items}
