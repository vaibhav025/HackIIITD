"""Product insights: overview KPIs, competitor table, weekly report, reviews."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.user import User
from ..schemas.insights import (
    CompetitorSummaryRow,
    OverviewResponse,
    ReviewsResponse,
    WeeklyResponse,
)
from ..services.insights import (
    build_weekly_csv,
    compute_competitor_rows,
    compute_overview,
    compute_reviews,
    compute_weekly,
    daily_entity_rows,
)
from .heatmap import ensure_platform_selected
from .products import get_owned_product

router = APIRouter(tags=["insights"])


@router.get("/products/{product_id}/overview", response_model=OverviewResponse)
async def get_overview(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> OverviewResponse:
    product = await get_owned_product(session, user.id, product_id)
    return await compute_overview(session, product.id)


@router.get(
    "/products/{product_id}/competitors/summary",
    response_model=list[CompetitorSummaryRow],
)
async def get_competitor_summary(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[CompetitorSummaryRow]:
    product = await get_owned_product(session, user.id, product_id)
    return await compute_competitor_rows(session, product.id)


@router.get("/products/{product_id}/weekly", response_model=WeeklyResponse)
async def get_weekly(
    product_id: str,
    platform: str | None = Query(default=None, max_length=32),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> WeeklyResponse:
    product = await get_owned_product(session, user.id, product_id)
    if platform is not None:
        await ensure_platform_selected(session, product.id, platform)
    return await compute_weekly(session, product.id, platform=platform)


@router.get("/products/{product_id}/weekly/report.csv")
async def get_weekly_report_csv(
    product_id: str,
    platform: str | None = Query(default=None, max_length=32),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    product = await get_owned_product(session, user.id, product_id)
    if platform is not None:
        await ensure_platform_selected(session, product.id, platform)
    now = datetime.now(UTC)
    daily_start = (now - timedelta(days=13)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    rows = await daily_entity_rows(
        session, product.id, platform=platform, start=daily_start, now=now
    )
    csv_text = build_weekly_csv(rows, this_week_start=now - timedelta(days=7))
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="weekly-report-{product_id}.csv"'
        },
    )


@router.get("/products/{product_id}/reviews", response_model=ReviewsResponse)
async def get_reviews(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ReviewsResponse:
    product = await get_owned_product(session, user.id, product_id)
    return await compute_reviews(session, product.id)
