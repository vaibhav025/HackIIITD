from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.checks import CheckResult
from ..models.product import Competitor, Product, ProductPincode
from ..models.user import Subscription, User
from ..schemas.me import MeResponse, ProfileResponse, ProfileUpdate, UsageResponse

router = APIRouter(tags=["account"])


@router.get("/me", response_model=MeResponse)
async def get_me(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)
) -> MeResponse:
    plan = await session.scalar(
        select(Subscription.plan)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.id)
    )
    products = await session.scalar(
        select(func.count()).select_from(Product).where(Product.user_id == user.id)
    )
    pincodes = await session.scalar(
        select(func.count(func.distinct(ProductPincode.pincode)))
        .select_from(ProductPincode)
        .join(Product, Product.id == ProductPincode.product_id)
        .where(Product.user_id == user.id)
    )
    # Plan pincode/competitor limits are per product: report the busiest product.
    per_product_pincodes = (
        select(func.count(func.distinct(ProductPincode.pincode)).label("n"))
        .join(Product, Product.id == ProductPincode.product_id)
        .where(Product.user_id == user.id)
        .group_by(ProductPincode.product_id)
        .subquery()
    )
    max_pincodes = await session.scalar(select(func.max(per_product_pincodes.c.n)))
    per_product_competitors = (
        select(func.count(Competitor.id).label("n"))
        .join(Product, Product.id == Competitor.product_id)
        .where(Product.user_id == user.id)
        .group_by(Competitor.product_id)
        .subquery()
    )
    max_competitors = await session.scalar(
        select(func.max(per_product_competitors.c.n))
    )
    since = datetime.now(UTC) - timedelta(days=7)
    checks = await session.scalar(
        select(func.count())
        .select_from(CheckResult)
        .join(Product, Product.id == CheckResult.product_id)
        .where(Product.user_id == user.id, CheckResult.checked_at >= since)
    )
    return MeResponse(
        profile=ProfileResponse.model_validate(user),
        plan=plan or "free",
        usage=UsageResponse(
            products=products or 0,
            pincodes=pincodes or 0,
            max_pincodes_per_product=max_pincodes or 0,
            max_competitors_per_product=max_competitors or 0,
            checks_this_week=checks or 0,
        ),
    )


@router.patch("/me", response_model=ProfileResponse)
async def update_me(
    payload: ProfileUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> ProfileResponse:
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await session.commit()
    await session.refresh(user)
    return ProfileResponse.model_validate(user)
