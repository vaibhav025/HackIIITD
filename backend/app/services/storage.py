"""Screenshot storage: Supabase Storage when configured, local disk otherwise.

Local files land in ``./media/screenshots`` and are served by the app at
``/media/...``. Any Supabase failure falls back to local storage so a run never
loses its evidence. Object names are built only from sanitised parts and every
local path is checked to resolve inside the media directory.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from uuid import uuid4

import httpx

from ..config import Settings, get_settings

logger = logging.getLogger("shelfsense.storage")

LOCAL_BASE = Path("media") / "screenshots"
PUBLIC_PREFIX = "/media/screenshots"
EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
}
_UNSAFE = re.compile(r"[^a-z0-9_-]+")
PART_LIMIT = 64


def safe_part(value: str) -> str:
    """Lower-case ``value`` and drop everything outside ``[a-z0-9_-]``."""
    cleaned = _UNSAFE.sub("", value.lower())[:PART_LIMIT]
    if not cleaned:
        raise ValueError(f"Unusable storage path component: {value!r}")
    return cleaned


def screenshot_url_for(
    result_id: str, url: str | None, settings: Settings | None = None
) -> str | None:
    """URL a client should load for a result's screenshot.

    Production hides local ``/media`` files behind the owner-checked
    ``/api/check-results/{id}/screenshot`` endpoint; every API response and
    SSE event that carries a screenshot must go through this helper.
    """
    settings = settings or get_settings()
    if url and settings.is_production and url.startswith("/media/"):
        return f"/api/check-results/{result_id}/screenshot"
    return url


def _local_target(relative: str) -> Path:
    base = LOCAL_BASE.resolve()
    target = (base / relative).resolve()
    if not target.is_relative_to(base):
        raise ValueError(f"Storage path escapes the media directory: {relative!r}")
    return target


async def save_screenshot(
    data: bytes,
    *,
    product_id: str,
    platform: str,
    pincode: str,
    content_type: str = "image/png",
) -> str:
    extension = EXTENSIONS.get(content_type)
    if extension is None:
        raise ValueError(f"Unsupported screenshot content type: {content_type}")
    settings = get_settings()
    name = f"{safe_part(platform)}_{safe_part(pincode)}_{uuid4().hex[:12]}.{extension}"
    path = f"{safe_part(product_id)}/{name}"
    if settings.storage_enabled:
        uploaded = await _upload_supabase(settings, data, path, content_type)
        if uploaded is not None:
            return uploaded
        logger.warning("Supabase upload failed; saving screenshot locally instead")
    return await _save_local(data, path)


async def _save_local(data: bytes, path: str) -> str:
    target = _local_target(path)

    def write() -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    await asyncio.to_thread(write)
    return f"{PUBLIC_PREFIX}/{path}"


async def _upload_supabase(
    settings: Settings, data: bytes, path: str, content_type: str
) -> str | None:
    # Supabase Storage: POST /storage/v1/object/{bucket}/{path}; public bucket URL below.
    endpoint = (
        f"{settings.supabase_url}/storage/v1/object/"
        f"{settings.supabase_storage_bucket}/{path}"
    )
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "apikey": settings.supabase_service_key,
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(endpoint, content=data, headers=headers)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("Supabase storage upload failed: %s", exc)
        return None
    return f"{settings.supabase_url}/storage/v1/object/public/{settings.supabase_storage_bucket}/{path}"
