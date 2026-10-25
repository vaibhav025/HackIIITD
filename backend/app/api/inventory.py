"""My Inventory: per-warehouse stock for every product, with stock-out alerts.

The stock is demo data (see services/inventory.py). Every route is scoped to
the signed-in seller: another seller's line answers 404.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.inventory import InventoryEvent, InventoryItem, Warehouse
from ..models.product import Product
from ..models.user import User
from ..schemas.inventory import (
    InventoryAlertOut,
    InventoryChangeOut,
    InventoryEventOut,
    InventoryItemOut,
    InventoryMutationResponse,
    InventoryProductOut,
    InventoryResponse,
    InventorySummary,
    ResetResponse,
    RestockRequest,
    SellRequest,
    SetQuantityRequest,
    SimulateSalesResponse,
    TelegramDeliveryOut,
    WarehouseOut,
)
from ..services import telegram as telegram_service
from ..services.inventory import (
    StockChange,
    apply_stock_change,
    ensure_inventory,
    owned_item,
    reset_inventory,
    simulate_sales,
    stock_status,
    warehouse_label,
)

router = APIRouter(tags=["inventory"])

RECENT_EVENTS = 20
PLATFORM_ORDER = {
    "blinkit": 0,
    "zepto": 1,
    "instamart": 2,
    "amazon": 3,
    "flipkart": 4,
    "own": 5,
}


def _item_out(item: InventoryItem, warehouse: Warehouse, product: Product) -> InventoryItemOut:
    return InventoryItemOut(
        item_id=item.id,
        product_id=product.id,
        product_name=product.name,
        warehouse=WarehouseOut(
            id=warehouse.id,
            name=warehouse.name,
            platform=warehouse.platform,
            kind=warehouse.kind,
            city=warehouse.city,
            pincode=warehouse.pincode,
        ),
        quantity=item.quantity,
        low_stock_threshold=item.low_stock_threshold,
        status=stock_status(item.quantity, item.low_stock_threshold),
        updated_at=item.updated_at,
    )


def _alerts_out(changes: list[StockChange]) -> tuple[list[InventoryAlertOut], TelegramDeliveryOut]:
    alerts: list[InventoryAlertOut] = []
    total = TelegramDeliveryOut(bot_running=telegram_service.bot_is_running())
    for change in changes:
        for alert, delivery in change.alerts:
            telegram = TelegramDeliveryOut(**delivery.as_dict())
            alerts.append(
                InventoryAlertOut(
                    id=alert.id,
                    kind=alert.kind,
                    message=alert.message,
                    product_id=change.product.id,
                    product_name=change.product.name,
                    item_id=change.item.id,
                    warehouse_name=warehouse_label(change.warehouse),
                    quantity=change.item.quantity,
                    created_at=alert.created_at,
                    telegram=telegram,
                )
            )
            total.sent += telegram.sent
            total.linked = max(total.linked, telegram.linked)
            total.skipped = total.skipped or telegram.skipped
    return alerts, total


def _mutation_response(change: StockChange) -> InventoryMutationResponse:
    alerts, telegram = _alerts_out([change])
    return InventoryMutationResponse(
        item=_item_out(change.item, change.warehouse, change.product),
        alerts=alerts,
        telegram=telegram,
    )


async def _owned_or_404(
    session: AsyncSession, user: User, item_id: str
) -> tuple[InventoryItem, Warehouse, Product]:
    row = await owned_item(session, user.id, item_id, lock=True)
    if row is None:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return row


@router.get("/inventory", response_model=InventoryResponse)
async def get_inventory(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> InventoryResponse:
    await ensure_inventory(session, user)
    rows = (
        await session.execute(
            select(InventoryItem, Warehouse, Product)
            .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
            .join(Product, Product.id == InventoryItem.product_id)
            .where(Warehouse.user_id == user.id, Product.user_id == user.id)
            .order_by(Product.created_at, Product.name)
        )
    ).all()
    by_product: dict[str, InventoryProductOut] = {}
    warehouse_ids: set[str] = set()
    summary = InventorySummary(products=0, warehouses=0, units=0, out_of_stock=0, low_stock=0)
    for item, warehouse, product in rows:
        out = _item_out(item, warehouse, product)
        group = by_product.get(product.id)
        if group is None:
            group = by_product[product.id] = InventoryProductOut(
                product_id=product.id,
                name=product.name,
                brand=product.brand,
                image_url=product.image_url,
                total_units=0,
                warehouses=[],
            )
        group.warehouses.append(out)
        group.total_units += item.quantity
        warehouse_ids.add(warehouse.id)
        summary.units += item.quantity
        if out.status == "out_of_stock":
            summary.out_of_stock += 1
        elif out.status == "low":
            summary.low_stock += 1
    for group in by_product.values():
        group.warehouses.sort(
            key=lambda line: (
                PLATFORM_ORDER.get(line.warehouse.platform, 9),
                line.warehouse.name,
            )
        )
    summary.products = len(by_product)
    summary.warehouses = len(warehouse_ids)

    event_rows = (
        await session.execute(
            select(InventoryEvent, InventoryItem, Warehouse, Product)
            .join(InventoryItem, InventoryItem.id == InventoryEvent.item_id)
            .join(Warehouse, Warehouse.id == InventoryItem.warehouse_id)
            .join(Product, Product.id == InventoryItem.product_id)
            .where(
                Warehouse.user_id == user.id,
                Product.user_id == user.id,
                InventoryEvent.reason != "seed",
            )
            .order_by(InventoryEvent.created_at.desc())
            .limit(RECENT_EVENTS)
        )
    ).all()
    recent = [
        InventoryEventOut(
            id=event.id,
            item_id=item.id,
            product_id=product.id,
            product_name=product.name,
            warehouse_name=warehouse_label(warehouse),
            warehouse_platform=warehouse.platform,
            delta=event.delta,
            quantity_after=event.quantity_after,
            reason=event.reason,
            created_at=event.created_at,
        )
        for event, item, warehouse, product in event_rows
    ]
    return InventoryResponse(
        summary=summary, products=list(by_product.values()), recent_events=recent
    )


@router.post("/inventory/items/{item_id}/sell", response_model=InventoryMutationResponse)
async def sell_item(
    item_id: str,
    payload: SellRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> InventoryMutationResponse:
    units = payload.units if payload else 1
    item, warehouse, product = await _owned_or_404(session, user, item_id)
    if item.quantity <= 0:
        raise HTTPException(status_code=409, detail="Already out of stock here")
    change = await apply_stock_change(
        session, user, item, warehouse, product, item.quantity - units, "sale"
    )
    return _mutation_response(change)


@router.post("/inventory/items/{item_id}/restock", response_model=InventoryMutationResponse)
async def restock_item(
    item_id: str,
    payload: RestockRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> InventoryMutationResponse:
    item, warehouse, product = await _owned_or_404(session, user, item_id)
    change = await apply_stock_change(
        session, user, item, warehouse, product, item.quantity + payload.units, "restock"
    )
    return _mutation_response(change)


@router.put("/inventory/items/{item_id}", response_model=InventoryMutationResponse)
async def set_item(
    item_id: str,
    payload: SetQuantityRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> InventoryMutationResponse:
    """Set the quantity outright; ``{"quantity": 0}`` is the "zero it" path."""
    item, warehouse, product = await _owned_or_404(session, user, item_id)
    change = await apply_stock_change(
        session,
        user,
        item,
        warehouse,
        product,
        payload.quantity,
        "set",
        threshold=payload.low_stock_threshold,
    )
    return _mutation_response(change)


@router.post("/inventory/simulate-sales", response_model=SimulateSalesResponse)
async def post_simulate_sales(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> SimulateSalesResponse:
    """Demo "live orders": a few random sales at in-stock lines."""
    await ensure_inventory(session, user)
    changes = await simulate_sales(session, user)
    alerts, telegram = _alerts_out(changes)
    return SimulateSalesResponse(
        changes=[
            InventoryChangeOut(
                item=_item_out(change.item, change.warehouse, change.product),
                previous_quantity=change.previous,
                delta=change.event.delta,
                reason=change.event.reason,
            )
            for change in changes
        ],
        alerts=alerts,
        telegram=telegram,
    )


@router.post("/inventory/reset", response_model=ResetResponse)
async def post_reset(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ResetResponse:
    """Put every line back to its demo quantity (clears the activity log)."""
    return ResetResponse(items=await reset_inventory(session, user))
