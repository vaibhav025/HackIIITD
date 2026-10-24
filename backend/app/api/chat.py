"""Chat endpoints: conversations, messages, and the static help catalog."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.chat import ChatConversation, ChatMessage
from ..models.checks import CheckResult
from ..models.intelligence import Recommendation
from ..models.product import Competitor, Product
from ..models.user import Subscription, User
from ..schemas.chat import (
    ChatMessageOut,
    ChatRequest,
    ChatResponse,
    ConversationCreate,
    ConversationDetail,
    ConversationListResponse,
    ConversationSummary,
    HelpTopic,
    HelpTopicListResponse,
    MessageCreate,
    MessageResponse,
)
from ..services.ai import get_ai_provider, with_fallback
from ..services.ai.base import is_allowed_action_path
from ..services.heatmap import mean, selected_pairs
from ..services.help_topics import get_help_topic, list_help_topics
from ..services.insights import _latest_rival_rows, _latest_seller_rows
from ..services.intelligence import build_context
from ..services.plans import daily_credits_used, limits_for
from .products import get_owned_product

router = APIRouter(tags=["chat"])

MAX_MESSAGES_PER_CONVERSATION = 100
HISTORY_WINDOW = 20
# An unfocused chat is grounded in at most this many recently checked products.
UNFOCUSED_PRODUCT_LIMIT = 5
# Pending recommendations / approved actions quoted to the assistant.
RECOMMENDATION_PREVIEW = 5
APPROVED_PREVIEW = 3
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}
DEFAULT_TITLE = "New chat"

EMPTY_CONTEXT = {
    "product_id": None,
    "product_name": "your products",
    "avg_price": None,
    "cheapest_rival": None,
    "in_stock": None,
    "total_pins": None,
    "rating": None,
    "oos_pins": [],
    "oos_platforms": [],
    "price_gap_pins": 0,
    "stale_pins": 0,
    "hot_zone_count": 0,
    "this_week_avg_price": None,
    "last_week_avg_price": None,
    "recommendation_preview": "",
}


def safe_actions(actions: list[dict]) -> list[dict]:
    """Keep only in-app destinations (same rule the AI output schema enforces)."""
    return [
        action
        for action in actions
        if isinstance(action.get("path"), str) and is_allowed_action_path(action["path"])
    ]


def _title_from(message: str) -> str:
    first = " ".join(message.split())
    return first if len(first) <= 60 else first[:57].rstrip() + "…"


def _checkout_price(row: CheckResult) -> float | None:
    """True price at checkout (item + fees - offer) when the agent measured it."""
    agent = (row.raw or {}).get("agent")
    true_price = agent.get("true_price") if isinstance(agent, dict) else None
    final = true_price.get("final") if isinstance(true_price, dict) else None
    if isinstance(final, (int, float)) and not isinstance(final, bool):
        return float(final)
    return None


def _money(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


async def _platform_prices(session: AsyncSession, product_id: str) -> list[dict]:
    """Per-platform shelf and checkout price: yours (average) vs the cheapest rival.

    Built from the latest check per selected platform/pincode, the same cells
    the dashboard and heatmap use.
    """
    pairs = await selected_pairs(session, product_id)
    seller = [
        row
        for (platform, pincode), row in (
            await _latest_seller_rows(session, product_id)
        ).items()
        if platform in pairs.get(pincode, ())
    ]
    rivals = [
        row
        for (_competitor, platform, pincode), row in (
            await _latest_rival_rows(session, product_id)
        ).items()
        if platform in pairs.get(pincode, ())
    ]
    names = dict(
        (
            await session.execute(
                select(Competitor.id, Competitor.name).where(
                    Competitor.product_id == product_id
                )
            )
        ).all()
    )
    rows: list[dict] = []
    for platform in sorted({row.platform for row in [*seller, *rivals]}):
        mine = [row for row in seller if row.platform == platform and row.status == "ok"]
        listed = [row for row in mine if row.in_stock is True and row.price is not None]
        theirs = [
            row
            for row in rivals
            if row.platform == platform
            and row.status == "ok"
            and row.in_stock is True
            and row.price is not None
        ]
        cheapest = min(theirs, key=lambda row: row.price, default=None)
        my_checkouts = [
            price for row in listed if (price := _checkout_price(row)) is not None
        ]
        rival_checkouts = [
            price for row in theirs if (price := _checkout_price(row)) is not None
        ]
        rows.append(
            {
                "platform": platform,
                "pins_checked": len(mine),
                "pins_in_stock": len(listed),
                "oos_pins": sorted(row.pincode for row in mine if row.in_stock is False),
                "my_price": _money(mean([row.price for row in listed])),
                "my_checkout": _money(mean(my_checkouts)),
                "rival_price": _money(cheapest.price) if cheapest else None,
                "rival_name": names.get(cheapest.competitor_id) if cheapest else None,
                "rival_checkout": _money(min(rival_checkouts)) if rival_checkouts else None,
            }
        )
    return rows


async def _recommendation_context(
    session: AsyncSession, user_id: str, product_id: str | None
) -> dict:
    """Pending recommendations (highest priority first) and recently approved actions."""
    base = (
        select(Recommendation, Product.name)
        .join(Product, Product.id == Recommendation.product_id)
        .where(Product.user_id == user_id)
    )
    counted = (
        select(Recommendation.status, func.count(Recommendation.id))
        .join(Product, Product.id == Recommendation.product_id)
        .where(Product.user_id == user_id)
        .group_by(Recommendation.status)
    )
    if product_id is not None:
        base = base.where(Recommendation.product_id == product_id)
        counted = counted.where(Recommendation.product_id == product_id)
    counts = dict((await session.execute(counted)).all())
    pending = list(
        (
            await session.execute(
                base.where(Recommendation.status == "pending")
                .order_by(Recommendation.created_at.desc())
                .limit(50)
            )
        ).all()
    )
    pending.sort(key=lambda pair: PRIORITY_RANK.get(pair[0].priority, 3))
    approved = list(
        (
            await session.execute(
                base.where(Recommendation.status == "approved")
                .order_by(Recommendation.decided_at.desc())
                .limit(APPROVED_PREVIEW)
            )
        ).all()
    )

    def row(rec: Recommendation, name: str) -> dict:
        return {
            "product_id": rec.product_id,
            "product_name": name,
            "priority": rec.priority,
            "action_text": rec.action_text,
        }

    return {
        "pending_count": counts.get("pending", 0),
        "approved_count": counts.get("approved", 0),
        "pending_recommendations": [
            row(rec, name) for rec, name in pending[:RECOMMENDATION_PREVIEW]
        ],
        "approved_actions": [row(rec, name) for rec, name in approved],
    }


async def _chat_extras(
    session: AsyncSession, conversation: ChatConversation, context: dict
) -> None:
    """Add per-platform prices, recommendations and catalogue size to a chat context."""
    for item in context.get("portfolio") or ():
        item["platform_prices"] = await _platform_prices(session, item["product_id"])
    if context.get("product_id"):
        context["platform_prices"] = await _platform_prices(
            session, context["product_id"]
        )
    context.update(
        await _recommendation_context(
            session, conversation.user_id, conversation.product_id
        )
    )
    context["product_count"] = (
        await session.scalar(
            select(func.count(Product.id)).where(Product.user_id == conversation.user_id)
        )
    ) or 0


async def _unfocused_context(session: AsyncSession, user_id: str, message: str) -> dict:
    """Ground an "all products" chat in the product the message names, else the one
    with the most stock-outs, so answers carry real numbers instead of blanks.

    Only the most recently checked products are considered, so the cost of a
    message does not grow with the size of the catalogue.
    """
    last_checked = (
        select(CheckResult.product_id, func.max(CheckResult.checked_at).label("at"))
        .group_by(CheckResult.product_id)
        .subquery()
    )
    products = list(
        (
            await session.scalars(
                select(Product)
                .outerjoin(last_checked, last_checked.c.product_id == Product.id)
                .where(Product.user_id == user_id)
                .order_by(
                    last_checked.c.at.is_(None),
                    last_checked.c.at.desc(),
                    Product.created_at.desc(),
                )
                .limit(UNFOCUSED_PRODUCT_LIMIT)
            )
        ).all()
    )
    text = message.lower()

    def mention_score(product: Product) -> int:
        words = {w for w in f"{product.name} {product.brand or ''}".lower().split() if len(w) > 3}
        return sum(word in text for word in words)

    named = max(products, key=mention_score, default=None)
    if named is not None and mention_score(named) > 0:
        return await build_context(session, named.id) or dict(EMPTY_CONTEXT)
    built_all = [
        built for product in products if (built := await build_context(session, product.id))
    ]
    if not built_all:
        return dict(EMPTY_CONTEXT)
    # Worst product first, so single-product phrasing still leads with what matters.
    built_all.sort(key=lambda c: len(c["oos_pins"]), reverse=True)
    context = dict(built_all[0])
    if len(built_all) > 1:
        context["product_name"] = "your products"
        context["portfolio"] = [
            {
                "product_id": c["product_id"],
                "product_name": c["product_name"],
                "in_stock": c["in_stock"],
                "total_pins": c["total_pins"],
                "oos_pins": c["oos_pins"],
                "avg_price": c["avg_price"],
                "cheapest_rival": c["cheapest_rival"],
                "price_gap_pins": c.get("price_gap_pins", 0),
            }
            for c in built_all
        ]
    return context


async def _usage_context(session: AsyncSession, user_id: str) -> dict:
    plan = (
        await session.scalar(select(Subscription.plan).where(Subscription.user_id == user_id))
    ) or "free"
    limits = limits_for(plan)
    return {
        "plan": plan,
        "credits_used_today": await daily_credits_used(session, user_id),
        "daily_credit_budget": limits.daily_credit_budget,
        "product_limit": limits.products,
        "pincode_limit": limits.pincodes,
    }


def _message_payload(row: ChatMessage) -> ChatMessageOut:
    return ChatMessageOut(
        role=row.role,
        content=row.content,
        actions=row.actions or [],
        evidence=row.evidence or [],
        created_at=row.created_at,
    )


async def get_owned_conversation(
    session: AsyncSession, user: User, conversation_id: str
) -> ChatConversation:
    row = await session.scalar(
        select(ChatConversation).where(
            ChatConversation.id == conversation_id,
            ChatConversation.user_id == user.id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return row


async def _answer_message(
    session: AsyncSession, conversation: ChatConversation, content: str
) -> MessageResponse:
    message_count = await session.scalar(
        select(func.count(ChatMessage.id)).where(
            ChatMessage.conversation_id == conversation.id
        )
    )
    if (message_count or 0) >= MAX_MESSAGES_PER_CONVERSATION:
        raise HTTPException(
            status_code=422,
            detail=f"Conversation limit of {MAX_MESSAGES_PER_CONVERSATION} messages reached",
        )
    history_rows = list(
        (
            await session.scalars(
                select(ChatMessage)
                .where(ChatMessage.conversation_id == conversation.id)
                .order_by(ChatMessage.created_at.desc())
                .limit(HISTORY_WINDOW)
            )
        ).all()
    )
    history = [
        {"role": row.role, "content": row.content}
        for row in reversed(history_rows)
    ]
    context = dict(EMPTY_CONTEXT)
    if conversation.product_id:
        built = await build_context(session, conversation.product_id)
        if built is not None:
            context = built
    else:
        context = await _unfocused_context(session, conversation.user_id, content)
    await _chat_extras(session, conversation, context)
    context.update(await _usage_context(session, conversation.user_id))
    provider = get_ai_provider()
    result, source = await with_fallback(
        provider, "chat", context, content, history
    )
    user_message = ChatMessage(
        conversation_id=conversation.id,
        role="user",
        content=content,
    )
    assistant_message = ChatMessage(
        conversation_id=conversation.id,
        role="assistant",
        content=result.reply[:8000],
        actions=safe_actions([action.model_dump() for action in result.actions]),
        evidence=[item.model_dump() for item in result.evidence],
    )
    session.add(user_message)
    session.add(assistant_message)
    if conversation.title == DEFAULT_TITLE and not history_rows:
        # Name an empty "New chat" after its first question so history is scannable.
        conversation.title = _title_from(content)
    await session.commit()
    await session.refresh(assistant_message)
    reply = _message_payload(assistant_message)
    return MessageResponse(
        source=source,
        reply=reply,
        actions=reply.actions,
        evidence=reply.evidence,
    )


@router.get("/help/topics", response_model=HelpTopicListResponse)
async def get_help_topics() -> HelpTopicListResponse:
    return HelpTopicListResponse(
        items=[HelpTopic(**topic) for topic in list_help_topics()]
    )


@router.get("/help/topics/{slug}", response_model=HelpTopic)
async def get_help_topic_by_slug(slug: str) -> HelpTopic:
    topic = get_help_topic(slug)
    if topic is None:
        raise HTTPException(status_code=404, detail="Help topic not found")
    return HelpTopic(**topic)


@router.post("/chat/conversations", response_model=ConversationSummary)
async def create_conversation(
    payload: ConversationCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationSummary:
    product_id: str | None = None
    title = payload.title
    if payload.product_id is not None:
        product = await get_owned_product(session, user.id, payload.product_id)
        product_id = product.id
        title = title or f"Chat about {product.name}"
    conversation = ChatConversation(
        user_id=user.id,
        product_id=product_id,
        title=title or DEFAULT_TITLE,
    )
    session.add(conversation)
    await session.commit()
    await session.refresh(conversation)
    return ConversationSummary(
        id=conversation.id,
        title=conversation.title,
        product_id=conversation.product_id,
        created_at=conversation.created_at,
        message_count=0,
    )


@router.get("/chat/conversations", response_model=ConversationListResponse)
async def list_conversations(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationListResponse:
    counts = dict(
        (
            await session.execute(
                select(ChatMessage.conversation_id, func.count(ChatMessage.id))
                .join(
                    ChatConversation,
                    ChatConversation.id == ChatMessage.conversation_id,
                )
                .where(ChatConversation.user_id == user.id)
                .group_by(ChatMessage.conversation_id)
            )
        ).all()
    )
    rows = list(
        (
            await session.scalars(
                select(ChatConversation)
                .where(ChatConversation.user_id == user.id)
                .order_by(ChatConversation.created_at.desc())
            )
        ).all()
    )
    return ConversationListResponse(
        items=[
            ConversationSummary(
                id=row.id,
                title=row.title,
                product_id=row.product_id,
                created_at=row.created_at,
                message_count=counts.get(row.id, 0),
            )
            for row in rows
        ]
    )


@router.get("/chat/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ConversationDetail:
    conversation = await get_owned_conversation(session, user, conversation_id)
    messages = list(
        (
            await session.scalars(
                select(ChatMessage)
                .where(ChatMessage.conversation_id == conversation.id)
                .order_by(ChatMessage.created_at.asc())
            )
        ).all()
    )
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        product_id=conversation.product_id,
        created_at=conversation.created_at,
        messages=[_message_payload(row) for row in messages],
    )


@router.delete(
    "/chat/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete one of the caller's conversations together with its messages."""
    conversation = await get_owned_conversation(session, user, conversation_id)
    await session.execute(
        delete(ChatMessage).where(ChatMessage.conversation_id == conversation.id)
    )
    await session.delete(conversation)
    await session.commit()


@router.post(
    "/chat/conversations/{conversation_id}/messages",
    response_model=MessageResponse,
)
async def post_message(
    conversation_id: str,
    payload: MessageCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MessageResponse:
    conversation = await get_owned_conversation(session, user, conversation_id)
    return await _answer_message(session, conversation, payload.content)


@router.post("/chat", response_model=ChatResponse)
async def post_chat(
    payload: ChatRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ChatResponse:
    """Single-shot chat: creates or continues a conversation and answers."""
    if payload.conversation_id is not None:
        conversation = await get_owned_conversation(
            session, user, payload.conversation_id
        )
    else:
        product_id: str | None = None
        # Name the conversation after its first question so history is scannable.
        title = _title_from(payload.message)
        if payload.product_id is not None:
            product = await get_owned_product(session, user.id, payload.product_id)
            product_id = product.id
            title = f"{product.name}: {title}"[:300]
        conversation = ChatConversation(
            user_id=user.id,
            product_id=product_id,
            title=title,
        )
        session.add(conversation)
        await session.commit()
        await session.refresh(conversation)
    message = await _answer_message(session, conversation, payload.message)
    return ChatResponse(
        conversation_id=conversation.id,
        answer=message.reply.content,
        actions=message.actions,
        evidence=message.evidence,
        source=message.source,
    )
