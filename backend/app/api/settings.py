"""User settings, data export, account deletion, and test-mode plan switching."""

from __future__ import annotations

import csv
from io import StringIO
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..config import get_settings as get_app_settings
from ..db import get_session
from ..deps import get_current_user
from ..models.chat import ChatConversation, ChatMessage
from ..models.checks import CheckResult, CreditLedger
from ..models.intelligence import Alert, AlertRule, Recommendation
from ..models.product import Competitor, Product, ProductListing, ProductPincode
from ..models.telegram import TelegramLink, TelegramLinkCode
from ..models.user import Subscription, User, UserSettings
from ..schemas.me import ProfileResponse
from ..schemas.settings import (
    OverLimitProduct,
    PlanChangeRequest,
    PlanChangeResponse,
    UserSettingsResponse,
    UserSettingsUpdate,
)
from ..services.plans import clamp_frequency, limits_for
from ..services.runner import cancel_runs_for_user
from .media import remove_product_media
from .products import delete_product_data

router = APIRouter(tags=["settings"])

# Spreadsheet apps evaluate cells starting with these characters as formulas.
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
EXPORT_RESULT_LIMIT = 5000

PRODUCT_EXPORT_FIELDS = (
    "id",
    "name",
    "brand",
    "search_query",
    "image_url",
    "cost_price",
    "min_margin_pct",
    "max_change_pct",
    "floor_price",
    "commission_pct",
    "mrp",
    "price_sensitivity",
    "round_to_price_point",
    "check_frequency",
    "volatile_boost",
    "approval_required",
    "paused",
    "created_at",
)
RESULT_EXPORT_FIELDS = (
    "id",
    "run_id",
    "product_id",
    "competitor_id",
    "platform",
    "pincode",
    "in_stock",
    "price",
    "mrp",
    "eta_minutes",
    "rating",
    "status",
    "error",
    "screenshot_url",
    "checked_at",
)
ALERT_EXPORT_FIELDS = (
    "id",
    "product_id",
    "kind",
    "message",
    "evidence",
    "read",
    "sent_telegram",
    "created_at",
)
RECOMMENDATION_EXPORT_FIELDS = (
    "id",
    "product_id",
    "priority",
    "action_text",
    "impact_text",
    "evidence",
    "status",
    "decided_via",
    "created_at",
    "decided_at",
)


def safe_csv_cell(value: object) -> object:
    """Neutralise CSV formula injection by quoting formula-like text cells."""
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def _columns(row: object, names: tuple[str, ...]) -> dict:
    return {name: getattr(row, name) for name in names}


async def get_or_create_settings(session: AsyncSession, user_id: str) -> UserSettings:
    settings = await session.get(UserSettings, user_id)
    if settings is None:
        settings = UserSettings(user_id=user_id)
        session.add(settings)
        await session.commit()
        await session.refresh(settings)
    return settings


async def build_account_export(session: AsyncSession, user: User) -> dict:
    """Everything the account owns, as JSON-ready data."""

    async def all_rows(statement) -> list:
        return list((await session.scalars(statement)).all())

    products = await all_rows(
        select(Product).where(Product.user_id == user.id).order_by(Product.created_at)
    )
    product_ids = [product.id for product in products]
    competitors = await all_rows(
        select(Competitor).where(Competitor.product_id.in_(product_ids))
    )
    selections = await all_rows(
        select(ProductPincode).where(ProductPincode.product_id.in_(product_ids))
    )
    listings = await all_rows(
        select(ProductListing).where(ProductListing.product_id.in_(product_ids))
    )
    rules = await all_rows(select(AlertRule).where(AlertRule.product_id.in_(product_ids)))
    results = await all_rows(
        select(CheckResult)
        .where(CheckResult.product_id.in_(product_ids))
        .order_by(CheckResult.checked_at.desc())
        .limit(EXPORT_RESULT_LIMIT)
    )
    alerts = await all_rows(
        select(Alert).where(Alert.user_id == user.id).order_by(Alert.created_at.desc())
    )
    recommendations = await all_rows(
        select(Recommendation)
        .where(Recommendation.product_id.in_(product_ids))
        .order_by(Recommendation.created_at.desc())
    )
    conversations = await all_rows(
        select(ChatConversation)
        .where(ChatConversation.user_id == user.id)
        .order_by(ChatConversation.created_at)
    )
    messages = await all_rows(
        select(ChatMessage)
        .where(ChatMessage.conversation_id.in_([row.id for row in conversations]))
        .order_by(ChatMessage.created_at)
    )
    plan = await session.scalar(
        select(Subscription.plan).where(Subscription.user_id == user.id)
    )
    settings_row = await get_or_create_settings(session, user.id)

    def owned_by(rows: list, product_id: str) -> list:
        return [row for row in rows if row.product_id == product_id]

    return {
        "profile": ProfileResponse.model_validate(user).model_dump(),
        "plan": plan or "free",
        "settings": UserSettingsResponse.model_validate(settings_row).model_dump(),
        "products": [
            {
                **_columns(product, PRODUCT_EXPORT_FIELDS),
                "competitors": [
                    _columns(
                        row,
                        ("id", "name", "platform", "url", "search_query", "confirmed"),
                    )
                    for row in owned_by(competitors, product.id)
                ],
                "platforms": sorted(
                    {row.platform for row in owned_by(selections, product.id)}
                ),
                "pincodes": sorted(
                    {row.pincode for row in owned_by(selections, product.id)}
                ),
                "listings": [
                    _columns(row, ("platform", "url"))
                    for row in owned_by(listings, product.id)
                ],
                "alert_rules": [
                    _columns(
                        row, ("kind", "threshold", "rule_text", "rule_json", "active")
                    )
                    for row in owned_by(rules, product.id)
                    # Internal marker for "user cleared every rule", not a rule.
                    if row.kind != "rules_cleared"
                ],
            }
            for product in products
        ],
        "recent_results": [_columns(row, RESULT_EXPORT_FIELDS) for row in results],
        "alerts": [_columns(row, ALERT_EXPORT_FIELDS) for row in alerts],
        "recommendations": [
            _columns(row, RECOMMENDATION_EXPORT_FIELDS) for row in recommendations
        ],
        "conversations": [
            {
                **_columns(row, ("id", "title", "product_id", "created_at")),
                "messages": [
                    _columns(message, ("role", "content", "created_at"))
                    for message in messages
                    if message.conversation_id == row.id
                ],
            }
            for row in conversations
        ],
    }


@router.get("/me/settings", response_model=UserSettingsResponse)
async def get_settings(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)
) -> UserSettings:
    return await get_or_create_settings(session, user.id)


@router.patch("/me/settings", response_model=UserSettingsResponse)
async def update_settings(
    payload: UserSettingsUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> UserSettings:
    settings = await get_or_create_settings(session, user.id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings, field, value)
    await session.commit()
    await session.refresh(settings)
    return settings


@router.post("/me/plan", response_model=PlanChangeResponse)
async def change_plan(
    payload: PlanChangeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    app_settings: Settings = Depends(get_app_settings),
) -> PlanChangeResponse:
    """Test-mode plan switch: never charges, and is unavailable in production.

    Existing products are reconciled with the new limits: check frequencies are
    clamped to the plan minimum and active products beyond the product cap
    (newest first) are paused. Products tracking more pincodes or competitors
    than the new plan allows are listed in ``over_limit`` (nothing is deleted).
    """
    if app_settings.is_production:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "billing_unavailable",
                "message": "Plan changes go through billing in production",
            },
        )
    subscription = await session.scalar(
        select(Subscription).where(Subscription.user_id == user.id)
    )
    if subscription is None:
        session.add(Subscription(user_id=user.id, plan=payload.plan, status="active"))
    else:
        subscription.plan = payload.plan
        subscription.status = "active"

    products = list(
        (
            await session.scalars(
                select(Product)
                .where(Product.user_id == user.id)
                .order_by(Product.created_at, Product.id)
            )
        ).all()
    )
    adjusted = 0
    for product in products:
        clamped = clamp_frequency(payload.plan, product.check_frequency)
        if clamped != product.check_frequency:
            product.check_frequency = clamped
            adjusted += 1
    paused = 0
    cap = limits_for(payload.plan).products
    if cap is not None:
        for product in [product for product in products if not product.paused][cap:]:
            product.paused = True
            paused += 1
    over_limit = await products_over_limit(session, products, payload.plan)
    await session.commit()
    return PlanChangeResponse(
        plan=payload.plan,
        status="active",
        test_mode=True,
        adjusted_products=adjusted,
        paused_products=paused,
        over_limit=over_limit,
    )


async def products_over_limit(
    session: AsyncSession, products: list[Product], plan: str
) -> list[OverLimitProduct]:
    """Products whose pincode or competitor count exceeds the plan's per-product limits."""
    ids = [product.id for product in products]
    if not ids:
        return []
    pincode_counts = dict(
        (
            await session.execute(
                select(
                    ProductPincode.product_id,
                    func.count(func.distinct(ProductPincode.pincode)),
                )
                .where(ProductPincode.product_id.in_(ids))
                .group_by(ProductPincode.product_id)
            )
        ).all()
    )
    competitor_counts = dict(
        (
            await session.execute(
                select(Competitor.product_id, func.count(Competitor.id))
                .where(Competitor.product_id.in_(ids))
                .group_by(Competitor.product_id)
            )
        ).all()
    )
    limits = limits_for(plan)
    rows = []
    for product in products:
        pincodes = int(pincode_counts.get(product.id, 0))
        competitors = int(competitor_counts.get(product.id, 0))
        if (limits.pincodes is not None and pincodes > limits.pincodes) or (
            competitors > limits.competitors
        ):
            rows.append(
                OverLimitProduct(
                    product_id=product.id,
                    name=product.name,
                    pincodes=pincodes,
                    pincode_limit=limits.pincodes,
                    competitors=competitors,
                    competitor_limit=limits.competitors,
                )
            )
    return rows


@router.get("/me/export", response_model=None)
async def export_data(
    format: Literal["csv", "json"] = Query(default="csv"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse | JSONResponse:
    if format == "json":
        return JSONResponse(
            content=jsonable_encoder(await build_account_export(session, user)),
            headers={
                "Content-Disposition": "attachment; filename=shelfsense-export.json"
            },
        )
    rows = (
        await session.execute(
            select(
                Product.name,
                CheckResult.platform,
                CheckResult.pincode,
                CheckResult.in_stock,
                CheckResult.price,
                CheckResult.eta_minutes,
                CheckResult.checked_at,
            )
            .join(Product, Product.id == CheckResult.product_id)
            .where(Product.user_id == user.id)
            .order_by(CheckResult.checked_at.desc())
        )
    ).all()
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "product",
            "platform",
            "pincode",
            "in_stock",
            "price",
            "eta_minutes",
            "checked_at",
        ]
    )
    writer.writerows([safe_csv_cell(value) for value in row] for row in rows)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=shelfsense-export.csv"},
    )


@router.delete("/me", status_code=204)
async def delete_me(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    app_settings: Settings = Depends(get_app_settings),
) -> Response:
    if app_settings.dev_auth_enabled:
        # Every request maps to the demo account; deleting it would brick the app.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "demo_account",
                "message": "Demo account can't be deleted; reseed instead",
            },
        )
    product_ids = list(
        (await session.scalars(select(Product.id).where(Product.user_id == user.id))).all()
    )
    await cancel_runs_for_user(user.id)
    conversation_ids = select(ChatConversation.id).where(
        ChatConversation.user_id == user.id
    )
    await session.execute(
        delete(ChatMessage).where(ChatMessage.conversation_id.in_(conversation_ids))
    )
    await session.execute(
        delete(ChatConversation).where(ChatConversation.user_id == user.id)
    )
    await delete_product_data(session, product_ids)
    for model in (Alert, TelegramLinkCode, TelegramLink, CreditLedger, UserSettings, Subscription):
        await session.execute(delete(model).where(model.user_id == user.id))
    await session.delete(user)
    await session.commit()
    await remove_product_media(product_ids)
    return Response(status_code=204)
