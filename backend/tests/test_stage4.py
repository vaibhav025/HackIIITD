"""Stage 4: heatmap classification, hot zones, change detection, insights, dashboard."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.checks import ChangeEvent, CheckResult, CheckRun
from app.models.intelligence import AISummary, Alert, Recommendation, ReviewInsight
from app.models.product import Competitor, Product, ProductPincode
from app.models.user import Subscription, User
from app.services.heatmap import PinPoint, classify_pin_status, find_hot_zones
from app.services.insights import compare_results, detect_changes

NOW = datetime.now(UTC)
QUERY = "Amul Taaza Toned Milk 500 ml"


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
    return app


async def make_product(
    user_id: str,
    *,
    name: str = QUERY,
    pincodes: list[str],
    platforms: list[str] | None = None,
    with_competitor: bool = True,
) -> str:
    platforms = platforms or ["blinkit"]
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name=name, search_query=name)
        session.add(product)
        await session.flush()
        if with_competitor:
            session.add(
                Competitor(
                    product_id=product.id,
                    name="Amul Value Pack",
                    platform=platforms[0],
                    search_query=name,
                    confirmed=True,
                )
            )
        session.add_all(
            ProductPincode(product_id=product.id, pincode=code, platform=platform)
            for code in pincodes
            for platform in platforms
        )
        await session.commit()
        return str(product.id)


async def make_run(product_id: str, status: str = "done") -> str:
    async with SessionLocal() as session:
        run = CheckRun(product_id=product_id, trigger="manual", status=status)
        session.add(run)
        await session.commit()
        return str(run.id)


async def get_competitor_id(product_id: str) -> str:
    async with SessionLocal() as session:
        competitor = await session.scalar(
            select(Competitor).where(Competitor.product_id == product_id).limit(1)
        )
        return str(competitor.id)


async def add_result(
    run_id: str,
    product_id: str,
    competitor_id: str | None,
    platform: str,
    pincode: str,
    *,
    price: float | None = None,
    in_stock: bool | None = None,
    mrp: float | None = None,
    eta: int | None = None,
    rating: float | None = None,
    status: str = "ok",
    checked_at: datetime | None = None,
    screenshot_url: str | None = None,
    error: str | None = None,
) -> None:
    async with SessionLocal() as session:
        session.add(
            CheckResult(
                run_id=run_id,
                product_id=product_id,
                competitor_id=competitor_id,
                platform=platform,
                pincode=pincode,
                in_stock=in_stock,
                price=price,
                mrp=mrp,
                eta_minutes=eta,
                rating=rating,
                status=status,
                screenshot_url=screenshot_url,
                error=error,
                raw={},
                checked_at=checked_at or (NOW - timedelta(minutes=10)),
            )
        )
        await session.commit()


def test_classify_pin_status_rules() -> None:
    cutoff = NOW
    fresh = NOW - timedelta(minutes=30)
    assert (
        classify_pin_status("failed", None, None, fresh, None, cutoff) == "stale"
    )
    assert (
        classify_pin_status("ok", True, 30.0, NOW - timedelta(hours=25), None, cutoff)
        == "stale"
    )
    assert (
        classify_pin_status(None, None, None, None, None, cutoff) == "stale"
    )
    assert (
        classify_pin_status("ok", False, 30.0, fresh, None, cutoff)
        == "out_of_stock"
    )
    assert (
        classify_pin_status("ok", True, 32.0, fresh, 30.0, cutoff) == "price_gap"
    )
    assert (
        classify_pin_status("ok", True, 30.0, fresh, 29.0, cutoff) == "in_stock"
    )


def test_find_hot_zones_clusters_out_of_stock_pins() -> None:
    pins = [
        PinPoint("110016", 28.5200, 77.2000, "out_of_stock"),
        PinPoint("110017", 28.5250, 77.2000, "out_of_stock"),
        PinPoint("110019", 28.5300, 77.2000, "out_of_stock"),
        PinPoint("110021", 28.5200, 77.2000, "in_stock"),
        PinPoint("110999", 28.7000, 77.2000, "out_of_stock"),
    ]
    zones = find_hot_zones(pins)
    assert len(zones) == 1
    assert zones[0]["count"] == 3
    assert zones[0]["pincodes"] == ["110016", "110017", "110019"]
    assert zones[0]["lat"] == pytest.approx(28.525, abs=0.001)

    assert find_hot_zones(pins[:2]) == []


def test_compare_results_change_rules() -> None:
    def row(**kwargs) -> CheckResult:
        defaults = {
            "run_id": "run",
            "product_id": "product",
            "platform": "blinkit",
            "pincode": "110016",
            "status": "ok",
            "raw": {},
        }
        defaults.update(kwargs)
        return CheckResult(**defaults)

    price_up = compare_results(row(price=30.0), row(price=32.0))
    assert [event["kind"] for event in price_up] == ["price_rise"]
    price_down = compare_results(row(price=32.0), row(price=30.0))
    assert [event["kind"] for event in price_down] == ["price_drop"]
    assert compare_results(row(price=30.0), row(price=30.5)) == []
    assert [
        event["kind"]
        for event in compare_results(row(in_stock=True), row(in_stock=False))
    ] == ["went_oos"]
    assert [
        event["kind"]
        for event in compare_results(row(in_stock=False), row(in_stock=True))
    ] == ["back_in_stock"]
    assert [
        event["kind"]
        for event in compare_results(row(rating=4.0), row(rating=4.2))
    ] == ["rating_change"]
    assert compare_results(row(rating=4.0), row(rating=4.05)) == []


@pytest.mark.asyncio
async def test_detect_changes_persists_events() -> None:
    user = await make_user("Changelog")
    product_id = await make_product(user.id, pincodes=["110016", "110017"])
    competitor_id = await get_competitor_id(product_id)
    prior_run = await make_run(product_id)
    current_run = await make_run(product_id)
    await add_result(
        prior_run,
        product_id,
        None,
        "blinkit",
        "110016",
        price=30.0,
        in_stock=True,
        rating=4.0,
        checked_at=NOW - timedelta(hours=2),
    )
    await add_result(
        current_run,
        product_id,
        None,
        "blinkit",
        "110016",
        price=33.0,
        in_stock=False,
        rating=4.3,
        checked_at=NOW,
    )
    await add_result(
        current_run,
        product_id,
        competitor_id,
        "blinkit",
        "110017",
        price=29.0,
        in_stock=True,
        checked_at=NOW,
    )
    async with SessionLocal() as session:
        events = await detect_changes(session, current_run, product_id)
        kinds = sorted(event.kind for event in events)
        assert kinds == ["price_rise", "rating_change", "went_oos"]
        stored = list(
            (
                await session.scalars(
                    select(ChangeEvent).where(ChangeEvent.product_id == product_id)
                )
            ).all()
        )
    assert len(stored) == 3


@pytest.mark.asyncio
async def test_heatmap_endpoint_statuses_and_summary() -> None:
    user = await make_user("Heatmap")
    product_id = await make_product(
        user.id, pincodes=["110016", "110017", "110019", "110021", "110024"]
    )
    competitor_id = await get_competitor_id(product_id)
    run_id = await make_run(product_id)
    await add_result(
        run_id, product_id, None, "blinkit", "110016", price=30.0, in_stock=True
    )
    await add_result(
        run_id, product_id, None, "blinkit", "110017", price=30.0, in_stock=False
    )
    await add_result(
        run_id, product_id, None, "blinkit", "110019", price=32.0, in_stock=True
    )
    await add_result(
        run_id,
        product_id,
        competitor_id,
        "blinkit",
        "110019",
        price=30.0,
        in_stock=True,
    )
    await add_result(
        run_id, product_id, None, "blinkit", "110021", status="failed", error="boom"
    )

    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            f"/api/products/{product_id}/heatmap", params={"platform": "blinkit"}
        )
        bad_platform = await client.get(
            f"/api/products/{product_id}/heatmap", params={"platform": "zepto"}
        )
    assert response.status_code == 200
    payload = response.json()
    statuses = {pin["pincode"]: pin["status"] for pin in payload["pins"]}
    assert statuses == {
        "110016": "in_stock",
        "110017": "out_of_stock",
        "110019": "price_gap",
        "110021": "stale",
        "110024": "stale",
    }
    assert payload["summary"] == {
        "in_stock": 1,
        "out_of_stock": 1,
        "price_gap": 1,
        "stale": 2,
        "failed": 1,
        "unavailable": 0,
        "total": 5,
    }
    assert payload["hot_zones"] == []
    assert payload["snapshot"] == "now"
    assert bad_platform.status_code == 422

    outsider = await make_user("Heatmap outsider")
    async with AsyncClient(
        transport=ASGITransport(app=app_for(outsider)), base_url="http://test"
    ) as client:
        hidden = await client.get(f"/api/products/{product_id}/heatmap")
    assert hidden.status_code == 404


@pytest.mark.asyncio
async def test_pincode_detail_includes_screenshot_and_rivals() -> None:
    user = await make_user("Pin detail")
    product_id = await make_product(user.id, pincodes=["110016", "110019"])
    competitor_id = await get_competitor_id(product_id)
    run_id = await make_run(product_id)
    await add_result(
        run_id,
        product_id,
        None,
        "blinkit",
        "110016",
        price=30.0,
        in_stock=True,
        rating=4.1,
        eta=12,
        screenshot_url="/media/screenshots/demo.png",
    )
    await add_result(
        run_id, product_id, None, "blinkit", "110019", price=32.0, in_stock=True
    )
    await add_result(
        run_id,
        product_id,
        competitor_id,
        "blinkit",
        "110019",
        price=30.0,
        in_stock=True,
    )
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        detail = await client.get(
            f"/api/products/{product_id}/heatmap/pincodes/110016"
        )
        gap_detail = await client.get(
            f"/api/products/{product_id}/heatmap/pincodes/110019"
        )
        unknown = await client.get(
            f"/api/products/{product_id}/heatmap/pincodes/110001"
        )
    assert detail.status_code == 200
    body = detail.json()
    assert body["area"] is not None
    assert body["platforms"][0]["seller"]["screenshot_url"] == (
        "/media/screenshots/demo.png"
    )
    assert body["platforms"][0]["status"] == "in_stock"
    assert gap_detail.json()["platforms"][0]["status"] == "price_gap"
    assert gap_detail.json()["platforms"][0]["rivals"][0]["price"] == 30.0
    assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_overview_exposes_kpis_summary_and_recommendations() -> None:
    user = await make_user("Overview")
    product_id = await make_product(user.id, pincodes=["110016", "110017"])
    run_id = await make_run(product_id)
    await add_result(
        run_id, product_id, None, "blinkit", "110016", price=30.0, in_stock=True,
        rating=4.2,
    )
    await add_result(
        run_id, product_id, None, "blinkit", "110017", price=34.0, in_stock=True,
        rating=4.4,
    )
    async with SessionLocal() as session:
        session.add(
            AISummary(
                product_id=product_id,
                summary_text="Stable week with one watch point.",
                evidence={"pins": 2},
                source="fallback",
            )
        )
        session.add_all(
            [
                Recommendation(
                    product_id=product_id,
                    priority="low",
                    action_text="Watch the market.",
                    impact_text="Stay informed.",
                ),
                Recommendation(
                    product_id=product_id,
                    priority="high",
                    action_text="Reprice now.",
                    impact_text="Win the buy box.",
                ),
            ]
        )
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/products/{product_id}/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["kpis"]["avg_price"]["value"] == 32.0
    assert len(body["kpis"]["avg_price"]["sparkline"]) == 7
    assert body["kpis"]["in_stock"]["value"] == 2
    assert body["kpis"]["in_stock"]["total"] == 2
    assert body["summary"]["source"] == "fallback"
    assert [rec["priority"] for rec in body["recommendations"]] == ["high", "low"]


@pytest.mark.asyncio
async def test_competitor_summary_puts_seller_first() -> None:
    user = await make_user("Comparison")
    product_id = await make_product(user.id, pincodes=["110016"])
    competitor_id = await get_competitor_id(product_id)
    run_id = await make_run(product_id)
    await add_result(
        run_id, product_id, None, "blinkit", "110016", price=30.0, in_stock=True,
        eta=15,
    )
    await add_result(
        run_id,
        product_id,
        competitor_id,
        "blinkit",
        "110016",
        price=27.0,
        in_stock=True,
        eta=18,
    )
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/products/{product_id}/competitors/summary")
    assert response.status_code == 200
    rows = response.json()
    assert rows[0]["is_seller"] is True
    assert rows[0]["entity_id"] is None
    rival = next(row for row in rows if row["entity_id"] is not None)
    assert rival["price"] == 27.0
    assert rival["price_delta_pct"] == -10.0


@pytest.mark.asyncio
async def test_weekly_report_and_changelog() -> None:
    user = await make_user("Weekly")
    product_id = await make_product(user.id, pincodes=["110016", "110017"])
    run_id = await make_run(product_id)
    await add_result(
        run_id,
        product_id,
        None,
        "blinkit",
        "110016",
        price=30.0,
        in_stock=True,
        checked_at=NOW - timedelta(days=2),
    )
    await add_result(
        run_id,
        product_id,
        None,
        "blinkit",
        "110017",
        price=30.0,
        in_stock=False,
        checked_at=NOW - timedelta(days=2),
    )
    await add_result(
        run_id,
        product_id,
        None,
        "blinkit",
        "110016",
        price=36.0,
        in_stock=True,
        checked_at=NOW - timedelta(days=9),
    )
    async with SessionLocal() as session:
        session.add(
            ChangeEvent(
                product_id=product_id,
                platform="blinkit",
                pincode="110017",
                kind="went_oos",
                old_value=1.0,
                new_value=0.0,
                detected_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/products/{product_id}/weekly")
        csv_report = await client.get(f"/api/products/{product_id}/weekly/report.csv")
    assert response.status_code == 200
    body = response.json()
    assert body["this_week"]["avg_price"] == 30.0
    assert body["this_week"]["oos_count"] == 1
    assert body["last_week"]["avg_price"] == 36.0
    assert len(body["series"]["days"]) == 7
    assert body["series"]["entities"][0]["is_seller"] is True
    assert [entry["kind"] for entry in body["changelog"]] == ["went_oos"]
    assert csv_report.headers["content-type"].startswith("text/csv")
    assert csv_report.text.splitlines()[0] == (
        "date,week,entity,platform,avg_price,checks,in_stock,avg_rating"
    )
    assert "this_week" in csv_report.text


@pytest.mark.asyncio
async def test_reviews_endpoint_separates_own_and_rival_signals() -> None:
    user = await make_user("Reviews")
    product_id = await make_product(user.id, pincodes=["110016"])
    competitor_id = await get_competitor_id(product_id)
    async with SessionLocal() as session:
        session.add_all(
            [
                ReviewInsight(
                    product_id=product_id,
                    competitor_id=None,
                    loves=["Fresh taste"],
                    complaints=["Stockouts"],
                ),
                ReviewInsight(
                    product_id=product_id,
                    competitor_id=competitor_id,
                    loves=["Low price"],
                    complaints=["Stockouts"],
                ),
            ]
        )
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"/api/products/{product_id}/reviews")
    assert response.status_code == 200
    body = response.json()
    # The seller's own signals and the rivals' are kept apart.
    assert body["loves"] == ["Fresh taste"]
    assert body["complaints"] == ["Stockouts"]
    assert body["rival_loves"] == ["Low price"]
    assert body["rival_complaints"] == ["Stockouts"]
    assert body["items"][0]["entity_id"] is None


@pytest.mark.asyncio
async def test_dashboard_tiles_alerts_and_recommendations() -> None:
    user = await make_user("Dashboard")
    product_id = await make_product(user.id, pincodes=["110016"])
    async with SessionLocal() as session:
        session.add_all(
            [
                Alert(
                    user_id=user.id,
                    product_id=product_id,
                    kind="oos_any",
                    message="Amul Taaza went out of stock in 110016.",
                    evidence={"pincode": "110016"},
                    dedupe_key=f"dash:{uuid4()}",
                ),
                Recommendation(
                    product_id=product_id,
                    priority="high",
                    action_text="Match the rival price.",
                    impact_text="Protect the shelf slot.",
                ),
            ]
        )
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/dashboard")
    assert response.status_code == 200
    body = response.json()
    tile_keys = {tile["key"] for tile in body["tiles"]}
    assert {"products", "alerts_today", "pending_recommendations"} <= tile_keys
    assert len(body["alerts"]) == 1
    assert body["alerts"][0]["product_name"] == QUERY
    assert body["recommendations"][0]["priority"] == "high"
    assert body["telegram"] == {"connected": False, "total": 0}
