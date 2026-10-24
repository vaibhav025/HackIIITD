"""User-scoped product, pincode, and alert-rule endpoints."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import Select, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import get_current_user
from ..models.chat import ChatConversation, ChatMessage
from ..models.checks import ChangeEvent, CheckResult, CheckRun, CreditLedger
from ..models.intelligence import (
    AISummary,
    Alert,
    AlertRule,
    Recommendation,
    ReviewInsight,
)
from ..models.product import (
    Competitor,
    Pincode,
    Product,
    ProductListing,
    ProductPincode,
)
from ..models.telegram import TelegramLink, TelegramLinkCode
from ..models.user import Subscription, User
from ..schemas.products import (
    FLOOR_BELOW_COST,
    AlertRuleOut,
    AlertRulesUpdate,
    PincodeSelection,
    ProductCard,
    ProductCreate,
    ProductResponse,
    ProductUpdate,
    floor_below_cost,
    mrp_problem,
)
from ..services.alerts import replace_alert_rules as store_alert_rules
from ..services.heatmap import STATUS_RANK, classify_pin_status
from ..services.plans import (
    enforce_frequency,
    enforce_pincode_limit,
    enforce_product_limit,
    minimum_frequency,
)
from ..services.runner import cancel_runs_for_product
from .media import remove_product_media

router = APIRouter(tags=["products"])

ACTIVE_RUN_STATUSES = ("queued", "running")
CARD_HISTORY_WINDOW = timedelta(days=14)
STATUS_STRIP_LIMIT = 12


async def get_user_plan(session: AsyncSession, user_id: str) -> str:
    return (
        await session.scalar(
            select(Subscription.plan).where(Subscription.user_id == user_id)
        )
    ) or "free"


async def get_owned_product(
    session: AsyncSession, user_id: str, product_id: str
) -> Product:
    product = await session.scalar(
        select(Product).where(Product.id == product_id, Product.user_id == user_id)
    )
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


async def has_active_run(session: AsyncSession, product_id: str) -> bool:
    return (
        await session.scalar(
            select(CheckRun.id)
            .where(
                CheckRun.product_id == product_id,
                CheckRun.status.in_(ACTIVE_RUN_STATUSES),
            )
            .limit(1)
        )
    ) is not None


def validation_failure(field: str, message: str) -> HTTPException:
    """A 422 shaped like request validation, for checks that need stored state."""
    return HTTPException(
        status_code=422,
        detail={
            "code": "validation_error",
            "message": "Request validation failed",
            "fields": [{"loc": f"body.{field}", "msg": message}],
        },
    )


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def build_cards(
    session: AsyncSession, products: list[Product], *, now: datetime | None = None
) -> list[ProductCard]:
    """Cards for many products with a fixed number of queries.

    Each selected (platform, pincode) pair is classified from its latest own
    result in the history window, the same way the heatmap classifies pins.
    """
    if not products:
        return []
    now = now or datetime.now(UTC)
    ids = [product.id for product in products]
    window_start = now - CARD_HISTORY_WINDOW

    pairs: dict[str, list[tuple[str, str]]] = {product_id: [] for product_id in ids}
    for product_id, platform, pincode in (
        await session.execute(
            select(
                ProductPincode.product_id,
                ProductPincode.platform,
                ProductPincode.pincode,
            ).where(ProductPincode.product_id.in_(ids))
        )
    ).all():
        pairs[product_id].append((platform, pincode))

    seller: dict[tuple[str, str, str], tuple] = {}
    for row in (
        await session.execute(
            select(
                CheckResult.product_id,
                CheckResult.platform,
                CheckResult.pincode,
                CheckResult.status,
                CheckResult.in_stock,
                CheckResult.price,
                CheckResult.checked_at,
            )
            .where(
                CheckResult.product_id.in_(ids),
                CheckResult.competitor_id.is_(None),
                CheckResult.checked_at >= window_start,
            )
            .order_by(CheckResult.checked_at.desc())
        )
    ).all():
        seller.setdefault((row.product_id, row.platform, row.pincode), row)

    rival_latest: dict[tuple[str, str, str, str], float | None] = {}
    for row in (
        await session.execute(
            select(
                CheckResult.product_id,
                CheckResult.competitor_id,
                CheckResult.platform,
                CheckResult.pincode,
                CheckResult.price,
            )
            .where(
                CheckResult.product_id.in_(ids),
                CheckResult.competitor_id.is_not(None),
                CheckResult.status == "ok",
                CheckResult.checked_at >= window_start,
            )
            .order_by(CheckResult.checked_at.desc())
        )
    ).all():
        rival_latest.setdefault(
            (row.product_id, row.competitor_id, row.platform, row.pincode), row.price
        )
    cheapest_rival: dict[tuple[str, str, str], float] = {}
    for (product_id, _competitor, platform, pincode), price in rival_latest.items():
        if price is None:
            continue
        key = (product_id, platform, pincode)
        cheapest_rival[key] = min(price, cheapest_rival.get(key, price))

    last_checked = dict(
        (
            await session.execute(
                select(CheckResult.product_id, func.max(CheckResult.checked_at))
                .where(
                    CheckResult.product_id.in_(ids),
                    CheckResult.competitor_id.is_(None),
                )
                .group_by(CheckResult.product_id)
            )
        ).all()
    )
    linked = set(
        (
            await session.scalars(
                select(TelegramLink.product_id)
                .where(TelegramLink.product_id.in_(ids))
                .distinct()
            )
        ).all()
    )

    cards: list[ProductCard] = []
    for product in products:
        strip: list[dict[str, str]] = []
        counts = dict.fromkeys(STATUS_RANK, 0)
        own_prices: list[float] = []
        rival_prices: list[float] = []
        for platform, pincode in pairs[product.id]:
            key = (product.id, platform, pincode)
            latest = seller.get(key)
            rival = cheapest_rival.get(key)
            pair_status = classify_pin_status(
                latest.status if latest else None,
                latest.in_stock if latest else None,
                latest.price if latest else None,
                latest.checked_at if latest else None,
                rival,
                now,
            )
            counts[pair_status] += 1
            strip.append({"platform": platform, "pincode": pincode, "status": pair_status})
            if latest is not None and latest.status == "ok" and latest.price is not None:
                own_prices.append(latest.price)
            if rival is not None:
                rival_prices.append(rival)
        strip.sort(key=lambda item: (STATUS_RANK[item["status"]], item["pincode"]))

        checked_at = last_checked.get(product.id)
        if product.paused:
            state = "paused"
        elif checked_at is None:
            state = "never_checked"
        elif counts["out_of_stock"] or counts["price_gap"] or counts["stale"]:
            state = "attention"
        else:
            state = "ok"
        position = None
        if own_prices and rival_prices:
            position = round(
                (
                    (sum(own_prices) / len(own_prices))
                    / (sum(rival_prices) / len(rival_prices))
                    - 1
                )
                * 100,
                2,
            )
        cards.append(
            ProductCard(
                **ProductResponse.model_validate(product).model_dump(),
                status_strip=strip[:STATUS_STRIP_LIMIT],
                total_pairs=len(pairs[product.id]),
                ok_pairs=counts["in_stock"],
                oos_pairs=counts["out_of_stock"],
                gap_pairs=counts["price_gap"],
                stale_pairs=counts["stale"],
                state=state,
                price_position_vs_avg_rival=position,
                last_checked=checked_at,
                telegram_connected=product.id in linked,
            )
        )
    return cards


async def delete_product_data(
    session: AsyncSession, product_ids: Select | list[str]
) -> None:
    """Remove products and everything that references them, children first.

    Explicit ordered deletes keep this portable to databases created before the
    `ON DELETE` rules existed. Credit ledger rows are kept for the daily budget;
    only their run reference is cleared.
    """
    run_ids = select(CheckRun.id).where(CheckRun.product_id.in_(product_ids))
    conversation_ids = select(ChatConversation.id).where(
        ChatConversation.product_id.in_(product_ids)
    )
    await session.execute(
        delete(ChatMessage).where(ChatMessage.conversation_id.in_(conversation_ids))
    )
    await session.execute(
        delete(ChatConversation).where(ChatConversation.product_id.in_(product_ids))
    )
    await session.execute(
        update(CreditLedger)
        .where(CreditLedger.run_id.in_(run_ids))
        .values(run_id=None)
    )
    for model in (
        CheckResult,
        ChangeEvent,
        AISummary,
        Alert,
        AlertRule,
        Recommendation,
        ReviewInsight,
        TelegramLinkCode,
        TelegramLink,
        ProductListing,
        ProductPincode,
        Competitor,
        CheckRun,
    ):
        await session.execute(delete(model).where(model.product_id.in_(product_ids)))
    await session.execute(delete(Product).where(Product.id.in_(product_ids)))


@router.get("/products", response_model=list[ProductCard])
async def list_products(
    filter: str | None = Query(default=None, pattern="^(attention|healthy|paused)$"),
    q: str | None = Query(default=None, max_length=300),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[ProductCard]:
    statement = (
        select(Product)
        .where(Product.user_id == user.id)
        .order_by(Product.created_at.desc())
    )
    if q and q.strip():
        statement = statement.where(
            Product.name.ilike(f"%{escape_like(q.strip())}%", escape="\\")
        )
    cards = await build_cards(session, list((await session.scalars(statement)).all()))
    wanted = {"attention": "attention", "healthy": "ok", "paused": "paused"}
    if filter is not None:
        cards = [card for card in cards if card.state == wanted[filter]]
    return cards


@router.post(
    "/products", response_model=ProductResponse, status_code=status.HTTP_201_CREATED
)
async def create_product(
    payload: ProductCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Product:
    plan = await get_user_plan(session, user.id)
    product_count = await session.scalar(
        select(func.count()).select_from(Product).where(Product.user_id == user.id)
    )
    enforce_product_limit(plan, product_count or 0)
    values = payload.model_dump()
    values["check_frequency"] = payload.check_frequency or minimum_frequency(plan)
    enforce_frequency(plan, values["check_frequency"])
    product = Product(user_id=user.id, **values)
    session.add(product)
    await session.commit()
    await session.refresh(product)
    return product


@router.get("/products/{product_id}", response_model=ProductResponse)
async def get_product(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Product:
    return await get_owned_product(session, user.id, product_id)


@router.patch("/products/{product_id}", response_model=ProductResponse)
async def update_product(
    product_id: str,
    payload: ProductUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Product:
    product = await get_owned_product(session, user.id, product_id)
    changes = payload.model_dump(exclude_unset=True)
    if "check_frequency" in changes:
        enforce_frequency(
            await get_user_plan(session, user.id), changes["check_frequency"]
        )
    if floor_below_cost(
        changes.get("cost_price", product.cost_price),
        changes.get("floor_price", product.floor_price),
    ):
        raise validation_failure("floor_price", FLOOR_BELOW_COST)
    problem = mrp_problem(
        changes.get("mrp", product.mrp),
        changes.get("floor_price", product.floor_price),
        changes.get("cost_price", product.cost_price),
    )
    if problem:
        raise validation_failure("mrp", problem)
    for field, value in changes.items():
        setattr(product, field, value)
    await session.commit()
    await session.refresh(product)
    return product


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_product(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    await get_owned_product(session, user.id, product_id)
    await cancel_runs_for_product(product_id)
    await delete_product_data(session, [product_id])
    await session.commit()
    await remove_product_media([product_id])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/products/{product_id}/pincodes", response_model=PincodeSelection)
async def replace_pincodes(
    product_id: str,
    payload: PincodeSelection,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PincodeSelection:
    await get_owned_product(session, user.id, product_id)
    pincodes = sorted(set(payload.pincodes))
    platforms = sorted(set(payload.platforms))
    existing = await session.scalar(
        select(func.count()).select_from(Pincode).where(Pincode.code.in_(pincodes))
    )
    if existing != len(pincodes):
        raise validation_failure("pincodes", "One or more pincodes are unknown")
    enforce_pincode_limit(await get_user_plan(session, user.id), len(pincodes))
    await session.execute(
        delete(ProductPincode).where(ProductPincode.product_id == product_id)
    )
    session.add_all(
        ProductPincode(product_id=product_id, pincode=code, platform=platform)
        for code in pincodes
        for platform in platforms
    )
    await session.commit()
    return PincodeSelection(platforms=platforms, pincodes=pincodes)


@router.put("/products/{product_id}/alert-rules", response_model=list[AlertRuleOut])
async def replace_alert_rules(
    product_id: str,
    payload: AlertRulesUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[AlertRuleOut]:
    await get_owned_product(session, user.id, product_id)
    # Clearing every rule is remembered, so defaults don't come back.
    await store_alert_rules(
        session, product_id, [rule.model_dump() for rule in payload.rules]
    )
    await session.commit()
    return [AlertRuleOut(**rule.model_dump()) for rule in payload.rules]
