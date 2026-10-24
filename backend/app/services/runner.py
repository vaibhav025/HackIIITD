"""Check pipeline: job creation, bounded execution, retries, credits, SSE.

Jobs are (seller product + each confirmed competitor) x selected platforms x
selected pincodes. Runs execute in the background; a process-wide semaphore
caps concurrent TinyFish sessions across every run. Each job streams its
agent session (``job_started`` → ``agent_step``… → ``result``/``job_failed``)
to the in-memory event bus for SSE subscribers. All database writes during a
run are serialised through a lock so SQLite and Postgres both stay happy.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import weakref
from dataclasses import dataclass
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import SessionLocal
from ..models.base import utcnow
from ..models.checks import CheckResult as CheckResultRow
from ..models.checks import CheckRun, CreditLedger
from ..models.product import Competitor, Pincode, Product, ProductListing
from .alerts import deliver_alerts, evaluate_alerts
from .events import run_events
from .insights import detect_changes
from .intelligence import refresh_intelligence
from .storage import save_screenshot, screenshot_url_for
from .tinyfish import TinyFishClient, TinyFishError, get_tinyfish_client
from .tinyfish.availability import credit_cost, is_fetch_platform, skipped_platforms
from .tinyfish.base import AgentStep, StepCallback
from .tinyfish.base import CheckResult as CheckResultPayload
from .tinyfish.goals import build_check_goal

logger = logging.getLogger("shelfsense.runner")

RETRY_BACKOFF_SECONDS = 0.25
MAX_ATTEMPTS = 2
ACTIVE_STATUSES = ("queued", "running")
# Terminal run statuses: "partial" = some jobs returned data, some failed.
FINISHED_STATUSES = ("done", "partial", "failed")


def run_outcome(total: int, failed: int) -> str:
    """Final status of a run from its job counts."""
    if failed <= 0:
        return "done"
    if failed >= total:
        return "failed"
    return "partial"


@dataclass(frozen=True)
class _RunHandle:
    task: asyncio.Task
    product_id: str
    user_id: str


_runs: dict[str, _RunHandle] = {}
# Run IDs committed as "queued" but not yet handed to schedule_run; orphan
# recovery must not fail them in that window.
_reserved_run_ids: set[str] = set()
_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def active_run_ids() -> set[str]:
    """Run IDs owned by this process (executing or about to be scheduled)."""
    return set(_runs) | _reserved_run_ids


def tinyfish_slots() -> asyncio.Semaphore:
    """Process-wide cap on concurrent TinyFish sessions across all runs."""
    loop = asyncio.get_running_loop()
    slots = _slots.get(loop)
    if slots is None:
        slots = asyncio.Semaphore(get_settings().tinyfish_max_concurrency)
        _slots[loop] = slots
    return slots


@dataclass(frozen=True)
class Job:
    competitor_id: str | None
    platform: str
    pincode: str
    query: str
    url: str | None
    competitor_name: str | None = None


def job_key(job: Job) -> str:
    return f"{job.platform}:{job.pincode}:{job.competitor_id or 'own'}"


def job_dict(job: Job) -> dict:
    return {
        "platform": job.platform,
        "pincode": job.pincode,
        "competitor_id": job.competitor_id,
        "competitor_name": job.competitor_name,
    }


def _publish(run_id: str, event_type: str, **data: object) -> None:
    run_events.publish(run_id, {"type": event_type, "run_id": run_id, **data})


async def build_jobs(
    session: AsyncSession, product: Product, platforms: list[str], pincodes: list[str]
) -> list[Job]:
    listings = {
        row.platform: row.url
        for row in (
            await session.scalars(
                select(ProductListing).where(ProductListing.product_id == product.id)
            )
        ).all()
    }
    competitors = list(
        (
            await session.scalars(
                select(Competitor).where(
                    Competitor.product_id == product.id,
                    Competitor.confirmed.is_(True),
                )
            )
        ).all()
    )
    # Without a real listing URL each entity gets a stable identity URL so the
    # simulated agent returns distinct, repeatable results for seller vs
    # rivals. Agents never see non-http(s) URLs and search by query instead.
    jobs = [
        Job(
            None,
            platform,
            pincode,
            product.search_query,
            listings.get(platform) or f"shelfsense://product/{product.name}",
        )
        for platform in platforms
        for pincode in pincodes
    ]
    for competitor in competitors:
        for platform in platforms:
            for pincode in pincodes:
                if competitor.platform == platform:
                    url = competitor.url or (
                        f"shelfsense://competitor/{competitor.name}"
                    )
                else:
                    url = f"shelfsense://competitor/{competitor.name}/{platform}"
                jobs.append(
                    Job(
                        competitor.id,
                        platform,
                        pincode,
                        competitor.search_query or product.search_query,
                        url,
                        competitor.name,
                    )
                )
    return jobs


@dataclass(frozen=True)
class JobPlan:
    """The jobs a run would execute, what they cost, and what it leaves out."""

    jobs: list[Job]
    skipped_platforms: list[str]

    @property
    def credits(self) -> int:
        # Agent sessions cost 1 credit; Fetch reads (Amazon, Flipkart) are free.
        # A retried agent check can cost one more credit than this estimate.
        return sum(credit_cost(job.platform) for job in self.jobs)

    @property
    def agent_jobs(self) -> int:
        return sum(1 for job in self.jobs if not is_fetch_platform(job.platform))


async def plan_jobs(
    session: AsyncSession, product: Product, platforms: list[str], pincodes: list[str]
) -> JobPlan:
    """Jobs exactly as ``create_run`` will run them (live mode drops apps that
    are not in TINYFISH_LIVE_PLATFORMS)."""
    settings = get_settings()
    jobs = await build_jobs(session, product, platforms, pincodes)
    skipped = skipped_platforms(settings, platforms)
    if skipped:
        jobs = [job for job in jobs if job.platform not in skipped]
    return JobPlan(jobs, skipped)


async def create_run(
    session: AsyncSession,
    product: Product,
    *,
    trigger: str,
    platforms: list[str],
    pincodes: list[str],
) -> tuple[CheckRun, list[Job]]:
    if product.paused:
        raise HTTPException(
            status_code=422, detail="Paused products cannot be checked"
        )
    settings = get_settings()
    plan = await plan_jobs(session, product, platforms, pincodes)
    jobs = plan.jobs
    if not jobs:
        if plan.skipped_platforms:
            # Apps that block automation are not checked live (TINYFISH_LIVE_PLATFORMS).
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "no_live_platforms",
                    "message": "None of the selected apps can be checked live. Live checks "
                    f"cover: {', '.join(sorted(settings.live_platforms))}.",
                },
            )
        raise HTTPException(status_code=422, detail="No check jobs to run")
    if plan.skipped_platforms:
        logger.info(
            "live mode skips %s for product=%s", plan.skipped_platforms, product.id
        )
    limit = settings.tinyfish_live_max_jobs_per_run
    # Only agent checks are slow and paid; Fetch checks (Amazon, Flipkart) read
    # one cached page per run and cost nothing extra.
    agent_jobs = plan.agent_jobs
    if settings.tinyfish_enabled and limit and agent_jobs > limit:
        # Live agent checks take minutes and cost real credits each.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "live_job_limit",
                "message": (
                    f"This check needs {agent_jobs} live TinyFish agent runs; the limit is "
                    f"{limit} per run (TINYFISH_LIVE_MAX_JOBS_PER_RUN). Pick fewer "
                    "pincodes or platforms."
                ),
            },
        )
    run = CheckRun(
        id=str(uuid4()),
        product_id=product.id,
        trigger=trigger,
        status="queued",
        total_jobs=len(jobs),
    )
    _reserved_run_ids.add(run.id)
    try:
        session.add(run)
        await session.commit()
        await session.refresh(run)
    except BaseException:
        _reserved_run_ids.discard(run.id)
        raise
    logger.info(
        "run created id=%s product=%s trigger=%s jobs=%s",
        run.id,
        product.id,
        trigger,
        len(jobs),
    )
    return run, jobs


def schedule_run(
    run_id: str, *, product_id: str, user_id: str, jobs: list[Job]
) -> asyncio.Task:
    task = asyncio.create_task(
        execute_run(run_id, product_id=product_id, user_id=user_id, jobs=jobs)
    )
    _runs[run_id] = _RunHandle(task, product_id, user_id)
    _reserved_run_ids.discard(run_id)

    def _cleanup(_done: asyncio.Task) -> None:
        _runs.pop(run_id, None)

    task.add_done_callback(_cleanup)
    return task


async def cancel_runs_for_product(product_id: str) -> int:
    """Cancel this product's runs and mark them failed; returns how many.

    Call before deleting the product, outside any open write transaction.
    """
    handles = {
        run_id: handle
        for run_id, handle in _runs.items()
        if handle.product_id == product_id
    }
    return await _cancel_runs(handles, CheckRun.product_id == product_id)


async def cancel_runs_for_user(user_id: str) -> int:
    """Cancel every run of the user's products and mark them failed."""
    handles = {
        run_id: handle for run_id, handle in _runs.items() if handle.user_id == user_id
    }
    owned = select(Product.id).where(Product.user_id == user_id)
    return await _cancel_runs(handles, CheckRun.product_id.in_(owned))


async def _cancel_runs(handles: dict[str, _RunHandle], condition) -> int:
    for handle in handles.values():
        handle.task.cancel()
    if handles:
        await asyncio.gather(
            *(handle.task for handle in handles.values()), return_exceptions=True
        )
    async with SessionLocal() as session:
        leftover = set(
            (
                await session.scalars(
                    select(CheckRun.id).where(
                        condition, CheckRun.status.in_(ACTIVE_STATUSES)
                    )
                )
            ).all()
        )
        if leftover:
            await session.execute(
                update(CheckRun)
                .where(CheckRun.id.in_(leftover))
                .values(status="failed", finished_at=utcnow())
            )
            await session.commit()
    _reserved_run_ids.difference_update(leftover)
    cancelled = set(handles) | leftover
    if cancelled:
        logger.info("cancelled %s run(s): %s", len(cancelled), sorted(cancelled))
    return len(cancelled)


async def check_with_retry(
    client: TinyFishClient, job: Job, on_step: StepCallback | None = None
) -> CheckResultPayload:
    """Run one check with at most ``MAX_ATTEMPTS`` sessions.

    Only retryable TinyFish errors are retried. Credits consumed by failed
    attempts are added to the returned payload, or to the raised error.
    """
    options = {"on_step": on_step} if on_step is not None else {}
    spent = 0
    attempt = 0
    while True:
        attempt += 1
        try:
            result = await client.check(
                platform=job.platform,
                pincode=job.pincode,
                query=job.query,
                url=job.url,
                **options,
            )
            payload = CheckResultPayload.model_validate(result.model_dump())
        except ValidationError as exc:
            raise TinyFishError(
                f"TinyFish returned an invalid result ({exc.error_count()} field errors)",
                retryable=False,
                credits_used=spent + 1,
            ) from exc
        except TimeoutError as exc:
            raise TinyFishError(
                "TinyFish check timed out", retryable=False, credits_used=spent
            ) from exc
        except TinyFishError as exc:
            spent += exc.credits_used
            logger.warning(
                "check attempt %s failed platform=%s pincode=%s retryable=%s error=%s",
                attempt,
                job.platform,
                job.pincode,
                exc.retryable,
                exc,
            )
            if not exc.retryable or attempt >= MAX_ATTEMPTS:
                exc.credits_used = spent
                raise
            await asyncio.sleep(RETRY_BACKOFF_SECONDS)
            continue
        payload.credits_used += spent
        return payload


class _JobTrace:
    """Re-publishes one job's agent steps (across retries) to the run stream.

    Steps are renumbered per job, timed from when the job got a TinyFish slot,
    and the location step is enriched with the area name ShelfSense knows.
    """

    def __init__(self, run_id: str, job: Job, *, mode: str, area: str | None) -> None:
        self.run_id = run_id
        self.mode = mode
        self.job = job
        self.key = job_key(job)
        self.area = area
        self.goal = build_check_goal(job.platform, job.pincode, job.query, job.url)
        self.session_id: str | None = None
        self.steps: list[AgentStep] = []
        self._sessions = 0
        self._announced = False
        self._started = time.perf_counter()

    @property
    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self._started) * 1000)

    def announce(self) -> None:
        if self._announced:
            return
        self._announced = True
        _publish(
            self.run_id,
            "job_started",
            job_key=self.key,
            job=job_dict(self.job),
            session_id=self.session_id,
            goal=self.goal,
        )

    async def on_step(self, step: AgentStep) -> None:
        step = {**step, "index": len(self.steps) + 1, "ms": self.elapsed_ms}
        if step["kind"] == "session":
            self._sessions += 1
            self.session_id = step["detail"]
            if self._sessions > 1:
                step["label"] = "Retrying in a new browser session"
        elif step["kind"] == "location" and step["detail"] is None and self.area:
            step["detail"] = self.area
        self.announce()
        self.steps.append(step)
        _publish(self.run_id, "agent_step", job_key=self.key, step=step)

    def agent_raw(self, reported: dict | None) -> dict:
        return {
            "goal": self.goal,
            "mode": self.mode,
            "true_price": None,
            **(reported or {}),
            "session_id": self.session_id,
            "steps": list(self.steps),
        }


async def _area_names(session: AsyncSession, pincodes: set[str]) -> dict[str, str]:
    rows = await session.execute(
        select(Pincode.code, Pincode.area_name).where(Pincode.code.in_(pincodes))
    )
    return {code: area for code, area in rows.all()}


async def execute_run(
    run_id: str, *, product_id: str, user_id: str, jobs: list[Job]
) -> None:
    settings = get_settings()
    total = len(jobs)
    write_lock = asyncio.Lock()
    counters = {"done": 0, "failed": 0, "credits": 0}
    final_status = "failed"
    client: TinyFishClient | None = None

    try:
        client = get_tinyfish_client()
        async with SessionLocal() as session:
            claimed = await session.execute(
                update(CheckRun)
                .where(CheckRun.id == run_id, CheckRun.status == "queued")
                .values(status="running", started_at=utcnow())
            )
            await session.commit()
            if not claimed.rowcount:
                final_status = (
                    await session.scalar(
                        select(CheckRun.status).where(CheckRun.id == run_id)
                    )
                ) or "failed"
                logger.warning(
                    "run %s is no longer queued (%s); not executing", run_id, final_status
                )
                return
            areas = await _area_names(session, {job.pincode for job in jobs})
            _publish(
                run_id,
                "run_started",
                total_jobs=total,
                mode=client.mode,
                concurrency=settings.tinyfish_max_concurrency,
            )

            async def record(
                job: Job,
                payload: CheckResultPayload | None,
                *,
                error: str | None,
                screenshot_url: str | None,
                raw: dict,
                credits: int,
            ) -> CheckResultRow:
                async with write_lock:
                    try:
                        row = CheckResultRow(
                            run_id=run_id,
                            product_id=product_id,
                            competitor_id=job.competitor_id,
                            platform=job.platform,
                            pincode=job.pincode,
                            in_stock=payload.in_stock if payload else None,
                            price=payload.price if payload else None,
                            mrp=payload.mrp if payload else None,
                            eta_minutes=payload.eta_minutes if payload else None,
                            rating=payload.rating if payload else None,
                            screenshot_url=screenshot_url,
                            status="ok" if payload else "failed",
                            error=error,
                            raw=raw,
                            checked_at=utcnow(),
                        )
                        session.add(row)
                        progress = {"done_jobs": CheckRun.done_jobs + 1}
                        if payload is None:
                            progress["failed_jobs"] = CheckRun.failed_jobs + 1
                        if credits:
                            progress["credits_used"] = CheckRun.credits_used + credits
                            reason = "check" if payload else "check_failed"
                            session.add(
                                CreditLedger(
                                    user_id=user_id,
                                    run_id=run_id,
                                    credits=credits,
                                    reason=f"{reason}:{job.platform}:{job.pincode}",
                                )
                            )
                        await session.execute(
                            update(CheckRun)
                            .where(CheckRun.id == run_id)
                            .values(**progress)
                        )
                        await session.commit()
                    except Exception:
                        await session.rollback()
                        raise
                    counters["done"] += 1
                    counters["credits"] += credits
                    if payload is None:
                        counters["failed"] += 1
                    return row

            async def execute_job(job: Job) -> None:
                async with tinyfish_slots():
                    trace = _JobTrace(
                        run_id, job, mode=client.mode, area=areas.get(job.pincode)
                    )
                    payload: CheckResultPayload | None = None
                    error: str | None = None
                    reported_agent: dict | None = None
                    credits = 0
                    try:
                        payload = await check_with_retry(
                            client, job, on_step=trace.on_step
                        )
                    except TinyFishError as exc:
                        error = (str(exc) or exc.__class__.__name__)[:1000]
                        credits = exc.credits_used
                        reported_agent = exc.agent
                    else:
                        credits = payload.credits_used
                        reported_agent = payload.raw.get("agent")
                trace.announce()
                screenshot_url: str | None = None
                if payload is not None:
                    if payload.screenshot_bytes:
                        try:
                            screenshot_url = await save_screenshot(
                                payload.screenshot_bytes,
                                product_id=product_id,
                                platform=job.platform,
                                pincode=job.pincode,
                                content_type=payload.screenshot_content_type,
                            )
                        except Exception:
                            logger.warning(
                                "screenshot save failed run=%s job=%s",
                                run_id,
                                trace.key,
                                exc_info=True,
                            )
                    screenshot_url = screenshot_url or payload.screenshot_url
                agent = trace.agent_raw(reported_agent)
                raw = {**(payload.raw if payload else {}), "agent": agent}
                try:
                    row = await record(
                        job,
                        payload,
                        error=error,
                        screenshot_url=screenshot_url,
                        raw=raw,
                        credits=credits,
                    )
                except Exception:
                    logger.exception("could not record job %s run=%s", trace.key, run_id)
                    counters["done"] += 1
                    counters["failed"] += 1
                    _publish(
                        run_id,
                        "job_failed",
                        job_key=trace.key,
                        job=job_dict(job),
                        error="The result could not be saved",
                        ms=trace.elapsed_ms,
                    )
                    return
                logger.info(
                    "job %s status=%s ms=%s credits=%s",
                    trace.key,
                    row.status,
                    trace.elapsed_ms,
                    credits,
                )
                if payload is None:
                    _publish(
                        run_id,
                        "job_failed",
                        job_key=trace.key,
                        job=job_dict(job),
                        error=error,
                        ms=trace.elapsed_ms,
                    )
                    return
                _publish(
                    run_id,
                    "result",
                    job_key=trace.key,
                    result={
                        "id": row.id,
                        "job_key": trace.key,
                        **job_dict(job),
                        "in_stock": row.in_stock,
                        "price": row.price,
                        "mrp": row.mrp,
                        "eta_minutes": row.eta_minutes,
                        "rating": row.rating,
                        "status": row.status,
                        "screenshot_url": screenshot_url_for(
                            row.id, row.screenshot_url, settings
                        ),
                        "checked_at": row.checked_at.isoformat(),
                        "ms": trace.elapsed_ms,
                        "credits": credits,
                        "session_id": agent["session_id"],
                        "true_price": agent["true_price"],
                    },
                )

            outcomes = await asyncio.gather(
                *(execute_job(job) for job in jobs), return_exceptions=True
            )
            for outcome in outcomes:
                if isinstance(outcome, BaseException):
                    logger.error("job crashed run=%s error=%r", run_id, outcome)
                    counters["failed"] += 1
                    counters["done"] += 1

            final_status = run_outcome(total, counters["failed"])
            closed = await session.execute(
                update(CheckRun)
                .where(CheckRun.id == run_id, CheckRun.status == "running")
                .values(
                    status=final_status,
                    done_jobs=counters["done"],
                    failed_jobs=counters["failed"],
                    credits_used=counters["credits"],
                    finished_at=utcnow(),
                )
            )
            await session.commit()
            if not closed.rowcount:
                # Orphan recovery or a cancellation already closed this run;
                # its verdict stands.
                final_status = "failed"
                logger.warning("run %s was closed elsewhere; keeping its status", run_id)
            await _post_run_hooks(session, run_id, product_id)
    except asyncio.CancelledError:
        final_status = "failed"
        logger.warning("run %s cancelled", run_id)
        with contextlib.suppress(Exception):
            await _mark_run_failed(run_id, counters)
        raise
    except Exception:
        logger.exception("run %s crashed", run_id)
        final_status = "failed"
        with contextlib.suppress(Exception):
            await _mark_run_failed(run_id, counters)
    finally:
        close = getattr(client, "close", None)
        if close is not None:
            with contextlib.suppress(Exception):
                await close()
        _publish(
            run_id,
            "run_done",
            status=final_status,
            total_jobs=total,
            done_jobs=counters["done"],
            failed_jobs=counters["failed"],
            credits_used=counters["credits"],
        )
        run_events.finish(run_id)
        logger.info(
            "run finished id=%s status=%s done=%s failed=%s credits=%s",
            run_id,
            final_status,
            counters["done"],
            counters["failed"],
            counters["credits"],
        )


async def _post_run_hooks(session: AsyncSession, run_id: str, product_id: str) -> None:
    try:
        await detect_changes(session, run_id=run_id, product_id=product_id)
    except Exception:
        logger.exception("change detection failed for run %s", run_id)
        await session.rollback()
    try:
        await refresh_intelligence(session, product_id, run_id=run_id)
    except Exception:
        logger.exception("intelligence refresh failed for run %s", run_id)
        await session.rollback()
    try:
        product = await session.get(Product, product_id)
        if product is not None:
            alerts = await evaluate_alerts(session, product, run_id=run_id)
            if alerts:
                await deliver_alerts(session, alerts)
    except Exception:
        logger.exception("alert evaluation failed for run %s", run_id)
        await session.rollback()


async def _mark_run_failed(run_id: str, counters: dict[str, int]) -> None:
    async with SessionLocal() as session:
        await session.execute(
            update(CheckRun)
            .where(CheckRun.id == run_id, CheckRun.status.in_(ACTIVE_STATUSES))
            .values(
                status="failed",
                done_jobs=counters["done"],
                failed_jobs=counters["failed"],
                credits_used=counters["credits"],
                finished_at=utcnow(),
            )
        )
        await session.commit()
