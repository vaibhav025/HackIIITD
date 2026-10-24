from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow


class AISummary(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "ai_summaries"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("check_runs.id", ondelete="SET NULL"), nullable=True
    )
    summary_text: Mapped[str] = mapped_column(String(4000))
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class Recommendation(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "recommendations"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    priority: Mapped[str] = mapped_column(String(16))
    action_text: Mapped[str] = mapped_column(String(2000))
    impact_text: Mapped[str] = mapped_column(String(2000))
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    decided_via: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )


class ReviewInsight(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "review_insights"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    competitor_id: Mapped[str | None] = mapped_column(
        ForeignKey("competitors.id", ondelete="CASCADE"), nullable=True
    )
    loves: Mapped[list] = mapped_column(JSON, default=list)
    complaints: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class AlertRule(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "alert_rules"
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    rule_text: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    rule_json: Mapped[dict] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(default=True)


class Alert(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "alerts"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(String(2000))
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    dedupe_key: Mapped[str] = mapped_column(String(500), unique=True)
    sent_telegram: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )
    read: Mapped[bool] = mapped_column(default=False)
