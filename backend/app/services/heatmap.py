"""Pin-level heatmap: status classification, snapshots, and hot zones.

Status rules (applied per platform cell, worst cell wins for a pin row):
  stale         latest seller result failed, missing, or older than 24h
                (``stale_reason`` says which: failed / missing / old)
  out_of_stock  seller in_stock is False
  price_gap     in stock AND seller price >= 1.05 * cheapest in-stock rival
                (rival prices older than the 24h freshness window are ignored)
  in_stock      otherwise
In live mode, apps outside TINYFISH_LIVE_PLATFORMS (Blinkit by default) are
never checked: their stale cells get ``stale_reason == "unavailable"`` and are
ignored when picking a pin's worst cell, unless no other app is selected.
Hot zone: >= 3 out_of_stock pincodes within 3 km (haversine) -> cluster centre.
Snapshots (6h/24h/7d) use the latest result at or before (now - offset);
history older than 14 days before the snapshot is never scanned.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models.checks import CheckResult
from ..models.product import Competitor, Pincode, ProductPincode
from ..utils.geo import haversine_km
from .storage import screenshot_url_for
from .tinyfish.availability import skipped_platforms, unavailable_reason

SNAPSHOT_OFFSETS: dict[str, timedelta] = {
    "now": timedelta(0),
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}
STALE_AFTER = timedelta(hours=24)
HISTORY_WINDOW = timedelta(days=14)
PRICE_GAP_RATIO = 1.05
HOT_ZONE_RADIUS_KM = 3.0
HOT_ZONE_MIN_PINS = 3
STATUS_RANK = {"out_of_stock": 0, "price_gap": 1, "stale": 2, "in_stock": 3}
UNAVAILABLE_REASON = "unavailable"


@dataclass(frozen=True)
class PinPoint:
    pincode: str
    lat: float
    lng: float
    status: str


def snapshot_cutoff(snapshot: str, now: datetime | None = None) -> datetime:
    if snapshot not in SNAPSHOT_OFFSETS:
        raise ValueError(f"Unknown snapshot: {snapshot}")
    base = now if now is not None else datetime.now(UTC)
    return base - SNAPSHOT_OFFSETS[snapshot]


def classify_pin_status(
    seller_status: str | None,
    seller_in_stock: bool | None,
    seller_price: float | None,
    seller_checked_at: datetime | None,
    rival_price: float | None,
    cutoff: datetime,
) -> str:
    if seller_status is None or seller_checked_at is None:
        return "stale"
    if seller_status != "ok" or seller_checked_at < cutoff - STALE_AFTER:
        return "stale"
    if seller_in_stock is False:
        return "out_of_stock"
    if (
        seller_price is not None
        and rival_price is not None
        and seller_price >= PRICE_GAP_RATIO * rival_price
    ):
        return "price_gap"
    return "in_stock"


def stale_reason(
    seller_status: str | None, seller_checked_at: datetime | None, cutoff: datetime
) -> str | None:
    """Why a cell is stale ("missing", "failed", "old"), or None when it is fresh."""
    if seller_status is None or seller_checked_at is None:
        return "missing"
    if seller_status != "ok":
        return "failed"
    if seller_checked_at < cutoff - STALE_AFTER:
        return "old"
    return None


def cheapest_fresh_rivals(
    rival_latest: dict[tuple, CheckResult], cutoff: datetime
) -> dict[tuple[str, str], float]:
    """Cheapest in-stock rival price per (platform, pincode) within the freshness window."""
    cheapest: dict[tuple[str, str], float] = {}
    for (_competitor_id, platform, pincode), row in rival_latest.items():
        if (
            row.status != "ok"
            or row.in_stock is not True
            or row.price is None
            or row.checked_at < cutoff - STALE_AFTER
        ):
            continue
        key = (platform, pincode)
        current = cheapest.get(key)
        if current is None or row.price < current:
            cheapest[key] = row.price
    return cheapest


def find_hot_zones(pins: Sequence[PinPoint]) -> list[dict]:
    candidates = sorted(
        (pin for pin in pins if pin.status == "out_of_stock"),
        key=lambda pin: pin.pincode,
    )
    claimed: set[str] = set()
    zones: list[dict] = []
    for pin in candidates:
        if pin.pincode in claimed:
            continue
        members = [
            other
            for other in candidates
            if other.pincode not in claimed
            and haversine_km(pin.lat, pin.lng, other.lat, other.lng)
            <= HOT_ZONE_RADIUS_KM
        ]
        if len(members) < HOT_ZONE_MIN_PINS:
            continue
        claimed.update(member.pincode for member in members)
        zones.append(
            {
                "lat": round(sum(m.lat for m in members) / len(members), 6),
                "lng": round(sum(m.lng for m in members) / len(members), 6),
                "count": len(members),
                "pincodes": sorted(member.pincode for member in members),
            }
        )
    return zones


RowT = TypeVar("RowT")


def take_latest(rows: list[RowT], key_fn: Callable[[RowT], tuple]) -> dict[tuple, RowT]:
    """First row per key wins; callers must order rows by checked_at desc."""
    latest: dict[tuple, RowT] = {}
    for row in rows:
        key = key_fn(row)
        if key not in latest:
            latest[key] = row
    return latest


async def selected_pairs(
    session: AsyncSession, product_id: str, platform: str | None = None
) -> dict[str, set[str]]:
    """Map pincode -> set of selected platforms for a product."""
    statement = select(ProductPincode).where(ProductPincode.product_id == product_id)
    if platform is not None:
        statement = statement.where(ProductPincode.platform == platform)
    pairs: dict[str, set[str]] = {}
    for row in (await session.scalars(statement)).all():
        pairs.setdefault(row.pincode, set()).add(row.platform)
    return pairs


def mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


async def _seller_rows(
    session: AsyncSession,
    product_id: str,
    pincodes: list[str],
    platforms: list[str],
    cutoff: datetime,
) -> list[CheckResult]:
    return list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_(None),
                    CheckResult.pincode.in_(pincodes),
                    CheckResult.platform.in_(platforms),
                    CheckResult.checked_at <= cutoff,
                    CheckResult.checked_at >= cutoff - HISTORY_WINDOW,
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )


async def _rival_rows(
    session: AsyncSession,
    product_id: str,
    pincodes: list[str],
    platforms: list[str],
    cutoff: datetime,
) -> list[CheckResult]:
    return list(
        (
            await session.scalars(
                select(CheckResult)
                .where(
                    CheckResult.product_id == product_id,
                    CheckResult.competitor_id.is_not(None),
                    CheckResult.pincode.in_(pincodes),
                    CheckResult.platform.in_(platforms),
                    CheckResult.checked_at <= cutoff,
                    CheckResult.checked_at >= cutoff - HISTORY_WINDOW,
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )


async def compute_heatmap(
    session: AsyncSession,
    product_id: str,
    *,
    platform: str | None = None,
    snapshot: str = "now",
    now: datetime | None = None,
) -> dict:
    cutoff = snapshot_cutoff(snapshot, now)
    pairs = await selected_pairs(session, product_id, platform)
    pincodes = sorted(pairs)
    empty = {
        "pins": [],
        "summary": {
            "in_stock": 0,
            "out_of_stock": 0,
            "price_gap": 0,
            "stale": 0,
            "failed": 0,
            "unavailable": 0,
            "total": 0,
        },
        "hot_zones": [],
        "platform": platform,
        "snapshot": snapshot,
        "unavailable_platforms": [],
    }
    if not pincodes:
        return empty
    platforms = sorted({item for items in pairs.values() for item in items})

    seller_latest = take_latest(
        await _seller_rows(session, product_id, pincodes, platforms, cutoff),
        lambda row: (row.platform, row.pincode),
    )
    rival_latest = take_latest(
        await _rival_rows(session, product_id, pincodes, platforms, cutoff),
        lambda row: (row.competitor_id, row.platform, row.pincode),
    )
    cheapest_rival = cheapest_fresh_rivals(rival_latest, cutoff)

    geo = {
        row.code: row
        for row in (
            await session.scalars(select(Pincode).where(Pincode.code.in_(pincodes)))
        ).all()
    }

    unavailable = set(skipped_platforms(get_settings(), platforms))
    pins: list[dict] = []
    for pincode in pincodes:
        cells: list[tuple[str, dict]] = []
        for cell_platform in sorted(pairs[pincode]):
            seller = seller_latest.get((cell_platform, pincode))
            rival_price = cheapest_rival.get((cell_platform, pincode))
            status = classify_pin_status(
                seller_status=seller.status if seller else None,
                seller_in_stock=seller.in_stock if seller else None,
                seller_price=seller.price if seller else None,
                seller_checked_at=seller.checked_at if seller else None,
                rival_price=rival_price,
                cutoff=cutoff,
            )
            # Live mode never checks this app: its cell is "not available",
            # not "stale", and must not drag the pin's aggregate status down.
            never_checked = status == "stale" and cell_platform in unavailable
            cells.append(
                (
                    cell_platform,
                    {
                        "status": status,
                        "never_checked": never_checked,
                        "stale_reason": UNAVAILABLE_REASON
                        if never_checked
                        else stale_reason(
                            seller.status if seller else None,
                            seller.checked_at if seller else None,
                            cutoff,
                        )
                        if status == "stale"
                        else None,
                        "price": seller.price if seller and seller.status == "ok" else None,
                        "mrp": seller.mrp if seller and seller.status == "ok" else None,
                        "eta": seller.eta_minutes if seller and seller.status == "ok" else None,
                        "rival_price": rival_price,
                        "checked_at": seller.checked_at if seller else None,
                    },
                )
            )
        checkable = [cell for cell in cells if not cell[1]["never_checked"]] or cells
        checkable.sort(key=lambda item: (STATUS_RANK[item[1]["status"]], item[0]))
        chosen_platform, chosen = checkable[0]
        pin = geo.get(pincode)
        pins.append(
            {
                "pincode": pincode,
                "area": pin.area_name if pin else None,
                "lat": pin.lat if pin else None,
                "lng": pin.lng if pin else None,
                "status": chosen["status"],
                "stale_reason": chosen["stale_reason"],
                "price": chosen["price"],
                "rival_price": chosen["rival_price"],
                "mrp": chosen["mrp"],
                "eta": chosen["eta"],
                "checked_at": chosen["checked_at"],
                "platform": chosen_platform,
            }
        )

    summary = {
        "in_stock": 0,
        "out_of_stock": 0,
        "price_gap": 0,
        "stale": 0,
        "failed": 0,
        "unavailable": 0,
        "total": 0,
    }
    for pin in pins:
        summary["total"] += 1
        if pin["stale_reason"] == UNAVAILABLE_REASON:
            # Grey on the map like stale, but counted apart: re-checking won't help.
            summary["unavailable"] += 1
            continue
        summary[pin["status"]] += 1
        if pin["stale_reason"] == "failed":
            summary["failed"] += 1
    hot_zone_points = [
        PinPoint(pin["pincode"], pin["lat"], pin["lng"], pin["status"])
        for pin in pins
        if pin["lat"] is not None and pin["lng"] is not None
    ]
    return {
        "pins": pins,
        "summary": summary,
        "hot_zones": find_hot_zones(hot_zone_points),
        "platform": platform,
        "snapshot": snapshot,
        "unavailable_platforms": unavailable_platform_notes(unavailable),
    }


def unavailable_platform_notes(platforms: set[str]) -> list[dict]:
    return [
        {"platform": item, "reason": unavailable_reason(item)}
        for item in sorted(platforms)
    ]


async def compute_pin_detail(
    session: AsyncSession,
    product_id: str,
    code: str,
    *,
    platform: str | None = None,
    now: datetime | None = None,
) -> dict | None:
    cutoff = now if now is not None else datetime.now(UTC)
    pin = await session.get(Pincode, code)
    if pin is None:
        return None
    pairs = await selected_pairs(session, product_id, platform)
    if code not in pairs:
        return None
    platforms = sorted(pairs[code])

    seller_latest = take_latest(
        await _seller_rows(session, product_id, [code], platforms, cutoff),
        lambda row: (row.platform, row.pincode),
    )
    rival_latest = take_latest(
        await _rival_rows(session, product_id, [code], platforms, cutoff),
        lambda row: (row.competitor_id, row.platform, row.pincode),
    )
    names = {
        row.id: row.name
        for row in (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    }
    cheapest = {
        platform_key: price
        for (platform_key, _pincode), price in cheapest_fresh_rivals(
            rival_latest, cutoff
        ).items()
    }
    rivals_by_platform: dict[str, list[dict]] = {item: [] for item in platforms}
    for (competitor_id, cell_platform, _), row in rival_latest.items():
        rivals_by_platform.setdefault(cell_platform, []).append(
            {
                "competitor_id": competitor_id,
                "name": names.get(competitor_id, "Competitor"),
                "in_stock": row.in_stock,
                "price": row.price,
                "mrp": row.mrp,
                "eta": row.eta_minutes,
                "rating": row.rating,
                "status": row.status,
                "checked_at": row.checked_at,
                "result_id": row.id,
                "run_id": row.run_id,
            }
        )

    settings = get_settings()
    unavailable = set(skipped_platforms(settings, platforms))
    platform_rows: list[dict] = []
    for cell_platform in platforms:
        seller = seller_latest.get((cell_platform, code))
        status = classify_pin_status(
            seller_status=seller.status if seller else None,
            seller_in_stock=seller.in_stock if seller else None,
            seller_price=seller.price if seller else None,
            seller_checked_at=seller.checked_at if seller else None,
            rival_price=cheapest.get(cell_platform),
            cutoff=cutoff,
        )
        rivals = sorted(
            rivals_by_platform.get(cell_platform, []),
            key=lambda item: (item["price"] is None, item["price"] or 0),
        )
        platform_rows.append(
            {
                "platform": cell_platform,
                "status": status,
                "unavailable_reason": unavailable_reason(cell_platform)
                if cell_platform in unavailable
                else None,
                "seller": {
                    "in_stock": seller.in_stock if seller else None,
                    "price": seller.price if seller else None,
                    "mrp": seller.mrp if seller else None,
                    "eta": seller.eta_minutes if seller else None,
                    "rating": seller.rating if seller else None,
                    "status": seller.status if seller else "missing",
                    "checked_at": seller.checked_at if seller else None,
                    "run_id": seller.run_id if seller else None,
                    "result_id": seller.id if seller else None,
                    "screenshot_url": screenshot_url_for(
                        seller.id, seller.screenshot_url, settings
                    )
                    if seller
                    else None,
                },
                "rivals": rivals,
            }
        )
    return {
        "pincode": code,
        "area": pin.area_name,
        "city": pin.city,
        "lat": pin.lat,
        "lng": pin.lng,
        "platforms": platform_rows,
    }
