"""Schemas for AI summaries, recommendations, and review insights."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class SummaryResponse(BaseModel):
    id: str
    product_id: str
    run_id: str | None = None
    summary_text: str
    evidence: dict = Field(default_factory=dict)
    source: str
    created_at: datetime


class RecommendationResponse(BaseModel):
    id: str
    product_id: str
    priority: str
    action_text: str
    impact_text: str
    evidence: dict = Field(default_factory=dict)
    status: str
    decided_via: str | None = None
    created_at: datetime
    decided_at: datetime | None = None


class RecommendationListResponse(BaseModel):
    items: list[RecommendationResponse]


class DecisionResponse(BaseModel):
    id: str
    status: str
    decided_via: str | None = None
    decided_at: datetime | None = None
    sent_to_chats: int = 0
    # Approve: "run_started" | "action_created". Send to Telegram:
    # telegram_status is "sent" | "failed" | "bot_offline" | "no_linked_chats".
    effect: str | None = None
    run_id: str | None = None
    action_item: str | None = None
    telegram_status: str | None = None
    # Human sentence describing what actually happened, for the toast.
    message: str | None = None


class GenerateResponse(BaseModel):
    source: str
    summary: SummaryResponse | None = None
    recommendations: list[RecommendationResponse] = Field(default_factory=list)
    superseded: int = 0
    expired: int = 0
    skipped_recent: int = 0
    auto_approved: int = 0
    # Why nothing new was created: no_check_data | limit_reached | no_change.
    reason: str | None = None
    # Why no price recommendation was made, e.g. "Price gap 3.1% is below
    # your 7% threshold"; None when one was made or there is no gap.
    price_note: str | None = None
    message: str = ""


class ActionItemResponse(RecommendationResponse):
    """An approved (open) or done recommendation on the seller's action list."""

    product_name: str | None = None
    kind: str
    action_item: str
    effect: str | None = None
    run_id: str | None = None
    target_price: float | None = None
    done_at: datetime | None = None


class ActionListResponse(BaseModel):
    open: list[ActionItemResponse] = Field(default_factory=list)
    done: list[ActionItemResponse] = Field(default_factory=list)


class ReviewItem(BaseModel):
    entity_id: str | None = None
    name: str
    loves: list[str] = Field(default_factory=list)
    complaints: list[str] = Field(default_factory=list)
    updated_at: datetime


class ReviewRefreshResponse(BaseModel):
    source: str
    loves: list[str] = Field(default_factory=list)
    complaints: list[str] = Field(default_factory=list)
    rival_loves: list[str] = Field(default_factory=list)
    rival_complaints: list[str] = Field(default_factory=list)
    items: list[ReviewItem] = Field(default_factory=list)
    changed: bool = False
    message: str = ""
