from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow


class User(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "users"
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    business_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    business_type: Mapped[str] = mapped_column(String(32), default="marketplace_seller")
    language: Mapped[str] = mapped_column(String(8), default="en")
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    default_city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class Subscription(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "subscriptions"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    plan: Mapped[str] = mapped_column(String(16), default="free")
    status: Mapped[str] = mapped_column(String(32), default="active")
    renews_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )


class UserSettings(Base):
    __tablename__ = "user_settings"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    briefing_time: Mapped[str] = mapped_column(String(5), default="09:00")
    quiet_hours_start: Mapped[str | None] = mapped_column(String(5), nullable=True)
    quiet_hours_end: Mapped[str | None] = mapped_column(String(5), nullable=True)
    default_thresholds: Mapped[dict] = mapped_column(JSON, default=dict)
    channels: Mapped[dict] = mapped_column(
        JSON, default=lambda: {"telegram": True, "email": False}
    )
