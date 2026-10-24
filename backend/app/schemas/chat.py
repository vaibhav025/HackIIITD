"""Schemas for chat conversations and help topics."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .common import optional_text, required_text

ConversationTitle = optional_text(300)
MessageText = required_text(2000)


class HelpTopic(BaseModel):
    slug: str
    title: str
    body: str


class HelpTopicListResponse(BaseModel):
    items: list[HelpTopic]


class ConversationCreate(BaseModel):
    title: ConversationTitle = None
    product_id: str | None = None


class ChatMessageOut(BaseModel):
    role: str
    content: str
    actions: list[dict] = Field(default_factory=list)
    evidence: list[dict] = Field(default_factory=list)
    created_at: datetime


class ConversationSummary(BaseModel):
    id: str
    title: str
    product_id: str | None = None
    created_at: datetime
    message_count: int = 0


class ConversationListResponse(BaseModel):
    items: list[ConversationSummary]


class ConversationDetail(BaseModel):
    id: str
    title: str
    product_id: str | None = None
    created_at: datetime
    messages: list[ChatMessageOut]


class MessageCreate(BaseModel):
    content: MessageText


class ChatRequest(BaseModel):
    message: MessageText
    conversation_id: str | None = None
    product_id: str | None = None


class ChatResponse(BaseModel):
    conversation_id: str
    answer: str
    actions: list[dict] = Field(default_factory=list)
    evidence: list[dict] = Field(default_factory=list)
    source: str


class MessageResponse(BaseModel):
    source: str
    reply: ChatMessageOut
    actions: list[dict] = Field(default_factory=list)
    evidence: list[dict] = Field(default_factory=list)
