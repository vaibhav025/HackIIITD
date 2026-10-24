"""Run creation, status, history, agent traces, usage, and SSE progress streaming."""

from __future__ import annotations

import asyncio
import json
import mimetypes
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from ..config import Settings, get_settings
from ..db import SessionLocal, get_session
from ..deps import get_current_user, get_stream_user
from ..models.checks import CheckResult, CheckRun
from ..models.product import Pincode, Product, ProductPincode
from ..models.user import User
from ..schemas.runs import (
    AppStatus,
    CheckResultDetail,
    RunCreate,
    RunCreated,
    RunDetail,
    RunEstimate,
    RunResponse,
    RunResultItem,
    RunSummary,
    SkippedPlatform,
    TinyFishUsage,
)
from ..services.events import run_events
from ..services.plans import (
    credit_day_start,
    daily_credits_used,
    enforce_pincode_limit,
    limits_for,
    remaining_credits_today,
)
from ..services.runner import FINISHED_STATUSES, create_run, plan_jobs, schedule_run
from ..services.tinyfish.availability import (
    APP_LABELS,
    CHECK_STRATEGY,
    credit_cost,
    unavailable_reason,
)
from .media import local_media_path, screenshot_url_for
from .products import get_owned_product, get_user_plan, has_active_run

router = APIRouter(tags=["runs"])

QUEUE_POLL_SECONDS = 15.0
ACTIVE_RUN_CONFLICT = "A check run is already queued or running for this product"
# Serialises check-then-create per product inside this process; the partial
# unique index on check_runs is the cross-process backstop.
_start_locks: dict[str, asyncio.Lock] = {}


def job_key(platform: str, pincode: str, competitor_id: str | None) -> str:
    return f"{platform}:{pincode}:{competitor_id or 'own'}"


async def get_owned_run(
    session: AsyncSession, user_id: str, run_id: str
) -> CheckRun:
    run = await session.scalar(
        select(CheckRun)
        .join(Product, Product.id == CheckRun.product_id)
        .where(CheckRun.id == run_id, Product.user_id == user_id)
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


async def get_owned_result(
    session: AsyncSession, user_id: str, result_id: str
) -> CheckResult:
    result = await session.scalar(
        select(CheckResult)
        .join(Product, Product.id == CheckResult.product_id)
        .where(CheckResult.id == result_id, Product.user_id == user_id)
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Check result not found")
    return result


async def run_modes(
    session: AsyncSession, run_ids: list[str], settings: Settings
) -> dict[str, str]:
    """Agent mode per run as recorded on its results (`raw.agent.mode`).

    Runs whose results carry no agent trace (seeded history) are
    "simulated"; runs with no results yet report the mode the process is in now.
    """
    recorded: dict[str, str] = {}
    if run_ids:
        with_results = await session.scalars(
            select(CheckResult.run_id).where(CheckResult.run_id.in_(run_ids)).distinct()
        )
        for run_id in with_results.all():
            recorded[run_id] = "simulated"
        mode_expr = CheckResult.raw["agent"]["mode"].as_string()
        rows = await session.execute(
            select(CheckResult.run_id, mode_expr)
            .where(CheckResult.run_id.in_(run_ids), mode_expr.is_not(None))
            .distinct()
        )
        for run_id, mode in rows.all():
            recorded[run_id] = mode
    return {run_id: recorded.get(run_id, settings.tinyfish_mode) for run_id in run_ids}


def sse_message(event: dict) -> dict:
    message = {"event": str(event.get("type", "message")), "data": json.dumps(event)}
    if isinstance(event.get("seq"), int):
        message["id"] = str(event["seq"])
    return message


def run_done_event(run_id: str, run: CheckRun | RunResponse) -> dict:
    return {
        "type": "run_done",
        "run_id": run_id,
        "status": run.status,
        "total_jobs": run.total_jobs,
        "done_jobs": run.done_jobs,
        "failed_jobs": run.failed_jobs,
        "credits_used": run.credits_used,
    }


async def finished_run_event(run_id: str) -> dict | None:
    async with SessionLocal() as session:
        run = await session.get(CheckRun, run_id)
        if run is None or run.status not in FINISHED_STATUSES:
            return None
        return run_done_event(run_id, run)


async def resolve_selection(
    session: AsyncSession,
    product_id: str,
    platforms_in: list[str] | None,
    pincodes_in: list[str] | None,
) -> tuple[list[str], list[str]]:
    """Requested platforms/pincodes (default: the product's whole selection),
    validated against what the product tracks."""
    selection = list(
        (
            await session.scalars(
                select(ProductPincode).where(ProductPincode.product_id == product_id)
            )
        ).all()
    )
    if not selection:
        raise HTTPException(
            status_code=422,
            detail="Select pincodes and platforms for this product first",
        )
    available_platforms = {row.platform for row in selection}
    available_pincodes = {row.pincode for row in selection}
    platforms = sorted(set(platforms_in) if platforms_in else available_platforms)
    pincodes = sorted(set(pincodes_in) if pincodes_in else available_pincodes)
    unknown_platforms = sorted(set(platforms) - available_platforms)
    if unknown_platforms:
        raise HTTPException(
            status_code=422,
            detail="Platforms not selected for this product: "
            + ", ".join(unknown_platforms),
        )
    unknown_pincodes = sorted(set(pincodes) - available_pincodes)
    if unknown_pincodes:
        raise HTTPException(
            status_code=422,
            detail="Pincodes not selected for this product: "
            + ", ".join(unknown_pincodes),
        )
    return platforms, pincodes


@router.get("/products/{product_id}/runs/estimate", response_model=RunEstimate)
async def estimate_run(
    product_id: str,
    platforms: list[str] | None = Query(default=None),
    pincodes: list[str] | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> RunEstimate:
    """What `POST /products/{id}/runs` with the same selection would run and cost."""
    product = await get_owned_product(session, user.id, product_id)
    platforms, pincodes = await resolve_selection(session, product.id, platforms, pincodes)
    plan = await plan_jobs(session, product, platforms, pincodes)
    return RunEstimate(
        jobs=len(plan.jobs),
        credits=plan.credits,
        agent_jobs=plan.agent_jobs,
        platforms=sorted({job.platform for job in plan.jobs}),
        pincodes=pincodes,
        skipped_platforms=[
            SkippedPlatform(platform=platform, reason=unavailable_reason(platform))
            for platform in plan.skipped_platforms
        ],
        remaining_credits=await remaining_credits_today(
            session, user.id, await get_user_plan(session, user.id)
        ),
    )


@router.post(
    "/products/{product_id}/runs",
    response_model=RunCreated,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_run(
    product_id: str,
    payload: RunCreate | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RunCreated:
    product = await get_owned_product(session, user.id, product_id)
    if product.paused:
        raise HTTPException(
            status_code=422, detail="Paused products cannot be checked"
        )
    platforms, pincodes = await resolve_selection(
        session,
        product_id,
        payload.platforms if payload else None,
        payload.pincodes if payload else None,
    )
    plan = await get_user_plan(session, user.id)
    enforce_pincode_limit(plan, len(pincodes))

    lock = _start_locks.setdefault(product_id, asyncio.Lock())
    async with lock:
        if await has_active_run(session, product_id):
            raise HTTPException(status_code=409, detail=ACTIVE_RUN_CONFLICT)
        estimated = (await plan_jobs(session, product, platforms, pincodes)).credits
        remaining = await remaining_credits_today(session, user.id, plan)
        if remaining is not None and estimated > remaining:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "credit_budget_exceeded",
                    "message": (
                        f"This check needs {estimated} credits but only {remaining} "
                        f"of today's {plan} plan budget remain"
                    ),
                },
            )
        try:
            run, jobs = await create_run(
                session, product, trigger="manual", platforms=platforms, pincodes=pincodes
            )
        except IntegrityError:
            # A scheduled run for this product was created in the same instant.
            await session.rollback()
            raise HTTPException(status_code=409, detail=ACTIVE_RUN_CONFLICT) from None
    schedule_run(run.id, product_id=product.id, user_id=user.id, jobs=jobs)
    return RunCreated(
        run_id=run.id,
        estimated_credits=sum(credit_cost(job.platform) for job in jobs),
        total_jobs=len(jobs),
    )


@router.get("/runs", response_model=list[RunSummary])
async def list_runs(
    product_id: str | None = Query(default=None, max_length=36),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> list[RunSummary]:
    statement = (
        select(CheckRun, Product.name)
        .join(Product, Product.id == CheckRun.product_id)
        .where(Product.user_id == user.id)
    )
    if product_id is not None:
        statement = statement.where(CheckRun.product_id == product_id)
    rows = (
        await session.execute(
            statement.order_by(
                func.coalesce(CheckRun.started_at, CheckRun.finished_at).desc(),
                CheckRun.id.desc(),
            ).limit(limit)
        )
    ).all()
    modes = await run_modes(session, [run.id for run, _name in rows], settings)
    return [
        RunSummary(
            **RunResponse.model_validate(run).model_dump(),
            product_name=name,
            mode=modes[run.id],
        )
        for run, name in rows
    ]


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(
    run_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RunDetail:
    run = await get_owned_run(session, user.id, run_id)
    results = (
        await session.scalars(
            select(CheckResult)
            .where(CheckResult.run_id == run_id)
            .order_by(CheckResult.checked_at)
        )
    ).all()
    modes = await run_modes(session, [run_id], settings)
    areas = {
        row.code: row.area_name
        for row in (
            await session.scalars(
                select(Pincode).where(Pincode.code.in_({row.pincode for row in results}))
            )
        ).all()
    }
    return RunDetail(
        **RunResponse.model_validate(run).model_dump(),
        mode=modes[run_id],
        results=[
            RunResultItem(
                id=row.id,
                job_key=job_key(row.platform, row.pincode, row.competitor_id),
                platform=row.platform,
                pincode=row.pincode,
                competitor_id=row.competitor_id,
                status=row.status,
                price=row.price,
                in_stock=row.in_stock,
                screenshot_url=screenshot_url_for(row.id, row.screenshot_url, settings),
                mrp=row.mrp,
                eta_minutes=row.eta_minutes,
                area=areas.get(row.pincode),
                error=row.error,
                checked_at=row.checked_at,
                **result_provenance(row.raw or {}),
            )
            for row in results
        ],
    )


SOURCE_METHODS = {
    "tinyfish_agent_api": "agent",
    "tinyfish_fetch_api": "fetch",
    "tinyfish_browser_api": "browser",
    "demo_cache": "cached",
}


def result_provenance(raw: dict) -> dict:
    """How a stored result was obtained, for the Agents page."""
    agent = raw.get("agent") if isinstance(raw.get("agent"), dict) else {}
    method = SOURCE_METHODS.get(str(raw.get("source")), "simulated")
    url = raw.get("url")
    notes = raw.get("notes")
    if isinstance(notes, str):
        notes = [notes]
    return {
        "method": method,
        "pincode_specific": raw.get("pincode_specific", True) is not False,
        "source_url": url if isinstance(url, str) and url.startswith("http") else None,
        "delivery_text": raw.get("delivery_text"),
        "notes": [str(note) for note in notes or [] if note],
        "step_count": len(agent.get("steps") or []),
        "exact_match": raw.get("exact_match") is not False,
    }


@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: str,
    ping: int = Query(default=15, ge=1, le=60),
    last_event_id: int | None = Query(default=None, ge=0),
    last_event_header: str | None = Header(default=None, alias="Last-Event-ID"),
    user: User = Depends(get_stream_user),
) -> EventSourceResponse:
    # Load the run in a short session: an SSE response can stay open for minutes.
    async with SessionLocal() as session:
        run = await get_owned_run(session, user.id, run_id)
        snapshot = RunResponse.model_validate(run)
    after_seq = last_event_id
    if after_seq is None and last_event_header and last_event_header.isdigit():
        after_seq = int(last_event_header)
    already_finished = snapshot.status in FINISHED_STATUSES
    past, queue = run_events.subscribe(run_id, after_seq=after_seq or 0)

    async def generator():
        try:
            for event in past:
                yield sse_message(event)
                if event["type"] == "run_done":
                    return
            if already_finished:
                yield sse_message(run_done_event(run_id, snapshot))
                return
            while True:
                try:
                    event = await asyncio.wait_for(
                        queue.get(), timeout=min(float(ping), QUEUE_POLL_SECONDS)
                    )
                except TimeoutError:
                    final = await finished_run_event(run_id)
                    if final is not None:
                        yield sse_message(final)
                        return
                    # A named heartbeat (not an SSE comment) so EventSource
                    # clients can see the stream is alive while agents work.
                    yield {"event": "ping", "data": json.dumps({"type": "ping"})}
                    continue
                if event is None:
                    final = await finished_run_event(run_id)
                    if final is not None:
                        yield sse_message(final)
                    return
                yield sse_message(event)
                if event["type"] == "run_done":
                    return
        finally:
            run_events.unsubscribe(run_id, queue)

    return EventSourceResponse(generator(), ping=ping)


@router.get("/check-results/{result_id}", response_model=CheckResultDetail)
async def get_check_result(
    result_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> CheckResultDetail:
    row = await get_owned_result(session, user.id, result_id)
    agent = (row.raw or {}).get("agent")
    return CheckResultDetail(
        id=row.id,
        run_id=row.run_id,
        product_id=row.product_id,
        competitor_id=row.competitor_id,
        platform=row.platform,
        pincode=row.pincode,
        in_stock=row.in_stock,
        price=row.price,
        mrp=row.mrp,
        eta_minutes=row.eta_minutes,
        rating=row.rating,
        status=row.status,
        error=row.error,
        screenshot_url=screenshot_url_for(row.id, row.screenshot_url, settings),
        checked_at=row.checked_at,
        agent=agent if isinstance(agent, dict) else None,
    )


@router.get("/check-results/{result_id}/screenshot", response_model=None)
async def get_check_result_screenshot(
    result_id: str,
    user: User = Depends(get_stream_user),
) -> FileResponse | RedirectResponse:
    """Owner-checked evidence image. Accepts `?access_token=` like the stream
    endpoint, because `<img>` tags cannot send an Authorization header."""
    async with SessionLocal() as session:
        row = await get_owned_result(session, user.id, result_id)
        url = row.screenshot_url
    if url and url.startswith(("https://", "http://")):
        return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    path = local_media_path(url)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Screenshot not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/tinyfish/usage", response_model=TinyFishUsage)
async def tinyfish_usage(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TinyFishUsage:
    plan = await get_user_plan(session, user.id)
    now = datetime.now(UTC)
    today_start = credit_day_start(now)
    runs_today = await session.scalar(
        select(func.count())
        .select_from(CheckRun)
        .join(Product, Product.id == CheckRun.product_id)
        .where(Product.user_id == user.id, CheckRun.started_at >= today_start)
    )
    total, succeeded = (
        await session.execute(
            select(
                func.count(),
                func.count().filter(CheckResult.status == "ok"),
            )
            .select_from(CheckResult)
            .join(Product, Product.id == CheckResult.product_id)
            .where(
                Product.user_id == user.id,
                CheckResult.checked_at >= now - timedelta(days=7),
            )
        )
    ).one()
    return TinyFishUsage(
        mode=settings.tinyfish_mode,
        concurrency=settings.tinyfish_max_concurrency,
        credits_today=await daily_credits_used(session, user.id),
        daily_budget=limits_for(plan).daily_credit_budget,
        runs_today=runs_today or 0,
        success_rate_7d=round(succeeded / total, 4) if total else None,
    )


@router.get("/tinyfish/apps", response_model=list[AppStatus])
async def tinyfish_apps(
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> list[AppStatus]:
    """Live / Cached / Unavailable status and check method for every app."""
    from ..services.tinyfish.demo_cache import load_cache

    cached = {entry.get("platform") for entry in load_cache()}
    statuses: list[AppStatus] = []
    for platform, label in APP_LABELS.items():
        method = CHECK_STRATEGY.get(platform, "none")
        pincode_specific = method == "agent"
        if not settings.tinyfish_enabled and not settings.tinyfish_demo:
            status_ = "simulated"
            detail = (
                "No TinyFish key: simulated agent, per pincode, 1 credit per check"
                if method == "agent"
                else "No TinyFish key: simulated Fetch read, listing-wide, free"
            )
            method = "simulated"
        elif settings.tinyfish_enabled and platform not in settings.live_platforms:
            # The runner drops these jobs, so nothing (not even saved results) is shown.
            status_ = "unavailable"
            detail = f"Not available in live mode: {unavailable_reason(platform)}"
        elif settings.tinyfish_demo:
            if platform in cached:
                status_, detail = "cached", "Demo mode: replaying saved live results"
            else:
                status_, detail = "unavailable", "Demo mode: no saved results for this app"
        elif platform in settings.live_platforms:
            status_ = "live"
            detail = (
                "TinyFish agent sets each pincode (3-8 min per check)"
                if method == "agent"
                else "TinyFish Fetch reads the listing in seconds (not per pincode)"
            )
            if platform in cached:
                detail += "; falls back to saved results if blocked"
        else:
            status_ = "unavailable"
            detail = unavailable_reason(platform)
        statuses.append(
            AppStatus(
                platform=platform,
                label=label,
                status=status_,
                method=method,
                pincode_specific=pincode_specific,
                detail=detail,
            )
        )
    return statuses
