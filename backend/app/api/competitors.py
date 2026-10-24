"""User-scoped competitor management and discovery."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.checks import ChangeEvent, CheckResult
from ..models.intelligence import ReviewInsight
from ..models.product import Competitor, Product
from ..models.user import User
from ..schemas.products import (
    CompetitorCreate,
    CompetitorDiscoveryRequest,
    CompetitorDiscoveryResponse,
    CompetitorResponse,
)
from ..services.competitor_discovery import discover_competitors
from ..services.plans import competitor_limit
from .products import get_owned_product, get_user_plan, has_active_run

router = APIRouter(tags=["competitors"])

NAME_LIMIT = 300
QUERY_LIMIT = 500


async def get_owned_competitor(
    session: AsyncSession, user_id: str, competitor_id: str
) -> Competitor:
    competitor = await session.scalar(
        select(Competitor)
        .join(Product)
        .where(Competitor.id == competitor_id, Product.user_id == user_id)
    )
    if competitor is None:
        raise HTTPException(status_code=404, detail="Competitor not found")
    return competitor


def _norm_url(url: str | None) -> str:
    return (url or "").strip().rstrip("/").lower()


def _norm_name(name: str | None) -> str:
    return " ".join((name or "").split()).lower()


def same_competitor(
    platform: str, url: str | None, name: str, other: Competitor | CompetitorCreate
) -> bool:
    """Same platform and URL, or (when either has no URL) same platform and name."""
    if platform != other.platform:
        return False
    if url and other.url:
        return _norm_url(url) == _norm_url(other.url)
    return _norm_name(name) == _norm_name(other.name)


def as_suggestion(raw: dict) -> CompetitorCreate | None:
    """Fit a discovery hit into the competitor schema, or drop it."""
    try:
        return CompetitorCreate(
            name=str(raw.get("name") or "")[:NAME_LIMIT],
            platform=raw.get("platform"),
            url=raw.get("url"),
            search_query=(str(raw["search_query"])[:QUERY_LIMIT] if raw.get("search_query") else None),
        )
    except ValidationError:
        return None


@router.get(
    "/products/{product_id}/competitors", response_model=list[CompetitorResponse]
)
async def list_competitors(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[Competitor]:
    await get_owned_product(session, user.id, product_id)
    return list(
        (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    )


@router.post(
    "/products/{product_id}/competitors",
    response_model=CompetitorResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_competitor(
    product_id: str,
    payload: CompetitorCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Competitor:
    await get_owned_product(session, user.id, product_id)
    tracked = list(
        (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    )
    duplicate = next(
        (
            row
            for row in tracked
            if same_competitor(payload.platform, payload.url, payload.name, row)
        ),
        None,
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_competitor",
                "message": f"{duplicate.name} is already tracked on this platform",
            },
        )
    plan = await get_user_plan(session, user.id)
    limit = competitor_limit(plan)
    if len(tracked) >= limit:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "plan_limit_reached",
                "message": f"The {plan} plan allows up to {limit} competitors per product",
            },
        )
    competitor = Competitor(product_id=product_id, **payload.model_dump())
    session.add(competitor)
    await session.commit()
    await session.refresh(competitor)
    return competitor


@router.delete("/competitors/{competitor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_competitor(
    competitor_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    competitor = await get_owned_competitor(session, user.id, competitor_id)
    if await has_active_run(session, competitor.product_id):
        raise HTTPException(
            status_code=409,
            detail="A check run is in progress for this product; try again when it finishes",
        )
    for model in (CheckResult, ChangeEvent, ReviewInsight):
        await session.execute(delete(model).where(model.competitor_id == competitor_id))
    await session.delete(competitor)
    await session.commit()


@router.post(
    "/products/{product_id}/competitors/discover",
    response_model=CompetitorDiscoveryResponse,
)
async def discover(
    product_id: str,
    payload: CompetitorDiscoveryRequest | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> CompetitorDiscoveryResponse:
    product = await get_owned_product(session, user.id, product_id)
    query = payload.query if payload and payload.query else product.search_query
    raw, source = await discover_competitors(query, product.brand)
    tracked = list(
        (
            await session.scalars(
                select(Competitor).where(Competitor.product_id == product_id)
            )
        ).all()
    )
    own_name = _norm_name(product.name)
    suggestions: list[CompetitorCreate] = []
    for item in raw:
        suggestion = as_suggestion(item)
        if suggestion is None or _norm_name(suggestion.name) == own_name:
            continue
        if any(
            same_competitor(suggestion.platform, suggestion.url, suggestion.name, other)
            for other in [*tracked, *suggestions]
        ):
            continue
        suggestions.append(suggestion)
    # source: "tinyfish" (live TinyFish Search) or "demo" (generic placeholders).
    return CompetitorDiscoveryResponse(suggestions=suggestions, source=source)


@router.post("/competitors/{competitor_id}/confirm", response_model=CompetitorResponse)
async def confirm_competitor(
    competitor_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Competitor:
    competitor = await get_owned_competitor(session, user.id, competitor_id)
    competitor.confirmed = True
    await session.commit()
    await session.refresh(competitor)
    return competitor
