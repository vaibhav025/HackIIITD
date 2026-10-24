"""Notification endpoints: alert inbox and Telegram linking."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..db import get_session
from ..deps import get_current_user
from ..models.intelligence import Alert
from ..models.product import Product
from ..models.telegram import TelegramLink
from ..models.user import User
from ..schemas.notifications import (
    AlertListResponse,
    AlertResponse,
    LinkCodeRequest,
    LinkCodeResponse,
    MarkReadResponse,
    TelegramChatLink,
    TelegramLinkUpdate,
    TelegramStatusResponse,
    TelegramTestResponse,
)
from ..schemas.products import AlertRuleOut
from ..services.alerts import stored_rules, telegram_types_in, telegram_types_out
from ..services.telegram import (
    bot_is_running,
    build_deeplink,
    create_link_code,
    send_telegram_message,
    unlink_link,
)
from .products import get_owned_product

router = APIRouter(tags=["notifications"])


def _rule_payload(rule) -> AlertRuleOut:
    return AlertRuleOut(
        kind=rule.kind if hasattr(rule, "kind") else rule["kind"],
        threshold=rule.threshold if hasattr(rule, "threshold") else rule.get("threshold"),
        rule_text=rule.rule_text if hasattr(rule, "rule_text") else rule.get("rule_text"),
        rule_json=rule.rule_json if hasattr(rule, "rule_json") else rule.get("rule_json", {}),
        active=rule.active if hasattr(rule, "active") else rule.get("active", True),
    )


def _alert_payload(row: Alert, product_names: dict[str, str]) -> AlertResponse:
    return AlertResponse(
        id=row.id,
        product_id=row.product_id,
        product_name=product_names.get(row.product_id),
        kind=row.kind,
        message=row.message,
        evidence=row.evidence or {},
        read=row.read,
        sent_telegram=row.sent_telegram,
        created_at=row.created_at,
    )


@router.get("/me/alerts", response_model=AlertListResponse)
async def list_alerts(
    unread: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AlertListResponse:
    statement = select(Alert).where(Alert.user_id == user.id)
    if unread:
        statement = statement.where(Alert.read.is_(False))
    rows = list(
        (
            await session.scalars(
                statement.order_by(Alert.created_at.desc()).limit(limit)
            )
        ).all()
    )
    unread_count = await session.scalar(
        select(func.count())
        .select_from(Alert)
        .where(Alert.user_id == user.id, Alert.read.is_(False))
    )
    product_names = {
        row.id: row.name
        for row in (
            await session.scalars(
                select(Product).where(
                    Product.id.in_({alert.product_id for alert in rows})
                )
            )
        ).all()
    }
    return AlertListResponse(
        items=[_alert_payload(row, product_names) for row in rows],
        unread=unread_count or 0,
    )


@router.post("/me/alerts/{alert_id}/read", response_model=MarkReadResponse)
async def mark_alert_read(
    alert_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MarkReadResponse:
    result = await session.execute(
        update(Alert)
        .where(Alert.id == alert_id, Alert.user_id == user.id, Alert.read.is_(False))
        .values(read=True)
    )
    await session.commit()
    if result.rowcount == 0:
        existing = await session.scalar(
            select(Alert.id).where(Alert.id == alert_id, Alert.user_id == user.id)
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="Alert not found")
    return MarkReadResponse(marked=int(result.rowcount or 0))


@router.post("/me/alerts/read-all", response_model=MarkReadResponse)
async def mark_all_alerts_read(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MarkReadResponse:
    result = await session.execute(
        update(Alert)
        .where(Alert.user_id == user.id, Alert.read.is_(False))
        .values(read=True)
    )
    await session.commit()
    return MarkReadResponse(marked=int(result.rowcount or 0))


@router.get(
    "/products/{product_id}/alert-rules",
    response_model=list[AlertRuleOut],
)
async def get_alert_rules(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[AlertRuleOut]:
    product = await get_owned_product(session, user.id, product_id)
    # Inactive rules too, so a rule switched off can be switched back on.
    rules = await stored_rules(session, product)
    return [_rule_payload(rule) for rule in rules]


@router.post(
    "/products/{product_id}/telegram/link-code",
    response_model=LinkCodeResponse,
)
async def post_link_code(
    product_id: str,
    payload: LinkCodeRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> LinkCodeResponse:
    await get_owned_product(session, user.id, product_id)
    chat_type = payload.chat_type if payload else "personal"
    code = await create_link_code(
        session, user_id=user.id, product_id=product_id, chat_type=chat_type
    )
    return LinkCodeResponse(
        code=code.code,
        # No bot token means no bot to open: never hand out a t.me link then.
        deep_link=build_deeplink(code.code, chat_type)
        if settings.telegram_enabled
        else None,
        command=f"/start {code.code}",
        expires_at=code.expires_at,
        product_id=product_id,
    )


@router.get(
    "/products/{product_id}/telegram/status",
    response_model=TelegramStatusResponse,
)
async def telegram_status(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TelegramStatusResponse:
    await get_owned_product(session, user.id, product_id)
    rows = list(
        (
            await session.scalars(
                select(TelegramLink).where(
                    TelegramLink.product_id == product_id,
                    TelegramLink.user_id == user.id,
                )
            )
        ).all()
    )
    if rows:
        status = "connected"
        chat_title = rows[0].chat_title
    else:
        from ..models.base import utcnow
        from ..models.telegram import TelegramLinkCode

        waiting = await session.scalar(
            select(TelegramLinkCode.code)
            .where(
                TelegramLinkCode.product_id == product_id,
                TelegramLinkCode.user_id == user.id,
                TelegramLinkCode.used_at.is_(None),
                TelegramLinkCode.expires_at >= utcnow(),
            )
            .limit(1)
        )
        status = "waiting" if waiting else "not_connected"
        chat_title = None
    return TelegramStatusResponse(
        status=status,
        chat_title=chat_title,
        enabled=settings.telegram_enabled,
        bot_running=bot_is_running(),
        bot_username=(settings.telegram_bot_username or None)
        if settings.telegram_enabled
        else None,
        simulate_available=not settings.telegram_enabled and not settings.is_production,
        links=[
            TelegramChatLink(
                id=row.id,
                chat_id=row.chat_id,
                chat_title=row.chat_title,
                alert_types=telegram_types_out(row.alert_types),
                briefing_time=row.briefing_time,
                connected_at=row.connected_at,
            )
            for row in rows
        ],
    )


@router.patch(
    "/products/{product_id}/telegram",
    response_model=TelegramStatusResponse,
)
async def update_telegram_link(
    product_id: str,
    payload: TelegramLinkUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TelegramStatusResponse:
    await get_owned_product(session, user.id, product_id)
    rows = list(
        (
            await session.scalars(
                select(TelegramLink).where(
                    TelegramLink.product_id == product_id,
                    TelegramLink.user_id == user.id,
                )
            )
        ).all()
    )
    if not rows:
        raise HTTPException(
            status_code=404, detail="Telegram is not connected for this product"
        )
    changes = payload.model_dump(exclude_unset=True)
    if "alert_types" in changes:
        changes["alert_types"] = telegram_types_in(changes["alert_types"])
    for row in rows:
        for field, value in changes.items():
            setattr(row, field, value)
    await session.commit()
    return await telegram_status(product_id, user=user, session=session, settings=settings)


@router.post(
    "/products/{product_id}/telegram/test",
    response_model=TelegramTestResponse,
)
async def send_test_telegram(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> TelegramTestResponse:
    product = await get_owned_product(session, user.id, product_id)
    rows = list(
        (
            await session.scalars(
                select(TelegramLink).where(
                    TelegramLink.product_id == product_id,
                    TelegramLink.user_id == user.id,
                )
            )
        ).all()
    )
    if not rows:
        raise HTTPException(
            status_code=404, detail="Telegram is not connected for this product"
        )
    text = f"[ShelfSense] Test message for {product.name}. Alerts are wired up."
    sent_any = False
    chat_id: str | None = None
    for row in rows:
        if await send_telegram_message(row.chat_id, text):
            sent_any = True
            chat_id = row.chat_id
    return TelegramTestResponse(
        sent=sent_any,
        chat_id=chat_id,
        message=text if sent_any else "Bot is not running; message logged only.",
    )


@router.delete("/products/{product_id}/telegram/links/{link_id}", status_code=204)
async def disconnect_telegram_link(
    product_id: str,
    link_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Remove a single chat from this product; other chats stay connected."""
    await get_owned_product(session, user.id, product_id)
    owned = await session.scalar(
        select(TelegramLink.id).where(
            TelegramLink.id == link_id,
            TelegramLink.product_id == product_id,
            TelegramLink.user_id == user.id,
        )
    )
    if owned is None:
        raise HTTPException(status_code=404, detail="Telegram chat link not found")
    await unlink_link(session, link_id)


@router.delete("/products/{product_id}/telegram", status_code=204)
async def disconnect_telegram(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    await get_owned_product(session, user.id, product_id)
    rows = list(
        (
            await session.scalars(
                select(TelegramLink).where(
                    TelegramLink.product_id == product_id,
                    TelegramLink.user_id == user.id,
                )
            )
        ).all()
    )
    # By link id: the same chat may stay linked to the user's other products.
    for row in rows:
        await unlink_link(session, row.id)
