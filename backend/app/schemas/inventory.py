"""Schemas for the seller's "My Inventory" page."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

StockStatus = Literal["in_stock", "low", "out_of_stock"]


class WarehouseOut(BaseModel):
    id: str
    name: str
    platform: str
    kind: str
    city: str
    pincode: str | None = None


class InventoryItemOut(BaseModel):
    item_id: str
    product_id: str
    product_name: str
    warehouse: WarehouseOut
    quantity: int
    low_stock_threshold: int
    status: StockStatus
    updated_at: datetime


class InventoryProductOut(BaseModel):
    product_id: str
    name: str
    brand: str | None = None
    image_url: str | None = None
    total_units: int
    warehouses: list[InventoryItemOut]


class InventorySummary(BaseModel):
    products: int
    warehouses: int
    units: int
    out_of_stock: int
    low_stock: int


class InventoryEventOut(BaseModel):
    id: str
    item_id: str
    product_id: str
    product_name: str
    warehouse_name: str
    warehouse_platform: str
    delta: int
    quantity_after: int
    reason: str
    created_at: datetime


class TelegramDeliveryOut(BaseModel):
    sent: int = 0
    linked: int = 0
    bot_running: bool = False
    # "telegram_off" / "quiet_hours" when a low-stock alert was held back.
    skipped: str | None = None


class InventoryAlertOut(BaseModel):
    id: str
    kind: Literal["inventory_out", "inventory_low"]
    message: str
    product_id: str
    product_name: str
    item_id: str
    warehouse_name: str
    quantity: int
    created_at: datetime
    telegram: TelegramDeliveryOut


class InventoryResponse(BaseModel):
    summary: InventorySummary
    products: list[InventoryProductOut]
    recent_events: list[InventoryEventOut]


class InventoryChangeOut(BaseModel):
    item: InventoryItemOut
    previous_quantity: int
    delta: int
    reason: str


class InventoryMutationResponse(BaseModel):
    item: InventoryItemOut
    alerts: list[InventoryAlertOut] = Field(default_factory=list)
    telegram: TelegramDeliveryOut


class SimulateSalesResponse(BaseModel):
    changes: list[InventoryChangeOut]
    alerts: list[InventoryAlertOut] = Field(default_factory=list)
    telegram: TelegramDeliveryOut


class ResetResponse(BaseModel):
    items: int


class SellRequest(BaseModel):
    units: int = Field(default=1, ge=1, le=100_000)


class RestockRequest(BaseModel):
    units: int = Field(ge=1, le=100_000)


class SetQuantityRequest(BaseModel):
    quantity: int = Field(ge=0, le=1_000_000)
    low_stock_threshold: int | None = Field(default=None, ge=0, le=1_000_000)
