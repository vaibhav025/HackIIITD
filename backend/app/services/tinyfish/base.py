"""TinyFish client interface.

The runner and every other service depend only on this module. All
TinyFish SDK calls live in ``tinyfish_client.py``; the simulated agent lives
in ``mock_client.py``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal, Protocol, TypedDict, runtime_checkable

from pydantic import BaseModel, Field

AgentStepKind = Literal[
    "session",
    "navigate",
    "location",
    "search",
    "open",
    "extract",
    "checkout",
    "screenshot",
    "done",
    "error",
]


class AgentStep(TypedDict):
    """One step of a web-agent session.

    ``ms`` is the elapsed time since the session started at the moment the
    step began, so a step's duration is the next step's ``ms`` minus its own.
    """

    index: int
    kind: AgentStepKind
    label: str
    detail: str | None
    at: str
    ms: int


StepCallback = Callable[[AgentStep], Awaitable[None]]


class TruePrice(TypedDict):
    item: float
    handling_fee: float
    delivery_fee: float
    offer: float
    final: float


class CheckResult(BaseModel):
    """Validated outcome of a single price/stock check for one pincode."""

    product: str | None = None
    in_stock: bool | None = None
    price: float | None = Field(default=None, ge=0)
    mrp: float | None = Field(default=None, ge=0)
    eta_minutes: int | None = Field(default=None, ge=0)
    rating: float | None = Field(default=None, ge=0, le=5)
    screenshot_bytes: bytes | None = None
    screenshot_content_type: str = "image/png"
    screenshot_url: str | None = None
    credits_used: int = Field(default=1, ge=0)
    raw: dict = Field(default_factory=dict)


class SearchHit(BaseModel):
    name: str
    url: str | None = None
    platform: str | None = None
    price: float | None = Field(default=None, ge=0)
    snippet: str | None = None
    raw: dict = Field(default_factory=dict)


class FetchResult(BaseModel):
    url: str
    status: str = "ok"
    text: str | None = None
    credits_used: int = Field(default=1, ge=0)
    raw: dict = Field(default_factory=dict)


class TinyFishError(Exception):
    """A TinyFish check, search, or fetch failed.

    ``retryable`` is False when another attempt cannot help (deterministic
    outcomes, client errors, timeouts that already consumed the budget).
    ``credits_used`` is what the failed attempt still cost, and ``agent``
    carries the session trace so failed jobs can be replayed.
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = True,
        credits_used: int = 0,
        agent: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.credits_used = credits_used
        self.agent = agent


@runtime_checkable
class TinyFishClient(Protocol):
    mode: Literal["simulated", "live"]

    async def check(
        self,
        platform: str,
        pincode: str,
        query: str,
        url: str | None = None,
        on_step: StepCallback | None = None,
    ) -> CheckResult: ...

    async def search(self, query: str) -> list[SearchHit]: ...

    async def fetch(self, url: str) -> FetchResult: ...


def tinyfish_mode() -> Literal["simulated", "live"]:
    """Which client ``get_tinyfish_client`` returns under the current settings."""
    from ...config import get_settings

    return "live" if get_settings().tinyfish_enabled else "simulated"


def get_tinyfish_client() -> TinyFishClient:
    """Return the real SDK client when a key is set, otherwise the simulator."""
    from ...config import get_settings
    from .demo_cache import CachedFallbackClient
    from .mock_client import MockTinyFishClient

    settings = get_settings()
    if settings.tinyfish_enabled:
        from .tinyfish_client import TinyFishLiveClient

        return CachedFallbackClient(TinyFishLiveClient(settings), demo=settings.tinyfish_demo)
    if settings.tinyfish_demo:
        return CachedFallbackClient(MockTinyFishClient(), demo=True)
    return MockTinyFishClient()
