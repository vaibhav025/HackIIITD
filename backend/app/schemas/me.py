from datetime import datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict

from .common import Language, PatchModel, TimezoneName, optional_text, required_text


class ProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    email: str
    business_name: str | None
    business_type: str
    language: str
    timezone: str
    default_city: str | None
    created_at: datetime


class UsageResponse(BaseModel):
    products: int
    # Distinct pincodes across every product (account-wide).
    pincodes: int
    # Plan limits are per product, so these compare against them.
    max_pincodes_per_product: int = 0
    max_competitors_per_product: int = 0
    checks_this_week: int


class MeResponse(BaseModel):
    profile: ProfileResponse
    plan: str
    usage: UsageResponse


PersonName = required_text(200)
BusinessName = optional_text(200)
# The options the settings page offers; stored values outside it still read back.
BusinessType = Literal["marketplace_seller", "d2c_brand", "brand_team"]
CityName = optional_text(100)


class ProfileUpdate(PatchModel):
    nullable_fields: ClassVar[frozenset[str]] = frozenset(
        {"business_name", "default_city"}
    )

    name: PersonName | None = None
    business_name: BusinessName = None
    business_type: BusinessType | None = None
    language: Language | None = None
    timezone: TimezoneName | None = None
    default_city: CityName = None
