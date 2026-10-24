"""TinyFish integration: client interface, simulated agent, live SDK client."""

from .base import (
    CheckResult,
    FetchResult,
    SearchHit,
    TinyFishClient,
    TinyFishError,
    get_tinyfish_client,
)
from .mock_client import MockTinyFishClient

__all__ = [
    "CheckResult",
    "FetchResult",
    "MockTinyFishClient",
    "SearchHit",
    "TinyFishClient",
    "TinyFishError",
    "get_tinyfish_client",
]
