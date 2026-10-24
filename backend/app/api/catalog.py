"""Read-only catalog endpoints plus per-product selection and listing links."""

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..db import get_session
from ..deps import get_current_user
from ..models.product import Pincode, ProductListing, ProductPincode
from ..models.telegram import TelegramLinkCode
from ..models.user import User
from ..schemas.common import PLATFORMS, Platform, WebUrl, required_text
from ..schemas.products import AlertRuleOut, PincodeSelection
from ..services.ai import get_ai_provider, with_fallback
from ..services.ai.fallback import FallbackAIProvider
from ..services.alerts import ALERT_KINDS, resolve_rule_pincodes
from ..services.plans import PLAN_LIMITS
from ..services.telegram import redeem_link_code
from .products import get_owned_product, get_user_plan

router = APIRouter(tags=["catalog"])

LinkCodeText = required_text(64)
RuleSentence = required_text(500)


class PincodeOut(BaseModel):
    code: str
    area_name: str
    city: str
    lat: float
    lng: float


class PlanLimitsOut(BaseModel):
    plan: str
    products: int | None
    pincodes: int | None
    competitors: int
    minimum_frequency_hours: int | None
    daily_credit_budget: int | None


class PlansResponse(BaseModel):
    current: str
    plans: list[PlanLimitsOut]
    platforms: list[str]


class ListingItem(BaseModel):
    platform: Platform
    url: WebUrl = None


class ListingOut(BaseModel):
    platform: str
    url: str | None = None


class ListingsUpdate(BaseModel):
    listings: list[ListingItem] = Field(max_length=len(PLATFORMS))


class SimulateLinkRequest(BaseModel):
    code: LinkCodeText
    chat_type: Literal["personal", "group"] = "personal"


class AlertRuleParseRequest(BaseModel):
    text: RuleSentence


# What the rule engine can evaluate; anything else is rejected at parse time
# instead of being saved as a rule that never fires.
SUPPORTED_RULES_HINT = (
    "Try one of: “Alert me if we go out of stock”, “…out of stock in South Delhi” "
    "(or a pincode like 110017), “price changes by more than 5%”, “my price is "
    "more than 5% above the rival”, “rating drops below 4”, or “a competitor "
    "goes out of stock”."
)
_RIVAL_RE = re.compile(r"\b(rival|rivals|competitor|competitors|cheapest)\b")
_GAP_RE = re.compile(
    r"\b(above|higher than|more expensive|costlier|undercut|cheaper than|gap)\b"
)
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)")


def _price_gap_rule(text: str) -> AlertRuleOut | None:
    """“Price more than 5% above the rival” — the parsers read it as a price change."""
    lowered = text.lower()
    if "stock" in lowered or not _RIVAL_RE.search(lowered):
        return None
    if not _GAP_RE.search(lowered) or not re.search(r"\bpric", lowered):
        return None
    match = _PCT_RE.search(lowered)
    return AlertRuleOut(
        kind="price_gap_pct",
        threshold=float(match.group(1)) if match else None,
        rule_text=text,
        rule_json={"trigger": "price above rival"},
    )


def _unsupported(message: str) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"code": "unsupported_rule", "message": f"{message} {SUPPORTED_RULES_HINT}"},
    )


@router.get("/pincodes", response_model=list[PincodeOut])
async def list_pincodes(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[PincodeOut]:
    rows = await session.scalars(select(Pincode).order_by(Pincode.code))
    return [
        PincodeOut(
            code=row.code, area_name=row.area_name, city=row.city, lat=row.lat, lng=row.lng
        )
        for row in rows
    ]


@router.get("/plans", response_model=PlansResponse)
async def list_plans(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> PlansResponse:
    return PlansResponse(
        current=await get_user_plan(session, user.id),
        plans=[
            PlanLimitsOut(
                plan=name,
                products=limits.products,
                pincodes=limits.pincodes,
                competitors=limits.competitors,
                minimum_frequency_hours=limits.minimum_frequency_hours,
                daily_credit_budget=limits.daily_credit_budget,
            )
            for name, limits in PLAN_LIMITS.items()
        ],
        platforms=list(PLATFORMS),
    )


@router.get("/products/{product_id}/pincodes", response_model=PincodeSelection)
async def get_pincode_selection(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PincodeSelection:
    await get_owned_product(session, user.id, product_id)
    rows = (
        await session.execute(
            select(ProductPincode.pincode, ProductPincode.platform).where(
                ProductPincode.product_id == product_id
            )
        )
    ).all()
    # model_construct skips the non-empty validation meant for writes; a new product has none.
    pincodes = sorted({row.pincode for row in rows})
    platforms = sorted({row.platform for row in rows})
    return PincodeSelection.model_construct(platforms=platforms, pincodes=pincodes)


@router.get("/products/{product_id}/listings", response_model=list[ListingOut])
async def get_listings(
    product_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[ListingOut]:
    await get_owned_product(session, user.id, product_id)
    rows = await session.scalars(
        select(ProductListing)
        .where(ProductListing.product_id == product_id)
        .order_by(ProductListing.platform)
    )
    return [ListingOut(platform=row.platform, url=row.url) for row in rows]


@router.put("/products/{product_id}/listings", response_model=list[ListingOut])
async def replace_listings(
    product_id: str,
    payload: ListingsUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[ListingOut]:
    await get_owned_product(session, user.id, product_id)
    await session.execute(
        delete(ProductListing).where(ProductListing.product_id == product_id)
    )
    # One listing per platform; a repeated platform keeps its last entry.
    items = list({item.platform: item for item in payload.listings}.values())
    session.add_all(
        ProductListing(product_id=product_id, platform=item.platform, url=item.url)
        for item in items
    )
    await session.commit()
    return [ListingOut(platform=item.platform, url=item.url) for item in items]


@router.post("/products/{product_id}/alert-rules/parse", response_model=AlertRuleOut)
async def parse_alert_rule(
    product_id: str,
    payload: AlertRuleParseRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AlertRuleOut:
    """Turn a plain-English rule into a structured one; the client saves it via PUT."""
    await get_owned_product(session, user.id, product_id)
    rule = _price_gap_rule(payload.text)
    if rule is None:
        rule, _source = await with_fallback(
            get_ai_provider(), "parse_alert_rule", payload.text
        )
    if rule.kind == "custom" or rule.kind not in ALERT_KINDS:
        # The model may punt on text the keyword parser still understands.
        rule = await FallbackAIProvider().parse_alert_rule(payload.text)
    if rule.kind == "custom" or rule.kind not in ALERT_KINDS:
        raise _unsupported("ShelfSense can't watch for that yet.")
    rule_json = dict(rule.rule_json or {})
    if rule.kind == "oos_area":
        # Show the seller exactly which pincodes "South Delhi" etc. cover.
        named = [str(code) for code in rule_json.get("pincodes") or []]
        areas = [str(area) for area in rule_json.get("areas") or []]
        resolved = await resolve_rule_pincodes(session, areas)
        rule_json["pincodes"] = sorted(set(named) | set(resolved))
        if not rule_json["pincodes"]:
            raise _unsupported(
                f"No tracked pincodes match {', '.join(areas) or 'that area'}."
            )
    return AlertRuleOut(
        kind=rule.kind,
        threshold=rule.threshold,
        rule_text=rule.rule_text or payload.text,
        rule_json=rule_json,
    )


@router.post("/products/{product_id}/telegram/simulate-link", status_code=204)
async def simulate_telegram_link(
    product_id: str,
    payload: SimulateLinkRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> None:
    """Mock mode only: redeem a link code as if the bot had received `/start <code>`."""
    if settings.is_production:
        raise HTTPException(status_code=404, detail="Not found")
    if settings.telegram_enabled:
        raise HTTPException(status_code=409, detail="A real Telegram bot is configured")
    await get_owned_product(session, user.id, product_id)
    code = await session.get(TelegramLinkCode, payload.code)
    if code is None or code.product_id != product_id or code.user_id != user.id:
        raise HTTPException(status_code=404, detail="Link code not found")
    is_group = payload.chat_type == "group"
    link = await redeem_link_code(
        session,
        code_value=payload.code,
        chat_id=f"demo-{'group' if is_group else 'chat'}-{user.id[:8]}",
        chat_title="Demo sales group" if is_group else f"{user.name} (demo)",
    )
    if link is None:
        raise HTTPException(status_code=422, detail="Link code expired or already used")
