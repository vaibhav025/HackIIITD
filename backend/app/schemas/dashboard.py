from datetime import datetime

from pydantic import BaseModel


class StatTile(BaseModel):
    key: str
    label: str
    value: int | float


class DashboardAlert(BaseModel):
    id: str
    product_id: str
    product_name: str | None
    kind: str
    message: str
    evidence: dict
    created_at: datetime
    read: bool


class DashboardRecommendation(BaseModel):
    id: str
    product_id: str
    product_name: str | None
    priority: str
    action_text: str
    impact_text: str
    created_at: datetime


class TelegramStatus(BaseModel):
    connected: bool
    total: int


class PlanMeters(BaseModel):
    """Plan usage measured the same way the plan limits are enforced."""

    plan: str
    products: int
    product_limit: int | None
    # Pincode limits apply per product: the busiest product vs that limit.
    max_pincodes_per_product: int
    pincode_limit_per_product: int | None
    # Credits spent today (UTC day) vs the daily credit budget.
    credits_today: int
    daily_credit_budget: int | None


class DashboardResponse(BaseModel):
    meters: PlanMeters | None = None
    tiles: list[StatTile]
    alerts: list[DashboardAlert]
    recommendations: list[DashboardRecommendation]
    telegram: TelegramStatus
