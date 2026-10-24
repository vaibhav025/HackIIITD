"""Save the latest successful LIVE TinyFish results as the demo cache.

Run from backend/ after a live run: ``python -m scripts.export_demo_cache``.
Writes data/demo_results.json and copies each result's evidence screenshot to
data/demo_screenshots/. Only genuine live agent results are exported.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models.checks import CheckResult
from app.models.product import Competitor, Product
from app.services.tinyfish.demo_cache import CACHE_PATH, SCREENSHOT_DIR

MEDIA_PREFIX = "/media/"


async def export() -> int:
    async with SessionLocal() as session:
        rows = (
            await session.scalars(
                select(CheckResult)
                .where(CheckResult.status == "ok")
                .order_by(CheckResult.checked_at.desc())
            )
        ).all()
        products = {p.id: p for p in (await session.scalars(select(Product))).all()}
        competitors = {c.id: c for c in (await session.scalars(select(Competitor))).all()}

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    entries: dict[tuple[str, str, str], dict] = {}
    for row in rows:
        if (row.raw or {}).get("source") not in ("tinyfish_agent_api", "tinyfish_fetch_api"):
            continue
        owner = competitors.get(row.competitor_id) if row.competitor_id else products.get(row.product_id)
        if owner is None:
            continue
        query = owner.search_query
        key = (row.platform, row.pincode, query.lower())
        if key in entries:
            continue  # rows are newest first
        screenshot = None
        if row.screenshot_url and row.screenshot_url.startswith(MEDIA_PREFIX):
            source = Path("media") / row.screenshot_url.removeprefix(MEDIA_PREFIX)
            if source.exists():
                screenshot = f"{row.platform}_{row.pincode}_{row.id[:8]}{source.suffix}"
                shutil.copyfile(source, SCREENSHOT_DIR / screenshot)
        entries[key] = {
            "platform": row.platform,
            "pincode": row.pincode,
            "query": query,
            "product": (row.raw or {}).get("product") or owner.name,
            "in_stock": row.in_stock,
            "price": row.price,
            "mrp": row.mrp,
            "eta_minutes": row.eta_minutes,
            "screenshot": screenshot,
            "run_id": (row.raw or {}).get("run_id"),
            "exact_match": (row.raw or {}).get("exact_match", True) is not False,
            "notes": (row.raw or {}).get("notes") if isinstance((row.raw or {}).get("notes"), list) else [],
            "checked_at": row.checked_at.isoformat(),
        }
    CACHE_PATH.write_text(json.dumps(list(entries.values()), indent=2), encoding="utf-8")
    return len(entries)


if __name__ == "__main__":
    count = asyncio.run(export())
    print(f"Saved {count} live results to {CACHE_PATH}")
