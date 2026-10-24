"""Pincode heatmap endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.product import ProductPincode
from ..models.user import User
from ..schemas.heatmap import HeatmapResponse, PinDetailResponse
from ..services.heatmap import compute_heatmap, compute_pin_detail
from .products import get_owned_product

router = APIRouter(tags=["heatmap"])


async def ensure_platform_selected(
    session: AsyncSession, product_id: str, platform: str
) -> None:
    selected = await session.scalar(
        select(ProductPincode.product_id)
        .where(
            ProductPincode.product_id == product_id,
            ProductPincode.platform == platform,
        )
        .limit(1)
    )
    if selected is None:
        raise HTTPException(
            status_code=422,
            detail=f"Platform {platform} is not selected for this product",
        )


@router.get("/products/{product_id}/heatmap", response_model=HeatmapResponse)
async def get_heatmap(
    product_id: str,
    platform: str | None = Query(default=None, max_length=32),
    snapshot: str = Query(default="now", pattern="^(now|6h|24h|7d)$"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HeatmapResponse:
    product = await get_owned_product(session, user.id, product_id)
    if platform is not None:
        await ensure_platform_selected(session, product.id, platform)
    return await compute_heatmap(
        session, product.id, platform=platform, snapshot=snapshot
    )


@router.get(
    "/products/{product_id}/heatmap/pincodes/{code}", response_model=PinDetailResponse
)
async def get_pincode_detail(
    product_id: str,
    code: str,
    platform: str | None = Query(default=None, max_length=32),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PinDetailResponse:
    product = await get_owned_product(session, user.id, product_id)
    if platform is not None:
        await ensure_platform_selected(session, product.id, platform)
    detail = await compute_pin_detail(
        session, product.id, code, platform=platform
    )
    if detail is None:
        raise HTTPException(
            status_code=404, detail="Pincode not found for this product"
        )
    return detail
