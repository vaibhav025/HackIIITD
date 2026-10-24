"""Locally stored screenshot files: safe path resolution, URLs, and cleanup.

The storage service writes local evidence under ``media/screenshots/<product_id>/``
and records ``/media/screenshots/...`` URLs. Development serves that directory
statically; production only through the owner-checked screenshot endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from collections.abc import Iterable
from pathlib import Path

from ..services.storage import screenshot_url_for

__all__ = ["local_media_path", "remove_product_media", "screenshot_url_for"]

logger = logging.getLogger("shelfsense.media")

MEDIA_ROOT = Path("media")
SCREENSHOT_DIR = MEDIA_ROOT / "screenshots"
MEDIA_URL_PREFIX = "/media/"


def local_media_path(url: str | None) -> Path | None:
    """Resolve a `/media/...` URL to a file strictly inside the media root."""
    if not url or not url.startswith(MEDIA_URL_PREFIX):
        return None
    root = MEDIA_ROOT.resolve()
    candidate = (root / url.removeprefix(MEDIA_URL_PREFIX)).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        return None
    return candidate


def _remove_dirs(product_ids: list[str]) -> None:
    root = SCREENSHOT_DIR.resolve()
    for product_id in product_ids:
        target = (root / product_id).resolve()
        if target.parent != root:
            logger.warning("refusing to remove media outside %s: %s", root, target)
            continue
        shutil.rmtree(target, ignore_errors=True)


async def remove_product_media(product_ids: Iterable[str]) -> None:
    """Delete the local screenshot folders of deleted products."""
    await asyncio.to_thread(_remove_dirs, list(product_ids))
