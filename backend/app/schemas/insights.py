from datetime import datetime

from pydantic import BaseModel


class SparklineKpi(BaseModel):
    value: float | None
    sparkline: list[float | None]


class StockKpi(BaseModel):
    value: int
    total: int
    sparkline: list[float | None]


class OverviewKpis(BaseModel):
    avg_price: SparklineKpi
    cheapest_rival: SparklineKpi
    in_stock: StockKpi
    rating: SparklineKpi


class SummaryItem(BaseModel):
    summary_text: str
    evidence: dict
    source: str
    created_at: datetime


class RecommendationItem(BaseModel):
    id: str
    product_id: str
    priority: str
    action_text: str
    impact_text: str
    evidence: dict
    status: str
    created_at: datetime


class OverviewResponse(BaseModel):
    kpis: OverviewKpis
    summary: SummaryItem | None
    recommendations: list[RecommendationItem]


class CompetitorSummaryRow(BaseModel):
    entity_id: str | None
    name: str
    is_seller: bool
    platform: str
    price: float | None
    in_stock: int
    total: int
    rating: float | None
    eta_minutes: float | None
    price_delta_pct: float | None
    checked_at: datetime | None


class WeeklyWindow(BaseModel):
    avg_price: float | None
    oos_count: int
    rating: float | None
    search_rank: float | None


class WeeklySeriesEntity(BaseModel):
    entity_id: str | None
    name: str
    platform: str
    is_seller: bool
    prices: list[float | None]
    in_stock: list[int]
    checks: list[int]


class WeeklySeries(BaseModel):
    days: list[str]
    entities: list[WeeklySeriesEntity]


class ChangelogEntry(BaseModel):
    id: str
    competitor_id: str | None
    platform: str
    pincode: str
    kind: str
    old_value: float | None
    new_value: float | None
    detected_at: datetime


class WeeklyResponse(BaseModel):
    platform: str | None
    this_week: WeeklyWindow
    last_week: WeeklyWindow
    series: WeeklySeries
    changelog: list[ChangelogEntry]


class ReviewItem(BaseModel):
    entity_id: str | None
    name: str
    loves: list[str]
    complaints: list[str]
    updated_at: datetime


class ReviewsResponse(BaseModel):
    # The seller's own strengths and weak spots.
    loves: list[str]
    complaints: list[str]
    # Only from competitor review insights; empty when none were collected.
    rival_loves: list[str] = []
    rival_complaints: list[str] = []
    items: list[ReviewItem]
