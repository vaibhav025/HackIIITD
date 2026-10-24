from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from app.db import SessionLocal
from app.deps import get_current_user
from app.main import create_app
from app.models.product import Product
from app.models.user import Subscription, User


async def make_user(name: str, plan: str = "free") -> User:
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


@pytest.mark.asyncio
async def test_free_plan_enforces_product_limit() -> None:
    user = await make_user("Free plan seller")
    async with SessionLocal() as session:
        session.add_all(
            Product(
                user_id=user.id,
                name=f"Product {number}",
                search_query=f"Product {number}",
            )
            for number in range(3)
        )
        await session.commit()
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/products",
            json={
                "name": "One too many",
                "search_query": "One too many",
                "check_frequency": "weekly",
            },
        )
    assert response.status_code == 422
    assert "up to 3 products" in response.json()["error"]["message"]


@pytest.mark.asyncio
async def test_products_are_isolated_between_users() -> None:
    owner = await make_user("Owner", plan="pro")
    outsider = await make_user("Outsider", plan="pro")
    async with SessionLocal() as session:
        product = Product(
            user_id=owner.id,
            name="Owner only product",
            search_query="Owner only product",
        )
        session.add(product)
        await session.commit()
        product_id = product.id

    transport = ASGITransport(app=app_for(outsider))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        hidden = await client.get(f"/api/products/{product_id}")
        listing = await client.get("/api/products")
        forbidden_update = await client.patch(
            f"/api/products/{product_id}", json={"paused": True}
        )
    assert hidden.status_code == 404
    assert product_id not in {item["id"] for item in listing.json()}
    assert forbidden_update.status_code == 404


@pytest.mark.asyncio
async def test_pincode_selection_respects_free_plan_limit() -> None:
    user = await make_user("Pincode limited")
    async with SessionLocal() as session:
        product = Product(
            user_id=user.id, name="Test product", search_query="Test product"
        )
        session.add(product)
        await session.commit()
        product_id = product.id
    transport = ASGITransport(app=app_for(user))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put(
            f"/api/products/{product_id}/pincodes",
            json={
                "platforms": ["blinkit"],
                "pincodes": [
                    "110003",
                    "110014",
                    "110016",
                    "110017",
                    "110019",
                    "110021",
                ],
            },
        )
    assert response.status_code == 422
    assert "up to 5 pincodes" in response.json()["error"]["message"]
