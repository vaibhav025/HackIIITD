from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, UTCDateTime, UUIDPrimaryKeyMixin, utcnow


class TelegramLinkCode(Base):
    __tablename__ = "telegram_link_codes"
    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    chat_type: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )


class TelegramLink(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "telegram_links"
    __table_args__ = (
        UniqueConstraint("product_id", "chat_id", name="uq_telegram_links_product_chat"),
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    chat_id: Mapped[str] = mapped_column(String(100), index=True)
    chat_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Telegram user who redeemed the code; in groups only they may approve actions.
    linked_by_telegram_user_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    alert_types: Mapped[list] = mapped_column(JSON, default=list)
    briefing_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    # Local (user timezone) YYYY-MM-DD of the last briefing sent to this chat.
    last_briefing_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    connected_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow
    )


class TelegramLinkAttempt(UUIDPrimaryKeyMixin, Base):
    """A failed `/start <code>` redemption, used to rate-limit guessing per chat."""

    __tablename__ = "telegram_link_attempts"
    chat_id: Mapped[str] = mapped_column(String(64), index=True)
    attempted_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, index=True
    )
