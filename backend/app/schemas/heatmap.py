from datetime import datetime

from pydantic import BaseModel, Field


class HeatmapPin(BaseModel):
    pincode: str
    area: str | None
    lat: float | None
    lng: float | None
    status: str
    # Why a stale pin is grey: missing / failed / old, or "unavailable" when
    # live mode never checks this app (TINYFISH_LIVE_PLATFORMS).
    stale_reason: str | None = None
    price: float | None
    rival_price: float | None
    mrp: float | None
    eta: int | None
    checked_at: datetime | None
    platform: str


class HeatmapSummary(BaseModel):
    in_stock: int
    out_of_stock: int
    price_gap: int
    stale: int
    failed: int = 0
    unavailable: int = 0
    total: int


class HotZone(BaseModel):
    lat: float
    lng: float
    count: int
    pincodes: list[str]


class UnavailablePlatform(BaseModel):
    platform: str
    reason: str


class HeatmapResponse(BaseModel):
    pins: list[HeatmapPin]
    summary: HeatmapSummary
    hot_zones: list[HotZone]
    platform: str | None
    snapshot: str
    unavailable_platforms: list[UnavailablePlatform] = Field(default_factory=list)


class SellerPinDetail(BaseModel):
    in_stock: bool | None
    price: float | None
    mrp: float | None
    eta: int | None
    rating: float | None
    status: str
    checked_at: datetime | None
    run_id: str | None
    result_id: str | None = None
    screenshot_url: str | None


class RivalPinDetail(BaseModel):
    competitor_id: str
    name: str
    in_stock: bool | None
    price: float | None
    mrp: float | None
    eta: int | None
    rating: float | None
    status: str
    checked_at: datetime | None
    result_id: str | None = None
    run_id: str | None = None


class PinPlatformDetail(BaseModel):
    platform: str
    status: str
    unavailable_reason: str | None = None
    seller: SellerPinDetail
    rivals: list[RivalPinDetail]


class PinDetailResponse(BaseModel):
    pincode: str
    area: str
    city: str
    lat: float
    lng: float
    platforms: list[PinPlatformDetail]
