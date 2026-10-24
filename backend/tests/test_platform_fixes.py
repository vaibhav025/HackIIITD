"""App shell / infra fixes: CORS for LAN demos, asymmetric Supabase tokens, account
usage per product, settings validation and plan-downgrade reporting."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app import deps as deps_module
from app.config import Settings
from app.db import SessionLocal
from app.deps import decode_supabase_token, get_current_user, verify_supabase_token
from app.main import DEV_ORIGIN_REGEX, create_app
from app.models.product import Competitor, Pincode, Product, ProductPincode
from app.models.user import Subscription, User

SECRET = "test-secret-with-enough-length-for-hs256"


async def make_user(plan: str = "pro") -> User:
    async with SessionLocal() as session:
        user = User(name="Platform Tester", email=f"{uuid4()}@test.local")
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


def client_for(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def make_product(user_id: str, pincodes: list[str], competitors: int = 0) -> str:
    async with SessionLocal() as session:
        product = Product(user_id=user_id, name="Amul Taaza", search_query="Amul Taaza")
        session.add(product)
        await session.flush()
        for code in pincodes:
            session.add(ProductPincode(product_id=product.id, pincode=code, platform="zepto"))
            session.add(ProductPincode(product_id=product.id, pincode=code, platform="amazon"))
        for i in range(competitors):
            session.add(Competitor(product_id=product.id, name=f"Rival {i}", platform="zepto"))
        await session.commit()
        return str(product.id)


async def seeded_pincodes(count: int) -> list[str]:
    async with SessionLocal() as session:
        codes = list((await session.scalars(select(Pincode.code).limit(count))).all())
    assert len(codes) == count, "seed has too few pincodes for this test"
    return codes


def claims(**extra) -> dict:
    return {
        "sub": str(uuid4()),
        "aud": "authenticated",
        "exp": datetime.now(UTC) + timedelta(minutes=5),
        **extra,
    }


# ---------------------------------------------------------------- CORS


def test_cors_origins_merge_frontend_origin_and_list() -> None:
    settings = Settings(
        frontend_origin="http://localhost:3000/",
        frontend_origins=" https://shelfsense.example , http://localhost:3000,",
    )
    assert settings.cors_origins == ["http://localhost:3000", "https://shelfsense.example"]


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:3000",
        "http://127.0.0.1:3001",
        "http://192.168.1.20:3000",
        "http://10.0.0.5:3000",
        "http://172.16.4.2:3000",
        "http://172.31.255.1",
    ],
)
def test_dev_regex_allows_local_and_lan(origin: str) -> None:
    assert re.fullmatch(DEV_ORIGIN_REGEX, origin)


@pytest.mark.parametrize(
    "origin",
    ["http://172.32.0.1:3000", "http://8.8.8.8:3000", "https://evil.example", "http://192.168.1.20.evil.com"],
)
def test_dev_regex_rejects_public_origins(origin: str) -> None:
    assert not re.fullmatch(DEV_ORIGIN_REGEX, origin)


@pytest.mark.asyncio
async def test_lan_origin_gets_cors_headers_in_development() -> None:
    async with client_for(create_app()) as client:
        res = await client.options(
            "/api/health",
            headers={
                "Origin": "http://192.168.1.20:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://192.168.1.20:3000"


# ---------------------------------------------------------------- auth


def test_hs256_token_still_verifies_with_secret() -> None:
    token = jwt.encode(claims(), SECRET, algorithm="HS256")
    assert decode_supabase_token(token, SECRET)["aud"] == "authenticated"


def test_es256_token_verifies_with_jwks_key() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(claims(), key, algorithm="ES256", headers={"kid": "k1"})
    assert decode_supabase_token(token, "", key.public_key())["sub"]


def test_es256_token_without_jwks_key_is_rejected() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(claims(), key, algorithm="ES256")
    with pytest.raises(HTTPException) as exc:
        decode_supabase_token(token, SECRET)
    assert exc.value.status_code == 401


def test_es256_token_signed_by_other_key_is_rejected() -> None:
    signer = ec.generate_private_key(ec.SECP256R1())
    other = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(claims(), signer, algorithm="ES256")
    with pytest.raises(HTTPException) as exc:
        decode_supabase_token(token, "", other.public_key())
    assert exc.value.status_code == 401


def test_unsigned_token_is_rejected() -> None:
    token = jwt.encode(claims(), None, algorithm="none")
    with pytest.raises(HTTPException):
        decode_supabase_token(token, SECRET)


@pytest.mark.asyncio
async def test_verify_fetches_signing_key_from_project_jwks(monkeypatch) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    token = jwt.encode(claims(), key, algorithm="ES256", headers={"kid": "k1"})
    seen: list[str] = []

    class FakeClient:
        def get_signing_key_from_jwt(self, value: str):
            assert value == token

            class Signing:
                pass

            signing = Signing()
            signing.key = key.public_key()
            return signing

    def fake_client(url: str) -> FakeClient:
        seen.append(url)
        return FakeClient()

    monkeypatch.setattr(deps_module, "jwks_client", fake_client)
    settings = Settings(supabase_url="https://abc.supabase.co/", supabase_jwt_secret=SECRET)
    assert (await verify_supabase_token(token, settings))["aud"] == "authenticated"
    assert seen == ["https://abc.supabase.co/auth/v1/.well-known/jwks.json"]


def test_jwks_url_alone_turns_supabase_auth_on() -> None:
    settings = Settings(supabase_jwt_secret="", supabase_jwks_url="https://x/jwks.json")
    assert settings.auth_mode == "supabase"
    assert Settings(supabase_jwt_secret="", supabase_jwks_url="").auth_mode == "dev"


def test_production_accepts_jwks_only_configuration() -> None:
    Settings(app_env="production", supabase_jwks_url="https://x/jwks.json").validate_for_startup()
    with pytest.raises(RuntimeError):
        Settings(app_env="production", supabase_jwt_secret="", supabase_jwks_url="").validate_for_startup()


# ---------------------------------------------------------------- health / account


@pytest.mark.asyncio
async def test_health_reports_test_billing_in_development() -> None:
    async with client_for(create_app()) as client:
        body = (await client.get("/api/health")).json()
    assert body["billing_mode"] == "test"


@pytest.mark.asyncio
async def test_me_reports_busiest_product_usage() -> None:
    user = await make_user()
    codes = await seeded_pincodes(4)
    await make_product(user.id, codes[:3], competitors=2)
    await make_product(user.id, codes[1:4], competitors=1)
    async with client_for(app_for(user)) as client:
        usage = (await client.get("/api/me")).json()["usage"]
    assert usage["pincodes"] == 4  # distinct, account-wide
    assert usage["max_pincodes_per_product"] == 3
    assert usage["max_competitors_per_product"] == 2


@pytest.mark.asyncio
async def test_profile_business_type_must_be_an_offered_option() -> None:
    user = await make_user()
    async with client_for(app_for(user)) as client:
        bad = await client.patch("/api/me", json={"business_type": "pirate"})
    assert bad.status_code == 422
    assert bad.json()["error"]["fields"][0]["loc"].endswith("business_type")


@pytest.mark.parametrize(
    "payload",
    [
        {"quiet_hours_start": "22:00"},
        {"quiet_hours_end": "07:00"},
        {"quiet_hours_start": "22:00", "quiet_hours_end": None},
    ],
)
@pytest.mark.asyncio
async def test_quiet_hours_need_both_ends(payload: dict) -> None:
    user = await make_user()
    async with client_for(app_for(user)) as client:
        res = await client.patch("/api/me/settings", json=payload)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_quiet_hours_set_and_clear_together() -> None:
    user = await make_user()
    async with client_for(app_for(user)) as client:
        on = await client.patch(
            "/api/me/settings", json={"quiet_hours_start": "22:00", "quiet_hours_end": "07:00"}
        )
        off = await client.patch(
            "/api/me/settings", json={"quiet_hours_start": None, "quiet_hours_end": None}
        )
        other = await client.patch("/api/me/settings", json={"briefing_time": "08:30"})
    assert on.status_code == 200 and on.json()["quiet_hours_start"] == "22:00"
    assert off.status_code == 200 and off.json()["quiet_hours_end"] is None
    assert other.status_code == 200


@pytest.mark.asyncio
async def test_plan_downgrade_lists_products_over_limits() -> None:
    user = await make_user(plan="pro")
    codes = await seeded_pincodes(6)
    big = await make_product(user.id, codes, competitors=4)
    await make_product(user.id, codes[:2], competitors=1)
    async with client_for(app_for(user)) as client:
        res = await client.post("/api/me/plan", json={"plan": "free"})
    assert res.status_code == 200
    over = res.json()["over_limit"]
    assert [row["product_id"] for row in over] == [big]
    assert over[0]["pincodes"] == 6 and over[0]["pincode_limit"] == 5
    assert over[0]["competitors"] == 4 and over[0]["competitor_limit"] == 3
