"""AI endpoints: summaries, recommendations, the action list, and review insights."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.intelligence import AISummary, Recommendation, ReviewInsight
from ..models.product import Product
from ..models.user import User
from ..schemas.intelligence import (
    ActionItemResponse,
    ActionListResponse,
    DecisionResponse,
    GenerateResponse,
    RecommendationListResponse,
    RecommendationResponse,
    ReviewItem,
    ReviewRefreshResponse,
    SummaryResponse,
)
from ..services.insights import compute_reviews
from ..services.intelligence import (
    GenerationOutcome,
    approve_recommendation,
    clear_pending_recommendations,
    decide_recommendation,
    generate_summary,
    recommendation_kind,
    refresh_recommendations,
    refresh_review_insights,
    set_action_done,
)
from .products import get_owned_product

router = APIRouter(tags=["intelligence"])

RECOMMENDATION_STATUS_PATTERN = "^(pending|approved|done|dismissed|superseded|expired)$"
DONE_ACTIONS_LIMIT = 5


def _summary_payload(row: AISummary) -> SummaryResponse:
    return SummaryResponse(
        id=row.id,
        product_id=row.product_id,
        run_id=row.run_id,
        summary_text=row.summary_text,
        evidence=row.evidence or {},
        source=row.source,
        created_at=row.created_at,
    )


def _recommendation_payload(row: Recommendation) -> RecommendationResponse:
    return RecommendationResponse(
        id=row.id,
        product_id=row.product_id,
        priority=row.priority,
        action_text=row.action_text,
        impact_text=row.impact_text,
        evidence=row.evidence or {},
        status=row.status,
        decided_via=row.decided_via,
        created_at=row.created_at,
        decided_at=row.decided_at,
    )


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _action_payload(row: Recommendation, product_name: str | None) -> ActionItemResponse:
    evidence = row.evidence or {}
    target = evidence.get("target_price")
    return ActionItemResponse(
        **_recommendation_payload(row).model_dump(),
        product_name=product_name,
        kind=recommendation_kind(row.action_text, evidence),
        action_item=str(evidence.get("action_item") or row.action_text),
        effect=evidence.get("effect"),
        run_id=evidence.get("run_id"),
        target_price=float(target) if isinstance(target, (int, float)) else None,
        done_at=_parse_time(evidence.get("done_at")),
    )


def _decision_payload(row: Recommendation, **extra) -> DecisionResponse:
    return DecisionResponse(
        id=row.id,
        status=row.status,
        decided_via=row.decided_via,
        decided_at=row.decided_at,
        **extra,
    )


def generation_message(outcome: GenerationOutcome) -> str:
    """Honest one-liner for the Refresh toast."""
    if outcome.reason == "no_check_data":
        return "No new recommendations — run a check first so there is data to analyse"
    created = len(outcome.created)
    if not created:
        if outcome.reason == "limit_reached":
            return (
                "No new recommendations — approve or dismiss the pending ones first"
            )
        if outcome.price_note:
            return f"No new recommendations — {outcome.price_note}"
        message = "No new recommendations — nothing has changed since the last ones"
        if outcome.skipped_recent:
            message += f" ({outcome.skipped_recent} you decided recently not repeated)"
        return message
    parts = [f"{created} new recommendation{'s' if created != 1 else ''}"]
    if outcome.superseded:
        parts.append(f"replaced {outcome.superseded} older")
    if outcome.auto_approved:
        parts.append(f"{outcome.auto_approved} auto-approved")
    message = ", ".join(parts)
    if outcome.price_note:
        message += f" (no price change: {outcome.price_note[:1].lower()}{outcome.price_note[1:]})"
    return message


def ensure_pending(row: Recommendation) -> None:
    """Only `pending` recommendations can be decided or sent out."""
    if row.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "already_decided",
                "message": f"This recommendation is already {row.status}",
            },
        )


async def get_owned_recommendation(
    session: AsyncSession, user: User, recommendation_id: str
) -> Recommendation:
    row = await session.scalar(
        select(Recommendation)
        .join(Product, Product.id == Recommendation.product_id)
        .where(
            Recommendation.id == recommendation_id,
            Product.user_id == user.id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    return row


@router.post(
    "/products/{product_id}/ai/summary", response_model=SummaryResponse
)
async def post_generate_summary(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> SummaryResponse:
    product = await get_owned_product(session, user.id, product_id)
    summary = await generate_summary(session, product)
    if summary is None:
        raise HTTPException(
            status_code=422, detail="No check data to summarise yet"
        )
    return _summary_payload(summary)


@router.get(
    "/products/{product_id}/ai/recommendations",
    response_model=RecommendationListResponse,
)
async def list_recommendations(
    product_id: str,
    status: str | None = Query(default=None, pattern=RECOMMENDATION_STATUS_PATTERN),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> RecommendationListResponse:
    await get_owned_product(session, user.id, product_id)
    statement = select(Recommendation).where(
        Recommendation.product_id == product_id
    )
    if status is not None:
        statement = statement.where(Recommendation.status == status)
    rows = list(
        (await session.scalars(statement.order_by(Recommendation.created_at.desc()))).all()
    )
    return RecommendationListResponse(
        items=[_recommendation_payload(row) for row in rows]
    )


@router.post(
    "/products/{product_id}/ai/recommendations",
    response_model=GenerateResponse,
)
async def post_generate_recommendations(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> GenerateResponse:
    product = await get_owned_product(session, user.id, product_id)
    outcome = await refresh_recommendations(session, product)
    return GenerateResponse(
        source=outcome.source,
        summary=None,
        recommendations=[_recommendation_payload(row) for row in outcome.created],
        superseded=outcome.superseded,
        expired=outcome.expired,
        skipped_recent=outcome.skipped_recent,
        auto_approved=outcome.auto_approved,
        reason=outcome.reason,
        price_note=outcome.price_note,
        message=generation_message(outcome),
    )


@router.delete(
    "/products/{product_id}/ai/recommendations/pending",
    response_model=DecisionResponse,
)
async def delete_pending_recommendations(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    await get_owned_product(session, user.id, product_id)
    removed = await clear_pending_recommendations(session, product_id)
    return DecisionResponse(id=product_id, status=f"removed:{removed}")


@router.get("/actions", response_model=ActionListResponse)
async def list_actions(
    product_id: str | None = Query(default=None, max_length=36),
    done_limit: int = Query(default=DONE_ACTIONS_LIMIT, ge=0, le=50),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ActionListResponse:
    """The seller's action list: approved (open) items and recently done ones."""
    if product_id is not None:
        await get_owned_product(session, user.id, product_id)
    statement = (
        select(Recommendation, Product.name)
        .join(Product, Product.id == Recommendation.product_id)
        .where(Product.user_id == user.id)
        .order_by(Recommendation.decided_at.desc())
    )
    if product_id is not None:
        statement = statement.where(Recommendation.product_id == product_id)
    open_rows = (
        await session.execute(statement.where(Recommendation.status == "approved"))
    ).all()
    done_rows = (
        await session.execute(
            statement.where(Recommendation.status == "done").limit(done_limit)
        )
    ).all() if done_limit else []
    return ActionListResponse(
        open=[_action_payload(row, name) for row, name in open_rows],
        done=[_action_payload(row, name) for row, name in done_rows],
    )


@router.post(
    "/recommendations/{recommendation_id}/approve",
    response_model=DecisionResponse,
)
async def post_approve_recommendation(
    recommendation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    row = await get_owned_recommendation(session, user, recommendation_id)
    ensure_pending(row)
    outcome = await approve_recommendation(session, row, decided_via="web")
    return _decision_payload(
        outcome.recommendation,
        effect=outcome.effect,
        run_id=outcome.run_id,
        action_item=outcome.action_item,
        message=outcome.message,
    )


@router.post(
    "/recommendations/{recommendation_id}/dismiss",
    response_model=DecisionResponse,
)
async def dismiss_recommendation(
    recommendation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    row = await get_owned_recommendation(session, user, recommendation_id)
    ensure_pending(row)
    row = await decide_recommendation(session, row, decision="dismissed")
    return _decision_payload(
        row, message="Dismissed — it won't be suggested again this week"
    )


@router.post(
    "/recommendations/{recommendation_id}/done",
    response_model=DecisionResponse,
)
async def mark_action_done(
    recommendation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    row = await get_owned_recommendation(session, user, recommendation_id)
    row = await set_action_done(session, row, done=True)
    return _decision_payload(row, message="Marked done")


@router.post(
    "/recommendations/{recommendation_id}/reopen",
    response_model=DecisionResponse,
)
async def reopen_action(
    recommendation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    row = await get_owned_recommendation(session, user, recommendation_id)
    row = await set_action_done(session, row, done=False)
    return _decision_payload(row, message="Moved back to your open actions")


TELEGRAM_SEND_MESSAGES = {
    "no_linked_chats": "No Telegram chat is linked to this product yet",
    "bot_offline": "The ShelfSense Telegram bot isn't running right now, so nothing was sent",
    "failed": "Telegram didn't accept the message; nothing was sent",
}


@router.post(
    "/recommendations/{recommendation_id}/send-telegram",
    response_model=DecisionResponse,
)
async def send_recommendation_to_telegram(
    recommendation_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DecisionResponse:
    from ..services.telegram import send_recommendation_to_chats

    row = await get_owned_recommendation(session, user, recommendation_id)
    ensure_pending(row)
    status, sent = await send_recommendation_to_chats(session, row, user_id=user.id)
    message = TELEGRAM_SEND_MESSAGES.get(
        status, f"Sent to {sent} Telegram chat{'s' if sent != 1 else ''}"
    )
    return _decision_payload(
        row, sent_to_chats=sent, telegram_status=status, message=message
    )


async def _own_review_lists(session: AsyncSession, product_id: str) -> tuple:
    row = await session.scalar(
        select(ReviewInsight).where(
            ReviewInsight.product_id == product_id,
            ReviewInsight.competitor_id.is_(None),
        )
    )
    return (list(row.loves), list(row.complaints)) if row is not None else None


@router.post("/products/{product_id}/ai/reviews", response_model=ReviewRefreshResponse)
async def post_refresh_reviews(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ReviewRefreshResponse:
    product = await get_owned_product(session, user.id, product_id)
    before = await _own_review_lists(session, product_id)
    row, source = await refresh_review_insights(session, product)
    after = await _own_review_lists(session, product_id)
    changed = row is not None and before != after
    if row is None:
        message = "No review insights yet — run a check first so there is data to read"
    elif changed:
        message = "Review insights updated from the latest checks"
    else:
        message = "No change — the latest checks tell the same story"
    merged = await compute_reviews(session, product_id)
    items = [
        ReviewItem(
            entity_id=item["entity_id"],
            name=item["name"],
            loves=item["loves"],
            complaints=item["complaints"],
            updated_at=item["updated_at"],
        )
        for item in merged["items"]
    ]
    return ReviewRefreshResponse(
        source=source,
        loves=merged["loves"],
        complaints=merged["complaints"],
        rival_loves=merged["rival_loves"],
        rival_complaints=merged["rival_complaints"],
        items=items,
        changed=changed,
        message=message,
    )
