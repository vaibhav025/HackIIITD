from datetime import datetime
from typing import Annotated, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .common import (
    AlertKind,
    CheckFrequency,
    NonNegativeFloat,
    PatchModel,
    PincodeCode,
    Platform,
    WebUrl,
    optional_text,
    required_text,
)

ProductName = required_text(300)
SearchQuery = required_text(500)
BrandName = optional_text(200)
OptionalQuery = optional_text(500)
RuleText = optional_text(500)
MarginPct = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
ChangePct = Annotated[float, Field(ge=0, le=50, allow_inf_nan=False)]
# Platform commission on the selling price; quick commerce is typically 18-35%.
CommissionPct = Annotated[float, Field(ge=0, le=60, allow_inf_nan=False)]
MrpPrice = Annotated[float, Field(gt=0, allow_inf_nan=False)]
# essential = 4%, regular = 7%, premium = 10% gap before a price suggestion.
PriceSensitivity = Literal["essential", "regular", "premium"]

FLOOR_BELOW_COST = "Floor price is below your cost price"
MRP_BELOW_FLOOR = "MRP is below your floor price"
MRP_BELOW_COST = "MRP is below your cost price"

MAX_PINCODES_PER_SELECTION = 200
MAX_ALERT_RULES = 50


def floor_below_cost(cost_price: float | None, floor_price: float | None) -> bool:
    return cost_price is not None and floor_price is not None and floor_price < cost_price


def mrp_problem(
    mrp: float | None, floor_price: float | None, cost_price: float | None
) -> str | None:
    """Why an MRP contradicts the floor or cost price, else None."""
    if mrp is None:
        return None
    if floor_price is not None and mrp < floor_price:
        return MRP_BELOW_FLOOR
    if cost_price is not None and mrp < cost_price:
        return MRP_BELOW_COST
    return None


class ProductCreate(BaseModel):
    name: ProductName
    brand: BrandName = None
    search_query: SearchQuery
    image_url: WebUrl = None
    cost_price: NonNegativeFloat | None = None
    min_margin_pct: MarginPct = 10
    max_change_pct: ChangePct = 10
    floor_price: NonNegativeFloat | None = None
    commission_pct: CommissionPct | None = None
    mrp: MrpPrice | None = None
    price_sensitivity: PriceSensitivity | None = None
    round_to_price_point: bool = False
    # Omitted means "the most frequent schedule the user's plan allows".
    check_frequency: CheckFrequency | None = None
    volatile_boost: bool = False
    approval_required: bool = True
    paused: bool = False

    @model_validator(mode="after")
    def floor_not_below_cost(self) -> "ProductCreate":
        if floor_below_cost(self.cost_price, self.floor_price):
            raise ValueError(FLOOR_BELOW_COST)
        problem = mrp_problem(self.mrp, self.floor_price, self.cost_price)
        if problem:
            raise ValueError(problem)
        return self


class ProductUpdate(PatchModel):
    nullable_fields: ClassVar[frozenset[str]] = frozenset(
        {
            "brand",
            "image_url",
            "cost_price",
            "floor_price",
            "commission_pct",
            "mrp",
            "price_sensitivity",
        }
    )

    name: ProductName | None = None
    brand: BrandName = None
    search_query: SearchQuery | None = None
    image_url: WebUrl = None
    cost_price: NonNegativeFloat | None = None
    min_margin_pct: MarginPct | None = None
    max_change_pct: ChangePct | None = None
    floor_price: NonNegativeFloat | None = None
    commission_pct: CommissionPct | None = None
    mrp: MrpPrice | None = None
    price_sensitivity: PriceSensitivity | None = None
    round_to_price_point: bool | None = None
    check_frequency: CheckFrequency | None = None
    volatile_boost: bool | None = None
    approval_required: bool | None = None
    paused: bool | None = None


class ProductResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    name: str
    brand: str | None
    search_query: str
    image_url: str | None
    cost_price: float | None
    min_margin_pct: float
    max_change_pct: float
    floor_price: float | None
    commission_pct: float | None = None
    mrp: float | None = None
    price_sensitivity: str = "regular"
    round_to_price_point: bool = False
    check_frequency: str
    volatile_boost: bool
    approval_required: bool
    paused: bool
    created_at: datetime

    @field_validator("price_sensitivity", mode="before")
    @classmethod
    def default_sensitivity(cls, value: object) -> object:
        return "regular" if value is None else value

    @field_validator("round_to_price_point", mode="before")
    @classmethod
    def default_rounding(cls, value: object) -> object:
        return False if value is None else value


class ProductCard(ProductResponse):
    """Product plus coverage of its selected (platform, pincode) pairs.

    Each pair is counted once, from its latest own result, so the counts never
    overlap: ``total_pairs == ok_pairs + gap_pairs + oos_pairs + stale_pairs``.
    ``ok_pairs`` is in stock at a competitive price and excludes price-gap pairs
    (in stock overall = ``ok_pairs + gap_pairs``). ``stale_pairs`` covers failed,
    out-of-date (>24 h) and never-checked pairs. ``status_strip`` shows at most
    12 pairs, worst first.
    """

    status_strip: list[dict[str, str]]
    total_pairs: int
    ok_pairs: int
    oos_pairs: int
    gap_pairs: int
    stale_pairs: int
    state: Literal["ok", "attention", "paused", "never_checked"]
    price_position_vs_avg_rival: float | None
    last_checked: datetime | None
    telegram_connected: bool


class PincodeSelection(BaseModel):
    platforms: list[Platform] = Field(min_length=1, max_length=5)
    pincodes: list[PincodeCode] = Field(
        min_length=1, max_length=MAX_PINCODES_PER_SELECTION
    )


class AlertRuleInput(BaseModel):
    kind: AlertKind
    threshold: NonNegativeFloat | None = None
    rule_text: RuleText = None
    rule_json: dict = Field(default_factory=dict)
    active: bool = True


class AlertRuleOut(BaseModel):
    """Stored or default rule as returned to clients (no write-side constraints)."""

    kind: str
    threshold: float | None = None
    rule_text: str | None = None
    rule_json: dict = Field(default_factory=dict)
    active: bool = True


class AlertRulesUpdate(BaseModel):
    rules: list[AlertRuleInput] = Field(max_length=MAX_ALERT_RULES)


class CompetitorCreate(BaseModel):
    name: ProductName
    platform: Platform
    url: WebUrl = None
    search_query: OptionalQuery = None
    confirmed: bool = False


class CompetitorResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    product_id: str
    name: str
    platform: str
    url: str | None
    search_query: str | None
    confirmed: bool


class CompetitorDiscoveryRequest(BaseModel):
    query: OptionalQuery = None


class CompetitorDiscoveryResponse(BaseModel):
    suggestions: list[CompetitorCreate]
    source: str
