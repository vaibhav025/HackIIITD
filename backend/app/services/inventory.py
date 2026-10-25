"""Seller inventory: demo warehouses, stock changes and stock-out alerts.

ShelfSense is not connected to any marketplace inventory feed yet, so every
seller gets a realistic *demo* inventory: the dark stores / fulfilment centres
a quick-commerce or marketplace seller would hold stock in, created on first
load for the platforms their products are tracked on, with plausible
quantities. The seller can then sell, restock or zero any line, and every
change is recorded as an ``InventoryEvent``.

Alerts
------
When a line drops from >0 to 0 an ``inventory_out`` Alert is created and
pushed to the product's linked Telegram chats *immediately* (not on the
scheduler). Stock-outs are critical, so they ignore quiet hours and the
seller's Telegram channel switch; a chat that unticked ``inventory_out`` in
its per-chat alert types still does not get it (``link_wants``). Crossing the
low-stock threshold downward creates a lower-priority ``inventory_low`` alert
that follows the normal rules (channel switch, quiet hours, deferred retry).
"""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.base import utcnow
from ..models.intelligence import Alert
from ..models.inventory import InventoryEvent, InventoryItem, Warehouse
from ..models.product import Pincode, Product, ProductListing, ProductPincode
from ..models.telegram import TelegramLink
from ..models.user import User, UserSettings
from .alerts import _within_quiet_hours, link_wants, telegram_allowed

logger = logging.getLogger("shelfsense.inventory")

INVENTORY_OUT = "inventory_out"
INVENTORY_LOW = "inventory_low"
INVENTORY_ALERT_KINDS = (INVENTORY_OUT, INVENTORY_LOW)
DEFAULT_LOW_STOCK_THRESHOLD = 10

QUICK_COMMERCE = ("blinkit", "zepto", "instamart")
MARKETPLACES = ("amazon", "flipkart")
# Platforms used when none of the seller's products names one yet.
DEFAULT_PLATFORMS = QUICK_COMMERCE
# Delhi NCR pincodes used when the seller tracks too few of their own.
FALLBACK_PINCODES = ("110017", "110048", "110024", "110016", "110019")

PLATFORM_LABEL = {
    "blinkit": "Blinkit",
    "zepto": "Zepto",
    "instamart": "Instamart",
    "amazon": "Amazon",
    "flipkart": "Flipkart",
    "own": "Own",
}


# ---------------------------------------------------------------- seeding


async def _product_platforms(
    session: AsyncSession, product_ids: list[str]
) -> dict[str, set[str]]:
    platforms: dict[str, set[str]] = {product_id: set() for product_id in product_ids}
    if not product_ids:
        return platforms
    for product_id, platform in (
        await session.execute(
            select(ProductPincode.product_id, ProductPincode.platform).where(
                ProductPincode.product_id.in_(product_ids)
            )
        )
    ).all():
        platforms[product_id].add(platform)
    for product_id, platform in (
        await session.execute(
            select(ProductListing.product_id, ProductListing.platform).where(
                ProductListing.product_id.in_(product_ids)
            )
        )
    ).all():
        platforms[product_id].add(platform)
    return platforms


async def _tracked_pincodes(
    session: AsyncSession, product_ids: list[str]
) -> list[tuple[str, str]]:
    """(platform, pincode) pairs the seller tracks, most used first."""
    if not product_ids:
        return []
    counts: dict[tuple[str, str], int] = {}
    for platform, pincode in (
        await session.execute(
            select(ProductPincode.platform, ProductPincode.pincode).where(
                ProductPincode.product_id.in_(product_ids)
            )
        )
    ).all():
        counts[(platform, pincode)] = counts.get((platform, pincode), 0) + 1
    return sorted(counts, key=lambda pair: (-counts[pair], pair[1]))


def _warehouse_blueprints(
    platforms: set[str],
    tracked: list[tuple[str, str]],
    places: dict[str, tuple[str, str]],
) -> list[dict]:
    """Warehouses a seller on these platforms would plausibly stock."""
    used: set[str] = set()

    def pick_pins(platform: str, count: int) -> list[str]:
        own = [pin for plat, pin in tracked if plat == platform]
        other = [pin for _plat, pin in tracked]
        chosen: list[str] = []
        for pin in [*own, *other, *FALLBACK_PINCODES]:
            if pin in places and pin not in used and pin not in chosen:
                chosen.append(pin)
            if len(chosen) == count:
                break
        used.update(chosen)
        return chosen

    blueprints: list[dict] = []
    dark_store_counts = {"blinkit": 3, "zepto": 1, "instamart": 1}
    for platform in QUICK_COMMERCE:
        if platform not in platforms:
            continue
        for pin in pick_pins(platform, dark_store_counts[platform]):
            area, city = places[pin]
            blueprints.append(
                {
                    "name": f"{PLATFORM_LABEL[platform]} dark store · {area}",
                    "platform": platform,
                    "kind": "dark_store",
                    "city": city,
                    "pincode": pin,
                }
            )
    if "amazon" in platforms:
        blueprints.append(
            {
                "name": "Amazon FC · Gurugram (DEL4)",
                "platform": "amazon",
                "kind": "fulfilment_centre",
                "city": "Gurugram",
                "pincode": "122503",
            }
        )
    if "flipkart" in platforms:
        blueprints.append(
            {
                "name": "Flipkart FC · Bilaspur, Gurugram",
                "platform": "flipkart",
                "kind": "fulfilment_centre",
                "city": "Gurugram",
                "pincode": "122413",
            }
        )
    blueprints.append(
        {
            "name": "Own warehouse · Okhla",
            "platform": "own",
            "kind": "own_warehouse",
            "city": "Delhi",
            "pincode": "110020",
        }
    )
    return blueprints


def seed_quantity(product_id: str, warehouse_name: str) -> int:
    """Deterministic demo stock: mostly 20–120 units, about one line in six low."""
    rng = random.Random(f"{product_id}:{warehouse_name}")
    quantity = rng.randint(20, 120)
    if rng.random() < 0.18:
        quantity = rng.randint(4, 9)
    return quantity


def _wanted_warehouses(
    product_platforms: set[str], warehouses: list[Warehouse]
) -> list[Warehouse]:
    if not product_platforms:
        return warehouses
    return [
        warehouse
        for warehouse in warehouses
        if warehouse.platform == "own" or warehouse.platform in product_platforms
    ]


async def ensure_inventory(session: AsyncSession, user: User) -> None:
    """Idempotently create the seller's demo warehouses and stock lines.

    Warehouses for a platform are created the first time any of the seller's
    products is tracked there; every product gets a stock line in each
    warehouse of its platforms (plus the seller's own warehouse). Products
    added later get their lines on the next call.
    """
    try:
        await _ensure_inventory(session, user)
    except IntegrityError:
        # A concurrent request created the same rows first; theirs win.
        await session.rollback()
        if user in session:
            await session.refresh(user)


async def _ensure_inventory(session: AsyncSession, user: User) -> None:
    products = list(
        (
            await session.scalars(
                select(Product)
                .where(Product.user_id == user.id)
                .order_by(Product.created_at)
            )
        ).all()
    )
    if not products:
        return
    product_ids = [product.id for product in products]
    platforms_by_product = await _product_platforms(session, product_ids)
    all_platforms = set().union(*platforms_by_product.values()) or set(DEFAULT_PLATFORMS)

    warehouses = list(
        (
            await session.scalars(
                select(Warehouse)
                .where(Warehouse.user_id == user.id)
                .order_by(Warehouse.created_at, Warehouse.name)
            )
        ).all()
    )
    have_platforms = {warehouse.platform for warehouse in warehouses}
    missing = (all_platforms | {"own"}) - have_platforms
    if missing:
        tracked = await _tracked_pincodes(session, product_ids)
        # Avoid reusing pincodes already taken by existing dark stores.
        taken = {warehouse.pincode for warehouse in warehouses if warehouse.pincode}
        tracked = [pair for pair in tracked if pair[1] not in taken]
        places = {
            row.code: (row.area_name, row.city)
            for row in (await session.scalars(select(Pincode))).all()
            if row.code not in taken
        }
        for blueprint in _warehouse_blueprints(missing, tracked, places):
            if blueprint["platform"] not in missing:
                continue
            warehouse = Warehouse(user_id=user.id, **blueprint)
            session.add(warehouse)
            warehouses.append(warehouse)
        await session.flush()

    existing = {
        (row.product_id, row.warehouse_id)
        for row in (
            await session.scalars(
                select(InventoryItem).where(InventoryItem.product_id.in_(product_ids))
            )
        ).all()
    }
    now = utcnow()
    created = False
    for product in products:
        for warehouse in _wanted_warehouses(
            platforms_by_product.get(product.id, set()), warehouses
        ):
            if (product.id, warehouse.id) in existing:
                continue
            quantity = seed_quantity(product.id, warehouse.name)
            item = InventoryItem(
                product_id=product.id,
                warehouse_id=warehouse.id,
                quantity=quantity,
                low_stock_threshold=DEFAULT_LOW_STOCK_THRESHOLD,
                updated_at=now,
            )
            session.add(item)
            await session.flush()
            session.add(
                InventoryEvent(
                    item_id=item.id,
                    delta=quantity,
                    quantity_after=quantity,
                    reason="seed",
                    created_at=now,
                )
            )
            created = True
    if missing or created:
        await session.commit()


async def reset_inventory(session: AsyncSession, user: User) -> int:
    """Put every stock line back to its demo quantity; returns lines reset."""
    await ensure_inventory(session, user)
    rows = (
        await session.execute(
            select(InventoryItem, Warehouse)
            .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
            .where(Warehouse.user_id == user.id)
        )
    ).all()
    item_ids = [item.id for item, _warehouse in rows]
    if item_ids:
        await session.execute(
            delete(InventoryEvent).where(InventoryEvent.item_id.in_(item_ids))
        )
    now = utcnow()
    for item, warehouse in rows:
        item.quantity = seed_quantity(item.product_id, warehouse.name)
        item.low_stock_threshold = DEFAULT_LOW_STOCK_THRESHOLD
        item.updated_at = now
        session.add(
            InventoryEvent(
                item_id=item.id,
                delta=item.quantity,
                quantity_after=item.quantity,
                reason="seed",
                created_at=now,
            )
        )
    await session.commit()
    return len(rows)


# ---------------------------------------------------------------- lookups


def stock_status(quantity: int, threshold: int) -> str:
    if quantity <= 0:
        return "out_of_stock"
    if quantity <= threshold:
        return "low"
    return "in_stock"


def warehouse_label(warehouse: Warehouse) -> str:
    """"Blinkit dark store · Saket (110017)"; FCs already carry their code."""
    if warehouse.kind == "dark_store" and warehouse.pincode:
        return f"{warehouse.name} ({warehouse.pincode})"
    return warehouse.name


async def owned_item(
    session: AsyncSession, user_id: str, item_id: str, *, lock: bool = False
) -> tuple[InventoryItem, Warehouse, Product] | None:
    statement = (
        select(InventoryItem, Warehouse, Product)
        .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
        .join(Product, Product.id == InventoryItem.product_id)
        .where(
            InventoryItem.id == item_id,
            Warehouse.user_id == user_id,
            Product.user_id == user_id,
        )
    )
    if lock:
        statement = statement.with_for_update(of=InventoryItem)
    row = (await session.execute(statement)).first()
    return (row[0], row[1], row[2]) if row else None


# ---------------------------------------------------------------- changes


@dataclass
class TelegramDelivery:
    sent: int = 0
    linked: int = 0
    bot_running: bool = False
    skipped: str | None = None

    def as_dict(self) -> dict:
        return {
            "sent": self.sent,
            "linked": self.linked,
            "bot_running": self.bot_running,
            "skipped": self.skipped,
        }


@dataclass
class StockChange:
    item: InventoryItem
    warehouse: Warehouse
    product: Product
    previous: int
    event: InventoryEvent
    alerts: list[tuple[Alert, TelegramDelivery]] = field(default_factory=list)


def _alert_text(kind: str, product: Product, warehouse: Warehouse, quantity: int) -> str:
    where = warehouse_label(warehouse)
    if kind == INVENTORY_OUT:
        return (
            f"🚨 Out of stock: {product.name} is at 0 units at {where}. Restock now."
        )
    unit = "unit" if quantity == 1 else "units"
    return (
        f"⚠️ Low stock: {product.name} is down to {quantity} {unit} at {where}. "
        "Reorder soon."
    )


def telegram_text(alert: Alert) -> str:
    return f"{alert.message}\n\n— ShelfSense · My Inventory"


async def deliver_inventory_alert(
    session: AsyncSession, alert: Alert, user: User
) -> TelegramDelivery:
    """Push one inventory alert to the product's linked chats right now.

    ``inventory_out`` always goes out: a stock-out is critical, so it ignores
    quiet hours *and* the seller's Telegram channel switch (only a chat that
    explicitly unticked "inventory_out" is skipped). ``inventory_low`` follows
    the normal alert rules; when held back by quiet hours it stays unsent and
    ``deliver_deferred_alerts`` retries it later.
    """
    from .telegram import bot_is_running, send_telegram_message

    delivery = TelegramDelivery(bot_running=bot_is_running())
    links = [
        link
        for link in (
            await session.scalars(
                select(TelegramLink).where(
                    TelegramLink.product_id == alert.product_id,
                    TelegramLink.user_id == user.id,
                )
            )
        ).all()
        if link_wants(link, alert.kind)
    ]
    delivery.linked = len(links)
    if not links:
        return delivery
    if alert.kind != INVENTORY_OUT:
        user_settings = await session.get(UserSettings, user.id)
        if not telegram_allowed(user_settings):
            delivery.skipped = "telegram_off"
            return delivery
        try:
            local_now = datetime.now(ZoneInfo(user.timezone))
        except (ZoneInfoNotFoundError, ValueError):
            local_now = datetime.now(UTC)
        if _within_quiet_hours(user_settings, local_now):
            delivery.skipped = "quiet_hours"
            return delivery
    text = telegram_text(alert)
    results = await asyncio.gather(
        *(send_telegram_message(link.chat_id, text) for link in links)
    )
    delivery.sent = sum(1 for ok in results if ok)
    if delivery.sent:
        alert.sent_telegram = True
    return delivery


async def apply_stock_change(
    session: AsyncSession,
    user: User,
    item: InventoryItem,
    warehouse: Warehouse,
    product: Product,
    new_quantity: int,
    reason: str,
    *,
    threshold: int | None = None,
) -> StockChange:
    """Set a line's quantity, log the event, raise and deliver alerts, commit."""
    new_quantity = max(0, int(new_quantity))
    previous = item.quantity
    now = utcnow()
    item.quantity = new_quantity
    if threshold is not None:
        item.low_stock_threshold = threshold
    item.updated_at = now
    event = InventoryEvent(
        item_id=item.id,
        delta=new_quantity - previous,
        quantity_after=new_quantity,
        reason=reason,
        created_at=now,
    )
    session.add(event)
    await session.flush()

    kind: str | None = None
    if previous > 0 and new_quantity == 0:
        kind = INVENTORY_OUT
    elif previous > item.low_stock_threshold >= new_quantity > 0:
        kind = INVENTORY_LOW
    change = StockChange(item, warehouse, product, previous, event)
    if kind is not None:
        alert = Alert(
            user_id=user.id,
            product_id=product.id,
            kind=kind,
            message=_alert_text(kind, product, warehouse, new_quantity),
            evidence={
                "item_id": item.id,
                "warehouse_id": warehouse.id,
                "warehouse_name": warehouse_label(warehouse),
                "warehouse_platform": warehouse.platform,
                "warehouse_pincode": warehouse.pincode,
                "quantity": new_quantity,
                "previous_quantity": previous,
                "low_stock_threshold": item.low_stock_threshold,
            },
            # One alert per transition: the event id is unique.
            dedupe_key=f"{kind}:{item.id}:{event.id}",
            created_at=now,
        )
        session.add(alert)
        await session.commit()
        try:
            delivery = await deliver_inventory_alert(session, alert, user)
        except Exception:  # never lose the in-app alert over a delivery error
            logger.exception("inventory alert delivery failed alert=%s", alert.id)
            delivery = TelegramDelivery()
        change.alerts.append((alert, delivery))
        logger.info(
            "inventory %s product=%s warehouse=%s telegram sent=%s/%s",
            kind,
            product.id,
            warehouse.id,
            delivery.sent,
            delivery.linked,
        )
    await session.commit()
    return change


async def simulate_sales(
    session: AsyncSession, user: User, *, rng: random.Random | None = None
) -> list[StockChange]:
    """Demo "live orders": sell 1–3 units at a few in-stock lines.

    Lines already running low are picked more often so a judge watching the
    page sees a stock-out within a minute or two. Never goes below 0.
    """
    rng = rng or random.Random()
    rows = (
        await session.execute(
            select(InventoryItem, Warehouse, Product)
            .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
            .join(Product, Product.id == InventoryItem.product_id)
            .where(
                Warehouse.user_id == user.id,
                Product.user_id == user.id,
                InventoryItem.quantity > 0,
            )
        )
    ).all()
    if not rows:
        return []
    pool = list(rows)
    picks = []
    for _ in range(min(len(pool), rng.randint(2, 3))):
        weights = [1.0 + 30.0 / (row[0].quantity + 1) for row in pool]
        choice = rng.choices(range(len(pool)), weights=weights)[0]
        picks.append(pool.pop(choice))
    changes: list[StockChange] = []
    for item, warehouse, product in picks:
        units = min(item.quantity, rng.randint(1, 3))
        if units <= 0:
            continue
        changes.append(
            await apply_stock_change(
                session,
                user,
                item,
                warehouse,
                product,
                item.quantity - units,
                "simulated_sale",
            )
        )
    return changes
