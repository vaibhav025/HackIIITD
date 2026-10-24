import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.mark.asyncio
async def test_health_reports_safe_defaults() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["mock_mode"] is True
    assert payload["integrations"]["tinyfish"] is False


@pytest.mark.asyncio
async def test_me_returns_seeded_dev_user() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/me")
    assert response.status_code == 200
    assert response.json()["profile"]["name"] == "Riya Sharma"
    assert response.json()["plan"] == "pro"
