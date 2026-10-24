from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, String, false
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow


class Product(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "products"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(300))
    brand: Mapped[str | None] = mapped_column(String(200), nullable=True)
    search_query: Mapped[str] = mapped_column(String(500))
    image_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    cost_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_margin_pct: Mapped[float] = mapped_column(Float, default=10.0)
    max_change_pct: Mapped[float] = mapped_column(Float, default=10.0)
    floor_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Smart price-recommendation threshold (see services/price_thresholds.py).
    commission_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    mrp: Mapped[float | None] = mapped_column(Float, nullable=True)
    # essential | regular | premium; NULL means "regular".
    price_sensitivity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    round_to_price_point: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True, default=False, server_default=false()
    )
    check_frequency: Mapped[str] = mapped_column(String(16), default="daily")
    volatile_boost: Mapped[bool] = mapped_column(Boolean, default=False)
    approval_required: Mapped[bool] = mapped_column(Boolean, default=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class ProductListing(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "product_listings"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    platform: Mapped[str] = mapped_column(String(32))
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)


class Competitor(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "competitors"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(300))
    platform: Mapped[str] = mapped_column(String(32))
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    search_query: Mapped[str | None] = mapped_column(String(500), nullable=True)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)


class Pincode(Base):
    __tablename__ = "pincodes"
    code: Mapped[str] = mapped_column(String(12), primary_key=True)
    area_name: Mapped[str] = mapped_column(String(200))
    city: Mapped[str] = mapped_column(String(100))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)


class ProductPincode(Base):
    __tablename__ = "product_pincodes"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    pincode: Mapped[str] = mapped_column(ForeignKey("pincodes.code"), primary_key=True)
    platform: Mapped[str] = mapped_column(String(32), primary_key=True)
