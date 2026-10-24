"""Reusable constrained types and the PATCH base model shared by request schemas."""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AfterValidator,
    BaseModel,
    Field,
    StringConstraints,
    model_validator,
)

Platform = Literal["blinkit", "zepto", "instamart", "amazon", "flipkart"]
PLATFORMS: tuple[str, ...] = get_args(Platform)

CheckFrequency = Literal["3h", "6h", "12h", "daily", "weekly"]

# Contract kinds, plus `rating_below` / `rival_oos`, which the alert engine and
# rule parser already emit and evaluate.
AlertKind = Literal[
    "oos_any",
    "oos_area",
    "price_change_pct",
    "price_gap_pct",
    "rating_drop",
    "rating_below",
    "rival_oos",
    "custom",
]

Language = Literal["en", "hi"]

PincodeCode = Annotated[str, StringConstraints(pattern=r"^\d{6}$")]
ClockTime = Annotated[
    str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
]
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
NonNegativeFloat = Annotated[float, Field(ge=0, allow_inf_nan=False)]


def required_text(max_length: int) -> Any:
    """Stripped text that must still be non-empty."""
    return Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length),
    ]


def _blank_to_none(value: str | None) -> str | None:
    return value or None


def optional_text(max_length: int) -> Any:
    """Stripped text where an empty string means "not set"."""
    return Annotated[
        str | None,
        StringConstraints(strip_whitespace=True, max_length=max_length),
        AfterValidator(_blank_to_none),
    ]


def _check_web_url(value: str | None) -> str | None:
    if not value:
        return None
    parts = urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        raise ValueError("URL must start with http:// or https://")
    return value


WebUrl = Annotated[
    str | None,
    StringConstraints(strip_whitespace=True, max_length=1000),
    AfterValidator(_check_web_url),
]


def _check_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Unknown timezone; use an IANA name like Asia/Kolkata") from exc
    return value


TimezoneName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64),
    AfterValidator(_check_timezone),
]


class PatchModel(BaseModel):
    """Partial-update body: omitted fields stay unchanged, explicit `null` is
    only accepted for the columns listed in `nullable_fields`."""

    nullable_fields: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def reject_null_for_required_columns(cls, data: Any) -> Any:
        if isinstance(data, dict):
            rejected = sorted(
                key
                for key, value in data.items()
                if value is None
                and key in cls.model_fields
                and key not in cls.nullable_fields
            )
            if rejected:
                raise ValueError(f"{', '.join(rejected)} cannot be null")
        return data
