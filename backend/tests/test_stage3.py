"""Stage 3: TinyFish interface, mock client, runner pipeline, SSE streaming."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import get_current_user, get_stream_user
from app.main import create_app
from app.models.checks import CheckResult, CheckRun, CreditLedger
from app.models.product import Competitor, Product, ProductPincode
from app.models.user import Subscription, User
from app.services.runner import Job, check_with_retry
from app.services.tinyfish import CheckResult as TinyCheckResult
from app.services.tinyfish import MockTinyFishClient, TinyFishError

QUERY = "Amul Taaza Toned Milk 500 ml"
PINCODE = "110016"


async def make_user(name: str, plan: str = "pro") -> User:
    async with SessionLocal() as session:
        user = User(name=name, email=f"{uuid4()}@test.local")
        session.add(user)
        await session.flush()
        session.add(Subscription(user_id=user.id, plan=plan, status="active"))
        await session.commit()
        return user


def app_for(user: User):
    app = create_app()

    async def current_user_override() -> User:
        return user

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_stream_user] = current_user_override
    return app


async def make_product(user_id: str) -> str:
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name=QUERY, search_query=QUERY)
        session.add(product)
        await session.flush()
        session.add(
            Competitor(
                product_id=product.id,
                name="Amul Value Pack",
                platform="blinkit",
                search_query=QUERY,
                url="https://mock.shelfsense.local/blinkit/value-pack",
                confirmed=True,
            )
        )
        session.add(
            ProductPincode(product_id=product.id, pincode=PINCODE, platform="blinkit")
        )
        await session.commit()
        return str(product.id)


async def read_sse_events(
    client: AsyncClient, run_id: str, timeout: float = 30.0
) -> list[dict]:
    events: list[dict] = []
    async with client.stream(
        "GET", f"/api/runs/{run_id}/stream", timeout=timeout
    ) as response:
        assert response.status_code == 200
        event_name: str | None = None
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
            elif line == "":
                if event_name is not None and data_lines:
                    events.append(
                        {"event": event_name, "data": json.loads("\n".join(data_lines))}
                    )
                event_name = None
                data_lines = []
                if events and events[-1]["event"] == "run_done":
                    break
    return events


@pytest.mark.asyncio
async def test_run_pipeline_end_to_end_with_mock_client() -> None:
    user = await make_user("Runner")
    product_id = await make_product(user.id)
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        started = await client.post(f"/api/products/{product_id}/runs")
        assert started.status_code == 202
        body = started.json()
        run_id = body["run_id"]
        assert body["estimated_credits"] == 2  # seller + 1 confirmed competitor

        duplicate = await client.post(f"/api/products/{product_id}/runs")
        assert duplicate.status_code == 409

        events = await read_sse_events(client, run_id)

        polled = await client.get(f"/api/runs/{run_id}")
        assert polled.status_code == 200

        replay = await read_sse_events(client, run_id)

    kinds = [event["event"] for event in events]
    assert kinds[-1] == "run_done"
    assert kinds.count("job_started") >= 1
    assert "result" in kinds or "job_failed" in kinds
    done = events[-1]["data"]
    assert done["status"] == "done"
    assert done["total_jobs"] == 2
    assert done["done_jobs"] == 2

    run_payload = polled.json()
    assert run_payload["status"] == "done"
    assert run_payload["done_jobs"] == 2
    assert run_payload["credits_used"] >= 1
    assert run_payload["started_at"] is not None
    assert run_payload["finished_at"] is not None

    assert replay[-1]["event"] == "run_done"

    async with SessionLocal() as session:
        rows = list(
            (
                await session.scalars(
                    select(CheckResult).where(CheckResult.run_id == run_id)
                )
            ).all()
        )
        ledger = list(
            (
                await session.scalars(
                    select(CreditLedger).where(CreditLedger.run_id == run_id)
                )
            ).all()
        )
    assert len(rows) == 2
    ok_rows = [row for row in rows if row.status == "ok"]
    assert ok_rows, "at least one job should succeed deterministically"
    assert all(
        row.screenshot_url and row.screenshot_url.startswith("/media/screenshots/")
        for row in ok_rows
    )
    assert len(ledger) == len(ok_rows)


@pytest.mark.asyncio
async def test_paused_product_cannot_run() -> None:
    user = await make_user("Paused owner")
    product_id = await make_product(user.id)
    async with SessionLocal() as session:
        product = await session.get(Product, product_id)
        product.paused = True
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(f"/api/products/{product_id}/runs")
    assert response.status_code == 422
    assert "Paused" in response.json()["error"]["message"]


@pytest.mark.asyncio
async def test_run_requires_pincode_selection() -> None:
    user = await make_user("No pincodes")
    async with SessionLocal() as session:
        product = Product(user_id=user.id, name="Unconfigured", search_query="X")
        session.add(product)
        await session.commit()
        product_id = str(product.id)
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(f"/api/products/{product_id}/runs")
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_run_rejects_unselected_pincode() -> None:
    user = await make_user("Bad pincode")
    product_id = await make_product(user.id)
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            f"/api/products/{product_id}/runs", json={"pincodes": ["110001"]}
        )
    assert response.status_code == 422
    assert "not selected" in response.json()["error"]["message"]


@pytest.mark.asyncio
async def test_runs_are_isolated_between_users() -> None:
    owner = await make_user("Run owner")
    outsider = await make_user("Run outsider")
    product_id = await make_product(owner.id)
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.commit()
        run_id = str(run.id)

    transport = ASGITransport(app=app_for(outsider))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        status_response = await client.get(f"/api/runs/{run_id}")
        stream_response = await client.get(f"/api/runs/{run_id}/stream")
        start_response = await client.post(f"/api/products/{product_id}/runs")
    assert status_response.status_code == 404
    assert stream_response.status_code == 404
    assert start_response.status_code == 404


@pytest.mark.asyncio
async def test_check_with_retry_recovers_after_one_failure() -> None:
    class FlakyClient:
        def __init__(self, failures: int) -> None:
            self.failures = failures
            self.calls = 0

        async def check(self, platform, pincode, query, url=None) -> TinyCheckResult:
            self.calls += 1
            if self.calls <= self.failures:
                raise TinyFishError("transient failure")
            return TinyCheckResult(product=query, in_stock=True, price=25.0, mrp=30.0)

    job = Job(None, "blinkit", PINCODE, QUERY, None)
    flaky = FlakyClient(failures=1)
    result = await check_with_retry(flaky, job)
    assert result.price == 25.0
    assert flaky.calls == 2

    hopeless = FlakyClient(failures=2)
    with pytest.raises(TinyFishError):
        await check_with_retry(hopeless, job)
    assert hopeless.calls == 2


@pytest.mark.asyncio
async def test_mock_client_is_deterministic_with_expected_rates() -> None:
    client = MockTinyFishClient(delay=(0, 0))
    first = await client.check("blinkit", PINCODE, QUERY, None)
    second = await client.check("blinkit", PINCODE, QUERY, None)
    assert first.price == second.price
    assert first.in_stock == second.in_stock
    assert first.rating == second.rating
    assert first.screenshot_bytes is not None

    failures = 0
    out_of_stock = 0
    for index in range(300):
        try:
            result = await client.check("blinkit", str(110000 + index), QUERY, None)
        except TinyFishError:
            failures += 1
        else:
            if result.in_stock is False:
                out_of_stock += 1
    assert 0 <= failures <= 40
    assert 25 <= out_of_stock <= 65
