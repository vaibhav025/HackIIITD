"""In-memory pub/sub of per-run events for SSE streams.

Single-process only: one FastAPI process runs the API, runner, scheduler, and
Telegram bot, so a module-level bus is sufficient. Every published event gets
a ``seq`` that increases monotonically per run (use it as the SSE ``id``).
Each run keeps a bounded history so clients that subscribe late, or reconnect
with ``Last-Event-ID``, receive exactly the events they have not seen.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

HISTORY_LIMIT = 20000
FINISHED_RETENTION_SECONDS = 600


class RunEventBus:
    def __init__(self) -> None:
        self._queues: dict[str, set[asyncio.Queue[dict | None]]] = {}
        self._history: dict[str, list[dict]] = {}
        self._seq: dict[str, int] = {}
        self._finished_at: dict[str, float] = {}

    def subscribe(
        self, run_id: str, after_seq: int = 0
    ) -> tuple[list[dict], asyncio.Queue[dict | None]]:
        """Return history newer than ``after_seq`` plus a queue of live events."""
        self._prune()
        past = [
            event for event in self._history.get(run_id, ()) if event["seq"] > after_seq
        ]
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=HISTORY_LIMIT)
        self._queues.setdefault(run_id, set()).add(queue)
        return past, queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict | None]) -> None:
        subscribers = self._queues.get(run_id)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._queues.pop(run_id, None)

    def publish(self, run_id: str, event: dict) -> dict:
        """Stamp ``event`` with the run's next ``seq``, store and fan it out."""
        seq = self._seq.get(run_id, 0) + 1
        self._seq[run_id] = seq
        stamped = {**event, "seq": seq}
        history = self._history.setdefault(run_id, [])
        history.append(stamped)
        if len(history) > HISTORY_LIMIT:
            del history[: len(history) - HISTORY_LIMIT]
        for queue in list(self._queues.get(run_id, ())):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(stamped)
        return stamped

    def last_seq(self, run_id: str) -> int:
        return self._seq.get(run_id, 0)

    def finish(self, run_id: str) -> None:
        """Wake subscribers so they can stop waiting after the final event."""
        self._finished_at[run_id] = time.monotonic()
        for queue in list(self._queues.get(run_id, ())):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(None)

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [
            run_id
            for run_id, stamp in self._finished_at.items()
            if now - stamp > FINISHED_RETENTION_SECONDS
        ]
        for run_id in expired:
            self._finished_at.pop(run_id, None)
            self._history.pop(run_id, None)
            self._seq.pop(run_id, None)
            self._queues.pop(run_id, None)


run_events = RunEventBus()
