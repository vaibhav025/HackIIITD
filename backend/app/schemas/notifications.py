"""Schemas for alerts, Telegram linking, and notifications."""

from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from .common import AlertKind, ClockTime, PatchModel

# Alert kinds plus the two non-alert message streams a chat can opt into.
TelegramAlertType = AlertKind | Literal["recommendations", "briefing"]


class AlertResponse(BaseModel):
    id: str
    product_id: str
    product_name: str | None = None
    kind: str
    message: str
    evidence: dict = Field(default_factory=dict)
    read: bool
    sent_telegram: bool
    created_at: datetime


class AlertListResponse(BaseModel):
    items: list[AlertResponse]
    unread: int = 0


class MarkReadResponse(BaseModel):
    marked: int


class LinkCodeRequest(BaseModel):
    chat_type: Literal["personal", "group"] = "personal"


class LinkCodeResponse(BaseModel):
    code: str
    # `https://t.me/<bot>?start=<code>` when the bot username is known.
    deep_link: str | None
    command: str
    expires_at: datetime
    product_id: str


class TelegramChatLink(BaseModel):
    id: str
    chat_id: str
    chat_title: str | None = None
    # None = every alert kind and stream; [] = nothing; otherwise exactly these.
    alert_types: list[str] | None = None
    briefing_time: str | None = None
    connected_at: datetime


class TelegramStatusResponse(BaseModel):
    status: Literal["not_connected", "waiting", "connected"]
    chat_title: str | None = None
    enabled: bool
    bot_running: bool
    bot_username: str | None = None
    # Demo only: no bot token and not production, so the UI may fake `/start`.
    simulate_available: bool = False
    links: list[TelegramChatLink] = Field(default_factory=list)


class TelegramLinkUpdate(PatchModel):
    nullable_fields: ClassVar[frozenset[str]] = frozenset({"briefing_time", "alert_types"})

    # null = everything (including kinds added later); [] = nothing.
    alert_types: list[TelegramAlertType] | None = Field(default=None, max_length=20)
    briefing_time: ClockTime | None = None


class TelegramTestResponse(BaseModel):
    sent: bool
    chat_id: str | None = None
    message: str
