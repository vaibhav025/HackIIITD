"""User dashboard: stat tiles, today's alerts, top recommendations, Telegram."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.checks import CheckResult
from ..models.intelligence import Alert, Recommendation
from ..models.product import Product, ProductPincode
from ..models.telegram import TelegramLink
from ..models.user import User
from ..schemas.dashboard import (
    DashboardAlert,
    DashboardRecommendation,
    DashboardResponse,
    PlanMeters,
    StatTile,
    TelegramStatus,
)
from ..services.heatmap import take_latest
from ..services.intelligence import OPEN_ACTION_STATUSES
from ..services.plans import daily_credits_used, limits_for
from .products import get_user_plan

router = APIRouter(tags=["dashboard"])

PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DashboardResponse:
    product_count = await session.scalar(
        select(func.count()).select_from(Product).where(Product.user_id == user.id)
    )
    pincode_count = await session.scalar(
        select(func.count(func.distinct(ProductPincode.pincode)))
        .select_from(ProductPincode)
        .join(Product, Product.id == ProductPincode.product_id)
        .where(Product.user_id == user.id)
    )
    per_product_pincodes = (
        select(func.count(func.distinct(ProductPincode.pincode)).label("pins"))
        .join(Product, Product.id == ProductPincode.product_id)
        .where(Product.user_id == user.id)
        .group_by(ProductPincode.product_id)
        .subquery()
    )
    max_pincodes_per_product = await session.scalar(
        select(func.max(per_product_pincodes.c.pins))
    )
    plan = await get_user_plan(session, user.id)
    limits = limits_for(plan)
    meters = PlanMeters(
        plan=plan,
        products=product_count or 0,
        product_limit=limits.products,
        max_pincodes_per_product=max_pincodes_per_product or 0,
        pincode_limit_per_product=limits.pincodes,
        credits_today=await daily_credits_used(session, user.id),
        daily_credit_budget=limits.daily_credit_budget,
    )
    week_ago = datetime.now(UTC) - timedelta(days=7)
    checks_this_week = await session.scalar(
        select(func.count())
        .select_from(CheckResult)
        .join(Product, Product.id == CheckResult.product_id)
        .where(Product.user_id == user.id, CheckResult.checked_at >= week_ago)
    )
    pending_count = await session.scalar(
        select(func.count())
        .select_from(Recommendation)
        .join(Product, Product.id == Recommendation.product_id)
        .where(Product.user_id == user.id, Recommendation.status == "pending")
    )

    try:
        local_now = datetime.now(ZoneInfo(user.timezone))
    except (ZoneInfoNotFoundError, ValueError):
        local_now = datetime.now(UTC)
    today_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start_utc = today_start.astimezone(UTC)

    product_names = {
        row.id: row.name
        for row in (
            await session.scalars(
                select(Product).where(Product.user_id == user.id)
            )
        ).all()
    }
    alert_rows = list(
        (
            await session.scalars(
                select(Alert)
                .where(Alert.user_id == user.id, Alert.created_at >= today_start_utc)
                .order_by(Alert.created_at.desc())
                .limit(5)
            )
        ).all()
    )
    alerts_today_count = await session.scalar(
        select(func.count())
        .select_from(Alert)
        .where(Alert.user_id == user.id, Alert.created_at >= today_start_utc)
    )

    pending_rows = list(
        (
            await session.scalars(
                select(Recommendation)
                .join(Product, Product.id == Recommendation.product_id)
                .where(
                    Product.user_id == user.id, Recommendation.status == "pending"
                )
                .order_by(Recommendation.created_at.desc())
                .limit(20)
            )
        ).all()
    )
    pending_rows.sort(key=lambda row: PRIORITY_RANK.get(row.priority, 9))

    recent_seller = list(
        (
            await session.scalars(
                select(CheckResult)
                .join(Product, Product.id == CheckResult.product_id)
                .where(
                    Product.user_id == user.id,
                    CheckResult.competitor_id.is_(None),
                    CheckResult.checked_at >= datetime.now(UTC) - timedelta(hours=24),
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )
    latest_cells = take_latest(
        recent_seller, lambda row: (row.product_id, row.platform, row.pincode)
    )
    pins_at_risk = sum(
        1 for row in latest_cells.values() if row.in_stock is False
    )

    oos_pincodes = len(
        {row.pincode for row in latest_cells.values() if row.in_stock is False}
    )
    # Same measure as of a week ago: latest seller result per cell in the day before.
    week_ago_rows = list(
        (
            await session.scalars(
                select(CheckResult)
                .join(Product, Product.id == CheckResult.product_id)
                .where(
                    Product.user_id == user.id,
                    CheckResult.competitor_id.is_(None),
                    CheckResult.checked_at >= week_ago - timedelta(hours=24),
                    CheckResult.checked_at < week_ago,
                )
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
    )
    week_ago_cells = take_latest(
        week_ago_rows, lambda row: (row.product_id, row.platform, row.pincode)
    )
    oos_pincodes_last_week = len(
        {row.pincode for row in week_ago_cells.values() if row.in_stock is False}
    )
    approved_this_week = await session.scalar(
        select(func.count())
        .select_from(Recommendation)
        .join(Product, Product.id == Recommendation.product_id)
        .where(
            Product.user_id == user.id,
            Recommendation.status.in_(OPEN_ACTION_STATUSES),
            Recommendation.decided_at >= week_ago,
        )
    )

    telegram_count = await session.scalar(
        select(func.count())
        .select_from(TelegramLink)
        .join(Product, Product.id == TelegramLink.product_id)
        .where(Product.user_id == user.id)
    )

    tiles = [
        StatTile(key="products", label="Products", value=product_count or 0),
        StatTile(
            key="pincodes",
            label="Pincodes tracked",
            value=pincode_count or 0,
        ),
        StatTile(
            key="checks_this_week",
            label="Checks this week",
            value=checks_this_week or 0,
        ),
        StatTile(
            key="pins_at_risk",
            label="Pins at risk (24h)",
            value=pins_at_risk,
        ),
        StatTile(
            key="pending_recommendations",
            label="Pending actions",
            value=pending_count or 0,
        ),
        StatTile(
            key="alerts_today",
            label="Alerts today",
            value=alerts_today_count or 0,
        ),
        StatTile(key="oos_pincodes", label="Out-of-stock pincodes", value=oos_pincodes),
        StatTile(
            key="oos_pincodes_last_week",
            label="Out-of-stock pincodes a week ago",
            value=oos_pincodes_last_week,
        ),
        StatTile(
            key="approved_this_week",
            label="Approved this week",
            value=approved_this_week or 0,
        ),
    ]
    return DashboardResponse(
        meters=meters,
        tiles=tiles,
        alerts=[
            DashboardAlert(
                id=row.id,
                product_id=row.product_id,
                product_name=product_names.get(row.product_id),
                kind=row.kind,
                message=row.message,
                evidence=row.evidence,
                created_at=row.created_at,
                read=row.read,
            )
            for row in alert_rows
        ],
        recommendations=[
            DashboardRecommendation(
                id=row.id,
                product_id=row.product_id,
                product_name=product_names.get(row.product_id),
                priority=row.priority,
                action_text=row.action_text,
                impact_text=row.impact_text,
                created_at=row.created_at,
            )
            for row in pending_rows[:3]
        ],
        telegram=TelegramStatus(
            connected=bool(telegram_count), total=telegram_count or 0
        ),
    )
