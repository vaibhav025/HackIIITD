"""Remove simulated data so only real TinyFish results remain.

Run from backend/ (back up the database first):

    python -m scripts.clean_simulated_data          # dry run: show what would change
    python -m scripts.clean_simulated_data --apply  # make the changes

- Deletes products whose check results are all simulated (the seeded demo
  products), with their runs, results, alerts and recommendations.
- Deletes simulated results left on products that also have real results.
- Re-labels older real agent results that reported a different pack size
  (e.g. 200 ml or 1 L when 500 ml was asked for) as "exact pack not listed".
"""

from __future__ import annotations

import asyncio
import re
import sys

from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models.checks import ChangeEvent, CheckResult, CheckRun
from app.models.product import Product
from app.services.tinyfish.tinyfish_client import not_listed_note

REAL_SOURCES = ("tinyfish_agent_api", "tinyfish_fetch_api", "tinyfish_browser_api", "demo_cache")
NO_EXACT_RE = re.compile(r"no exact|not (?:found|listed|available) in|closest (?:match|available)", re.IGNORECASE)
SOLD_OUT_RE = re.compile(r"\b\d+\s*(?:ml|g|l)\b[^.]*\bsold out\b", re.IGNORECASE)


def is_real(row: CheckResult) -> bool:
    return (row.raw or {}).get("source") in REAL_SOURCES


async def clean(apply: bool) -> None:
    async with SessionLocal() as session:
        products = (await session.scalars(select(Product))).all()
        for product in products:
            rows = (
                await session.scalars(select(CheckResult).where(CheckResult.product_id == product.id))
            ).all()
            if not rows:
                continue
            real = [r for r in rows if is_real(r)]
            if not real:
                print(f"DELETE product (all {len(rows)} results simulated): {product.name}")
                if apply:
                    await session.delete(product)
                continue
            fake = [r for r in rows if not is_real(r)]
            if fake:
                print(f"DELETE {len(fake)} simulated results from: {product.name}")
                if apply:
                    for row in fake:
                        await session.delete(row)
            for row in real:
                raw = dict(row.raw or {})
                notes = raw.get("notes")
                text = notes if isinstance(notes, str) else " ".join(notes or [])
                if raw.get("source") != "tinyfish_agent_api" or "exact_match" in raw or not text:
                    continue
                if SOLD_OUT_RE.search(text):
                    print(f"FIX {product.name} {row.platform} {row.pincode}: ₹{row.price} -> exact pack sold out")
                    raw.update(exact_match=True, closest_price=row.price, notes=["Exact pack is sold out here.", text])
                    if apply:
                        row.price, row.mrp, row.in_stock, row.raw = None, None, False, raw
                elif NO_EXACT_RE.search(text):
                    print(f"FIX {product.name} {row.platform} {row.pincode}: ₹{row.price} -> exact pack not listed")
                    raw.update(
                        exact_match=False,
                        closest_price=row.price,
                        notes=[not_listed_note(product.search_query, None, row.price), text],
                    )
                    if apply:
                        row.price, row.mrp, row.in_stock, row.raw = None, None, False, raw
        if apply:
            await session.flush()
            # Runs left without any result, and change events from simulated data.
            empty_runs = (
                await session.scalars(
                    select(CheckRun.id).where(~CheckRun.id.in_(select(CheckResult.run_id).distinct()))
                )
            ).all()
            if empty_runs:
                await session.execute(delete(CheckRun).where(CheckRun.id.in_(empty_runs)))
            await session.execute(delete(ChangeEvent))
            await session.commit()
            print(f"Applied. Removed {len(empty_runs)} empty runs and all old change events.")
        else:
            print("\nDry run only. Re-run with --apply to make these changes.")


if __name__ == "__main__":
    asyncio.run(clean("--apply" in sys.argv))
