import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.mark.asyncio
async def test_catalog_pincodes_plans_selection_and_listings() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pincodes = (await client.get("/api/pincodes")).json()
        assert pincodes and {"code", "area_name", "lat", "lng"} <= pincodes[0].keys()

        plans = (await client.get("/api/plans")).json()
        assert {p["plan"] for p in plans["plans"]} == {"free", "pro", "brand"}
        assert "blinkit" in plans["platforms"]

        product_id = (await client.get("/api/products")).json()[0]["id"]
        selection = (await client.get(f"/api/products/{product_id}/pincodes")).json()
        assert selection["pincodes"] and selection["platforms"]

        url = f"/api/products/{product_id}/listings"
        body = {"listings": [{"platform": "blinkit", "url": "https://blinkit.com/p/1"}]}
        assert (await client.put(url, json=body)).status_code == 200
        assert (await client.get(url)).json() == body["listings"]


@pytest.mark.asyncio
async def test_parse_plain_english_alert_rule() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        product_id = (await client.get("/api/products")).json()[0]["id"]
        res = await client.post(
            f"/api/products/{product_id}/alert-rules/parse",
            json={"text": "Alert me if we go out of stock in South Delhi"},
        )
    assert res.status_code == 200
    # A named area becomes an area-scoped rule rather than "any pincode".
    assert res.json()["kind"] == "oos_area"
    pincodes = res.json()["rule_json"]["pincodes"]
    assert "110017" in pincodes  # Saket
    assert "110005" not in pincodes  # Karol Bagh is not South Delhi


@pytest.mark.asyncio
async def test_simulated_telegram_link_in_mock_mode() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        product_id = (await client.post(
            "/api/products", json={"name": "Link test", "search_query": "Link test"}
        )).json()["id"]
        code = (await client.post(f"/api/products/{product_id}/telegram/link-code")).json()["code"]
        res = await client.post(
            f"/api/products/{product_id}/telegram/simulate-link", json={"code": code}
        )
        assert res.status_code == 204
        status = (await client.get(f"/api/products/{product_id}/telegram/status")).json()
        assert status["status"] == "connected"
        await client.delete(f"/api/products/{product_id}")


@pytest.mark.asyncio
async def test_update_profile() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        original = (await client.get("/api/me")).json()["profile"]["default_city"]
        res = await client.patch("/api/me", json={"default_city": "Gurugram"})
        assert res.status_code == 200 and res.json()["default_city"] == "Gurugram"
        await client.patch("/api/me", json={"default_city": original})
