"""Authentication dependencies: development demo user or Supabase-issued JWTs."""

import asyncio
import logging
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings, get_settings
from .db import SessionLocal, get_session
from .models.user import User

DEMO_EMAIL = "riya@shelfsense.demo"
bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger("shelfsense.auth")

# Supabase signs with the legacy shared secret (HS256) or, with the newer signing
# keys, an asymmetric key published on the project's JWKS endpoint.
ASYMMETRIC_ALGORITHMS = frozenset({"ES256", "RS256"})


@lru_cache(maxsize=4)
def jwks_client(url: str) -> jwt.PyJWKClient:
    """One cached client per JWKS URL; keys are cached for an hour."""
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=3600, timeout=10)


def token_algorithm(token: str) -> str:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid bearer token") from exc
    return str(header.get("alg") or "")


def decode_supabase_token(token: str, secret: str, signing_key: object = None) -> dict:
    """Validate a Supabase access token; `exp` and `sub` are mandatory.

    HS256 tokens are checked against ``secret``; ES256/RS256 tokens against
    ``signing_key`` (a JWKS public key). Anything else is rejected.
    """
    algorithm = token_algorithm(token)
    if algorithm == "HS256":
        key: object = secret
    elif algorithm in ASYMMETRIC_ALGORITHMS:
        key = signing_key
    else:
        raise HTTPException(status_code=401, detail="Unsupported token algorithm")
    if not key:
        raise HTTPException(
            status_code=401,
            detail=f"This server is not configured to verify {algorithm} tokens",
        )
    try:
        claims = jwt.decode(
            token,
            key,  # type: ignore[arg-type]
            algorithms=[algorithm],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid bearer token") from exc
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        raise HTTPException(status_code=401, detail="Bearer token has no subject")
    return claims


async def verify_supabase_token(token: str, settings: Settings) -> dict:
    """Decode a token with whichever key its algorithm needs (JWKS fetched off-loop)."""
    signing_key = None
    if token_algorithm(token) in ASYMMETRIC_ALGORITHMS and settings.jwks_url:
        try:
            signing_key = (
                await asyncio.to_thread(
                    jwks_client(settings.jwks_url).get_signing_key_from_jwt, token
                )
            ).key
        except jwt.PyJWKClientConnectionError as exc:
            logger.warning("JWKS fetch failed: %s", exc)
            raise HTTPException(
                status_code=503, detail="Could not reach the Supabase signing keys"
            ) from exc
        except jwt.PyJWTError as exc:
            raise HTTPException(status_code=401, detail="Invalid bearer token") from exc
    return decode_supabase_token(token, settings.supabase_jwt_secret, signing_key)


async def provision_user(session: AsyncSession, claims: dict) -> User:
    """Return the local user for a token subject, creating it on first sight."""
    subject: str = claims["sub"]
    user = await session.get(User, subject)
    if user is not None:
        return user
    email = claims.get("email")
    email = email.strip().lower() if isinstance(email, str) and email.strip() else None
    if email is not None:
        owner = await session.scalar(select(User.id).where(User.email == email))
        if owner is not None:
            raise HTTPException(
                status_code=409,
                detail="Another account already uses this email address",
            )
    metadata = claims.get("user_metadata")
    full_name = metadata.get("full_name") if isinstance(metadata, dict) else None
    user = User(
        id=subject,
        name=str(full_name).strip()[:200] if full_name else "ShelfSense user",
        email=email or f"{subject}@supabase.local",
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent first request for the same subject won the insert.
        await session.rollback()
        user = await session.get(User, subject)
        if user is None:
            raise HTTPException(
                status_code=409,
                detail="Another account already uses this email address",
            ) from None
        return user
    await session.refresh(user)
    return user


async def resolve_user(
    session: AsyncSession, settings: Settings, token: str | None
) -> User:
    if settings.dev_auth_enabled:
        user = await session.scalar(select(User).where(User.email == DEMO_EMAIL))
        if user is None:
            raise HTTPException(
                status_code=503,
                detail="Demo user is missing; run python -m scripts.seed",
            )
        return user
    if not settings.supabase_auth_configured:
        # Production without a secret is refused at startup; never fail open here.
        raise HTTPException(status_code=503, detail="Authentication is not configured")
    if not token:
        raise HTTPException(status_code=401, detail="Bearer token required")
    claims = await verify_supabase_token(token, settings)
    return await provision_user(session, claims)


async def get_current_user(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> User:
    return await resolve_user(
        session, settings, credentials.credentials if credentials else None
    )


async def get_stream_user(
    settings: Settings = Depends(get_settings),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    access_token: str | None = Query(default=None, max_length=4096),
) -> User:
    """Auth for long-lived SSE responses.

    `EventSource` cannot set headers, so `?access_token=` is accepted as well.
    The lookup uses its own short session so no connection is held for the
    lifetime of the stream.
    """
    token = credentials.credentials if credentials else access_token
    async with SessionLocal() as session:
        return await resolve_user(session, settings, token)
