from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow

ACTIVE_RUN_CONDITION = text("status IN ('queued', 'running')")


class CheckRun(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "check_runs"
    # At most one queued/running run per product, enforced by the database so
    # concurrent manual and scheduled starts cannot both succeed.
    __table_args__ = (
        Index(
            "uq_check_runs_one_active_per_product",
            "product_id",
            unique=True,
            sqlite_where=ACTIVE_RUN_CONDITION,
            postgresql_where=ACTIVE_RUN_CONDITION,
        ),
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    trigger: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="queued")
    total_jobs: Mapped[int] = mapped_column(Integer, default=0)
    done_jobs: Mapped[int] = mapped_column(Integer, default=0)
    failed_jobs: Mapped[int] = mapped_column(Integer, default=0)
    credits_used: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )


class CheckResult(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "check_results"
    run_id: Mapped[str] = mapped_column(
        ForeignKey("check_runs.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    competitor_id: Mapped[str | None] = mapped_column(
        ForeignKey("competitors.id", ondelete="CASCADE"), nullable=True, index=True
    )
    platform: Mapped[str] = mapped_column(String(32), index=True)
    pincode: Mapped[str] = mapped_column(String(12), index=True)
    in_stock: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    price: Mapped[float | None] = mapped_column(Float, nullable=True)
    mrp: Mapped[float | None] = mapped_column(Float, nullable=True)
    eta_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    screenshot_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="ok")
    error: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    checked_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, index=True
    )


class ChangeEvent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "change_events"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    competitor_id: Mapped[str | None] = mapped_column(
        ForeignKey("competitors.id", ondelete="CASCADE"), nullable=True
    )
    platform: Mapped[str] = mapped_column(String(32))
    pincode: Mapped[str] = mapped_column(String(12))
    kind: Mapped[str] = mapped_column(String(32))
    old_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    new_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    detected_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class CreditLedger(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "credit_ledger"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("check_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    credits: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )
