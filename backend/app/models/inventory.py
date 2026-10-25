"""Seller inventory: warehouses / dark stores and stock held per product.

The quantities are demo data today (see services/inventory.py) but the
schema matches what a marketplace inventory report carries, so a real feed
can replace the seeding later without touching the API.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow

WAREHOUSE_PLATFORMS = ("blinkit", "zepto", "instamart", "amazon", "flipkart", "own")
WAREHOUSE_KINDS = ("dark_store", "fulfilment_centre", "own_warehouse")
INVENTORY_REASONS = ("sale", "restock", "set", "simulated_sale", "seed")


class Warehouse(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "warehouses"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_warehouses_user_name"),
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    platform: Mapped[str] = mapped_column(String(16))
    kind: Mapped[str] = mapped_column(String(32))
    city: Mapped[str] = mapped_column(String(100))
    pincode: Mapped[str | None] = mapped_column(String(12), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class InventoryItem(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "inventory_items"
    __table_args__ = (
        UniqueConstraint(
            "product_id", "warehouse_id", name="uq_inventory_items_product_warehouse"
        ),
        CheckConstraint("quantity >= 0", name="ck_inventory_items_quantity_nonneg"),
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    warehouse_id: Mapped[str] = mapped_column(
        ForeignKey("warehouses.id", ondelete="CASCADE"), index=True
    )
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    low_stock_threshold: Mapped[int] = mapped_column(Integer, default=10)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class InventoryEvent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "inventory_events"
    item_id: Mapped[str] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="CASCADE"), index=True
    )
    delta: Mapped[int] = mapped_column(Integer)
    quantity_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, index=True
    )
