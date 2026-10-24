"""Agent session tracing shared by the simulated and live TinyFish clients.

A trace records every step of one web-agent session, forwards each step to
the caller's ``on_step`` callback as it begins, and serialises into the
``raw["agent"]`` block stored with every check result.
"""

from __future__ import annotations

import secrets
import time
from typing import Literal

from ...models.base import utcnow
from .base import AgentStep, AgentStepKind, StepCallback, TruePrice


def new_session_id() -> str:
    return f"tf_sess_{secrets.token_hex(4)}"


def format_rupees(value: float) -> str:
    """₹42 for whole rupees, ₹42.50 otherwise."""
    rounded = round(value, 2)
    if rounded == int(rounded):
        return f"₹{int(rounded):,}"
    return f"₹{rounded:,.2f}"


class AgentTrace:
    def __init__(
        self,
        *,
        goal: str,
        mode: Literal["simulated", "live"],
        on_step: StepCallback | None = None,
        session_id: str | None = None,
    ) -> None:
        self.session_id = session_id or new_session_id()
        self.goal = goal
        self.mode = mode
        self.steps: list[AgentStep] = []
        self.true_price: TruePrice | None = None
        self._on_step = on_step
        self._started = time.perf_counter()

    @property
    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self._started) * 1000)

    async def step(
        self, kind: AgentStepKind, label: str, detail: str | None = None
    ) -> AgentStep:
        step: AgentStep = {
            "index": len(self.steps) + 1,
            "kind": kind,
            "label": label,
            "detail": detail,
            "at": utcnow().isoformat(),
            "ms": self.elapsed_ms,
        }
        self.steps.append(step)
        if self._on_step is not None:
            await self._on_step(step)
        return step

    def as_raw(self) -> dict:
        return {
            "session_id": self.session_id,
            "goal": self.goal,
            "mode": self.mode,
            "steps": list(self.steps),
            "true_price": self.true_price,
        }
