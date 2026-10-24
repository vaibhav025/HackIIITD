from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import ClockTime, FiniteFloat, PatchModel

ChannelName = Literal["telegram", "email"]


class UserSettingsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    briefing_time: str
    quiet_hours_start: str | None
    quiet_hours_end: str | None
    default_thresholds: dict
    channels: dict


class UserSettingsUpdate(PatchModel):
    nullable_fields: ClassVar[frozenset[str]] = frozenset(
        {"quiet_hours_start", "quiet_hours_end"}
    )

    briefing_time: ClockTime | None = None
    quiet_hours_start: ClockTime | None = None
    quiet_hours_end: ClockTime | None = None
    default_thresholds: dict[str, FiniteFloat | None] | None = Field(
        default=None, max_length=20
    )
    channels: dict[ChannelName, bool] | None = None

    @model_validator(mode="after")
    def quiet_hours_are_a_pair(self) -> "UserSettingsUpdate":
        """Quiet hours are a window: set both ends or clear both, never one."""
        sent = {"quiet_hours_start", "quiet_hours_end"} & self.model_fields_set
        if not sent:
            return self
        if len(sent) == 1 or (self.quiet_hours_start is None) != (
            self.quiet_hours_end is None
        ):
            raise ValueError(
                "quiet_hours_start and quiet_hours_end must be set (or cleared) together"
            )
        return self


class PlanChangeRequest(BaseModel):
    plan: Literal["free", "pro", "brand"]


class OverLimitProduct(BaseModel):
    """A product that tracks more pincodes or competitors than the new plan allows."""

    product_id: str
    name: str
    pincodes: int
    pincode_limit: int | None
    competitors: int
    competitor_limit: int


class PlanChangeResponse(BaseModel):
    plan: str
    status: str
    test_mode: bool = True
    adjusted_products: int = 0
    paused_products: int = 0
    over_limit: list[OverLimitProduct] = Field(default_factory=list)
