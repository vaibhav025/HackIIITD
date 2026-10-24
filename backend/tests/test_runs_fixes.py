"""Runs / SSE / heatmap fixes: partial status, estimates, free Fetch reads,
live-mode unavailable apps, screenshot URLs, named SSE heartbeats."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.runs import stream_run
from app.config import Settings
from app.db import SessionLocal
from app.models.checks import CheckResult, CheckRun
from app.models.product import Competitor, Product, ProductPincode
from app.services import heatmap as heatmap_service
from app.services import storage
from app.services.runner import cancel_runs_for_product, run_outcome
from app.services.tinyfish import MockTinyFishClient
from app.services.tinyfish.availability import credit_cost, skipped_platforms
from tests.test_stage3 import app_for, make_user

PINCODE = "110016"
QUERY = "Amul Taaza Toned Milk 500 ml"


def live_settings() -> Settings:
    return Settings(tinyfish_api_key="tf_test", mock_mode=False, _env_file=None)


async def make_product(user_id: str, platforms: list[str], rival_platform: str = "zepto") -> str:
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name=QUERY, search_query=QUERY)
        session.add(product)
        await session.flush()
        session.add(
            Competitor(
                product_id=product.id,
                name="Rival",
                platform=rival_platform,
                search_query=QUERY,
                confirmed=True,
            )
        )
        for platform in platforms:
            session.add(ProductPincode(product_id=product.id, pincode=PINCODE, platform=platform))
        await session.commit()
        return str(product.id)


def test_run_outcome_partial() -> None:
    assert run_outcome(4, 0) == "done"
    assert run_outcome(4, 1) == "partial"
    assert run_outcome(4, 4) == "failed"


def test_credit_cost_and_skipped_platforms() -> None:
    assert credit_cost("zepto") == 1
    assert credit_cost("amazon") == 0
    assert skipped_platforms(live_settings(), ["blinkit", "zepto"]) == ["blinkit"]
    assert skipped_platforms(Settings(mock_mode=True, _env_file=None), ["blinkit"]) == []


@pytest.mark.asyncio
async def test_simulated_fetch_platforms_are_free_and_listing_wide() -> None:
    client = MockTinyFishClient(delay=(0, 0))
    first = await client.check("amazon", "110016", QUERY, None)
    other_pin = await client.check("amazon", "560001", QUERY, None)
    assert first.credits_used == 0
    assert first.raw["pincode_specific"] is False
    assert first.price == other_pin.price
    agent = await client.check("zepto", "110016", QUERY, None)
    assert agent.credits_used == 1


@pytest.mark.asyncio
async def test_estimate_matches_runner_jobs() -> None:
    user = await make_user("Estimator")
    product_id = await make_product(user.id, ["zepto", "amazon"])
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test") as client:
        estimate = (await client.get(f"/api/products/{product_id}/runs/estimate")).json()
        # (seller + rival) x 2 apps; the rival is checked on Amazon too.
        assert estimate["jobs"] == 4
        assert estimate["credits"] == 2  # Amazon reads are free
        started = (await client.post(f"/api/products/{product_id}/runs")).json()
    # Stop the background run so it cannot hold the SQLite write lock for later tests.
    await cancel_runs_for_product(product_id)
    assert started["total_jobs"] == estimate["jobs"]
    assert started["estimated_credits"] == estimate["credits"]


@pytest.mark.asyncio
async def test_heatmap_ignores_apps_live_mode_never_checks(monkeypatch) -> None:
    user = await make_user("Live heatmap")
    product_id = await make_product(user.id, ["blinkit", "zepto"])
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.flush()
        session.add(
            CheckResult(
                run_id=run.id,
                product_id=product_id,
                platform="zepto",
                pincode=PINCODE,
                in_stock=True,
                price=30.0,
                status="ok",
                screenshot_url="/media/screenshots/x/zepto.svg",
                raw={},
                checked_at=datetime.now(UTC) - timedelta(minutes=5),
            )
        )
        await session.commit()
    monkeypatch.setattr(heatmap_service, "get_settings", live_settings)
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test") as client:
        payload = (await client.get(f"/api/products/{product_id}/heatmap")).json()
        blinkit_only = (
            await client.get(f"/api/products/{product_id}/heatmap", params={"platform": "blinkit"})
        ).json()
        detail = (await client.get(f"/api/products/{product_id}/heatmap/pincodes/{PINCODE}")).json()
    pin = payload["pins"][0]
    assert pin["status"] == "in_stock" and pin["platform"] == "zepto"
    assert payload["unavailable_platforms"][0]["platform"] == "blinkit"
    assert blinkit_only["pins"][0]["stale_reason"] == "unavailable"
    assert blinkit_only["summary"]["unavailable"] == 1
    assert blinkit_only["summary"]["stale"] == 0
    rows = {row["platform"]: row for row in detail["platforms"]}
    assert rows["blinkit"]["unavailable_reason"]
    assert rows["zepto"]["seller"]["result_id"]


@pytest.mark.asyncio
async def test_pin_detail_screenshot_uses_owner_checked_url(monkeypatch) -> None:
    user = await make_user("Prod screenshots")
    product_id = await make_product(user.id, ["zepto"])
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="done")
        session.add(run)
        await session.flush()
        row = CheckResult(
            run_id=run.id,
            product_id=product_id,
            platform="zepto",
            pincode=PINCODE,
            in_stock=True,
            price=30.0,
            status="ok",
            screenshot_url="/media/screenshots/x/zepto.svg",
            raw={},
            checked_at=datetime.now(UTC),
        )
        session.add(row)
        await session.commit()
        result_id = row.id
    prod = Settings(app_env="production", mock_mode=True, _env_file=None)
    monkeypatch.setattr(storage, "get_settings", lambda: prod)
    monkeypatch.setattr(heatmap_service, "get_settings", lambda: prod)
    async with AsyncClient(transport=ASGITransport(app=app_for(user)), base_url="http://test") as client:
        detail = (await client.get(f"/api/products/{product_id}/heatmap/pincodes/{PINCODE}")).json()
    assert detail["platforms"][0]["seller"]["screenshot_url"] == f"/api/check-results/{result_id}/screenshot"


@pytest.mark.asyncio
async def test_stream_sends_named_ping_events() -> None:
    user = await make_user("Pinged")
    product_id = await make_product(user.id, ["zepto"])
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status="running")
        session.add(run)
        await session.commit()
        run_id = run.id
    # ASGITransport buffers whole responses, so read the SSE generator directly.
    response = await stream_run(
        run_id, ping=1, last_event_id=None, last_event_header=None, user=user
    )
    iterator = response.body_iterator
    try:
        first = await asyncio.wait_for(anext(iterator), timeout=5)
    finally:
        await iterator.aclose()
    assert first["event"] == "ping"
    assert json.loads(first["data"])["type"] == "ping"
    async with SessionLocal() as session:
        stored = await session.get(CheckRun, run_id)
        stored.status = "failed"
        await session.commit()
