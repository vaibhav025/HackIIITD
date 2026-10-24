from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .common import PincodeCode, Platform


class RunCreate(BaseModel):
    pincodes: list[PincodeCode] | None = Field(default=None, max_length=200)
    platforms: list[Platform] | None = Field(default=None, max_length=5)


class RunCreated(BaseModel):
    run_id: str
    # Agent sessions cost 1 credit each; Fetch reads (Amazon, Flipkart) are free.
    estimated_credits: int
    total_jobs: int = 0


class SkippedPlatform(BaseModel):
    platform: str
    reason: str


class RunEstimate(BaseModel):
    """What a run with this selection would execute (mirrors the runner)."""

    jobs: int
    credits: int
    agent_jobs: int
    platforms: list[str]
    pincodes: list[str]
    # Selected apps live mode does not check (TINYFISH_LIVE_PLATFORMS).
    skipped_platforms: list[SkippedPlatform] = Field(default_factory=list)
    # Credits left in today's plan budget; None = unlimited.
    remaining_credits: int | None = None


class RunResultItem(BaseModel):
    id: str
    job_key: str
    platform: str
    pincode: str
    competitor_id: str | None
    status: str
    price: float | None
    in_stock: bool | None
    screenshot_url: str | None
    # Full per-check detail for the Agents page.
    mrp: float | None = None
    eta_minutes: int | None = None
    area: str | None = None
    error: str | None = None
    checked_at: datetime | None = None
    method: Literal["agent", "fetch", "browser", "cached", "simulated"] = "simulated"
    pincode_specific: bool = True
    source_url: str | None = None
    delivery_text: str | None = None
    notes: list[str] = Field(default_factory=list)
    step_count: int = 0
    exact_match: bool = True


class RunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    product_id: str
    trigger: str
    status: str
    total_jobs: int
    done_jobs: int
    failed_jobs: int
    credits_used: int
    started_at: datetime | None
    finished_at: datetime | None


class RunDetail(RunResponse):
    mode: str
    results: list[RunResultItem] = Field(default_factory=list)


class RunSummary(RunResponse):
    product_name: str
    mode: str


class CheckResultDetail(BaseModel):
    id: str
    run_id: str
    product_id: str
    competitor_id: str | None
    platform: str
    pincode: str
    in_stock: bool | None
    price: float | None
    mrp: float | None
    eta_minutes: int | None
    rating: float | None
    status: str
    error: str | None
    screenshot_url: str | None
    checked_at: datetime
    agent: dict | None


class TinyFishUsage(BaseModel):
    mode: str
    concurrency: int
    credits_today: int
    daily_budget: int | None
    runs_today: int
    success_rate_7d: float | None


class AppStatus(BaseModel):
    platform: str
    label: str
    status: Literal["live", "cached", "unavailable", "simulated"]
    method: Literal["agent", "fetch", "simulated", "none"]
    pincode_specific: bool
    detail: str
