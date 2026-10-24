"""Idempotently seed the local ShelfSense demo workspace.

Run from backend/: ``python -m scripts.seed`` after ``alembic upgrade head``.
Add ``--with-demo-data`` for simulated products and history (tests use it).
Every entity is checked on its own, so re-running fills in whatever is missing
(for example after the demo account was removed) and never duplicates rows.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.deps import DEMO_EMAIL
from app.models.base import utcnow
from app.models.checks import ChangeEvent, CheckResult, CheckRun
from app.models.intelligence import AISummary, Alert, Recommendation, ReviewInsight
from app.models.product import Competitor, Pincode, Product, ProductPincode
from app.models.user import Subscription, User, UserSettings

DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "pincodes_delhi.csv"
SEED_CODES = [
    "110003",
    "110014",
    "110016",
    "110017",
    "110019",
    "110021",
    "110023",
    "110024",
    "110025",
    "110029",
    "110030",
    "110048",
    "110049",
    "110057",
    "110065",
]
SEED_PLATFORMS = ("blinkit", "zepto")
PRODUCTS = [
    ("Amul Taaza Toned Milk 500 ml", "Amul", 26.0, 30.0),
    ("Haldiram Bhujia 200 g", "Haldiram", 47.0, 55.0),
    ("Paper Boat Aamras 250 ml", "Paper Boat", 31.0, 40.0),
]


def deterministic_result(
    product: Product, pincode: str, platform: str, competitor_offset: float, sample: int
) -> tuple[bool, float, float, int, float]:
    """Deterministic, plausible history without using a real external service."""
    key = f"{product.id}:{pincode}:{platform}:{competitor_offset}:{sample}".encode()
    value = int(hashlib.sha256(key).hexdigest()[:12], 16)
    base = (product.floor_price or 30.0) + 4.5
    price = round(base + ((value % 1400) / 100) - 7 + competitor_offset, 2)
    # Seed a visible South Delhi Blinkit availability cluster for Amul.
    cluster = (
        product.name.startswith("Amul")
        and platform == "blinkit"
        and pincode in {"110017", "110019", "110048", "110049"}
    )
    in_stock = not cluster and value % 100 >= 15
    return (
        in_stock,
        max(1.0, price),
        round(price + 5 + (value % 6), 2),
        8 + value % 24,
        round(3.8 + (value % 12) / 10, 1),
    )


async def seed_pincodes(session: AsyncSession) -> int:
    """Insert or refresh every catalogue pincode; returns how many were new."""
    with DATA_PATH.open(newline="", encoding="utf-8") as csv_file:
        rows = list(csv.DictReader(csv_file))
    existing = set((await session.scalars(select(Pincode.code))).all())
    for row in rows:
        await session.merge(
            Pincode(
                code=row["code"],
                area_name=row["area_name"],
                city=row["city"],
                lat=float(row["lat"]),
                lng=float(row["lng"]),
            )
        )
    await session.flush()
    return sum(row["code"] not in existing for row in rows)


async def ensure_demo_user(session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.email == DEMO_EMAIL))
    if user is None:
        user = User(
            name="Riya Sharma",
            email=DEMO_EMAIL,
            business_name="Riya Store",
            business_type="marketplace_seller",
            default_city="Delhi",
        )
        session.add(user)
        await session.flush()
    subscription = await session.scalar(
        select(Subscription.id).where(Subscription.user_id == user.id)
    )
    if subscription is None:
        session.add(Subscription(user_id=user.id, plan="pro", status="active"))
    if await session.get(UserSettings, user.id) is None:
        session.add(UserSettings(user_id=user.id, briefing_time="09:00"))
    await session.flush()
    return user


async def seed_product_history(session: AsyncSession, product: Product) -> None:
    """Competitors, pincode selection, 14 days of results, and AI artefacts."""
    now = utcnow()
    competitors = [
        Competitor(
            product_id=product.id,
            name=f"{product.brand} Value Pack",
            platform="blinkit",
            search_query=product.search_query,
            confirmed=True,
        ),
        Competitor(
            product_id=product.id,
            name=f"{product.brand} Market Choice",
            platform="zepto",
            search_query=product.search_query,
            confirmed=True,
        ),
    ]
    session.add_all(competitors)
    session.add_all(
        ProductPincode(product_id=product.id, pincode=code, platform=platform)
        for code in SEED_CODES
        for platform in SEED_PLATFORMS
    )
    await session.flush()

    for day_sample in range(28):
        checked_at = now - timedelta(hours=(27 - day_sample) * 12)
        run = CheckRun(
            product_id=product.id,
            trigger="scheduled",
            status="done",
            total_jobs=60,
            done_jobs=60,
            credits_used=60,
            started_at=checked_at,
            finished_at=checked_at + timedelta(minutes=2),
        )
        session.add(run)
        await session.flush()
        results: list[CheckResult] = []
        for platform in SEED_PLATFORMS:
            platform_competitor = next(
                item for item in competitors if item.platform == platform
            )
            for code in SEED_CODES:
                for competitor_id, offset in (
                    (None, 0.0),
                    (platform_competitor.id, -2.5),
                ):
                    stock, price, mrp, eta, rating = deterministic_result(
                        product, code, platform, offset, day_sample
                    )
                    results.append(
                        CheckResult(
                            run_id=run.id,
                            product_id=product.id,
                            competitor_id=competitor_id,
                            platform=platform,
                            pincode=code,
                            in_stock=stock,
                            price=price,
                            mrp=mrp,
                            eta_minutes=eta,
                            rating=rating,
                            status="ok",
                            raw={"seeded": True},
                            checked_at=checked_at,
                        )
                    )
        session.add_all(results)

    session.add_all(
        [
            AISummary(
                product_id=product.id,
                summary_text=(
                    f"{product.name} has stable Delhi coverage with watch points "
                    "in South Delhi."
                ),
                evidence={"seeded": True},
                source="fallback",
            ),
            Recommendation(
                product_id=product.id,
                priority="medium",
                action_text="Monitor competitor price changes before the next check.",
                impact_text="Protect margin while retaining local competitiveness.",
                evidence={"source": "seed"},
            ),
            ReviewInsight(
                product_id=product.id,
                competitor_id=None,
                loves=["Reliable quality", "Good value"],
                complaints=["Occasional availability gaps"],
            ),
        ]
    )
    await session.flush()


async def seed_products(session: AsyncSession, user: User) -> tuple[list[Product], int]:
    """Create each missing demo product with its history.

    Returns the demo products in `PRODUCTS` order and how many were created.
    """
    existing = {
        product.name: product
        for product in (
            await session.scalars(select(Product).where(Product.user_id == user.id))
        ).all()
    }
    created = 0
    for name, brand, cost, floor in PRODUCTS:
        if name in existing:
            continue
        product = Product(
            user_id=user.id,
            name=name,
            brand=brand,
            search_query=name,
            cost_price=cost,
            floor_price=floor,
            check_frequency="6h",
        )
        session.add(product)
        await session.flush()
        await seed_product_history(session, product)
        existing[name] = product
        created += 1
    return [existing[name] for name, *_ in PRODUCTS], created


async def seed_alerts(
    session: AsyncSession, user: User, products: list[Product]
) -> None:
    amul, bhujia, paper_boat = products
    known = set(
        (
            await session.scalars(
                select(Alert.dedupe_key).where(Alert.user_id == user.id)
            )
        ).all()
    )
    alerts = [
        Alert(
            user_id=user.id,
            product_id=amul.id,
            kind="oos_any",
            message="Amul Taaza is out of stock in Saket.",
            evidence={"pincode": "110017"},
            dedupe_key="seed:amul:110017",
        ),
        Alert(
            user_id=user.id,
            product_id=amul.id,
            kind="oos_any",
            message="Amul Taaza is out of stock in Greater Kailash.",
            evidence={"pincode": "110048"},
            dedupe_key="seed:amul:110048",
        ),
        Alert(
            user_id=user.id,
            product_id=bhujia.id,
            kind="price_change_pct",
            message="A rival price changed for Haldiram Bhujia.",
            evidence={},
            dedupe_key="seed:bhujia:price",
        ),
        Alert(
            user_id=user.id,
            product_id=paper_boat.id,
            kind="price_gap_pct",
            message="Paper Boat has a price gap on Zepto.",
            evidence={},
            dedupe_key="seed:paperboat:gap",
        ),
        Alert(
            user_id=user.id,
            product_id=paper_boat.id,
            kind="rating_below",
            message="A competitor rating needs attention.",
            evidence={},
            dedupe_key="seed:paperboat:rating",
        ),
    ]
    session.add_all(alert for alert in alerts if alert.dedupe_key not in known)
    if "seed:amul:110017" not in known:
        session.add_all(
            [
                ChangeEvent(
                    product_id=amul.id,
                    platform="blinkit",
                    pincode="110017",
                    kind="went_oos",
                    old_value=1.0,
                    new_value=0.0,
                ),
                ChangeEvent(
                    product_id=amul.id,
                    platform="blinkit",
                    pincode="110048",
                    kind="price_rise",
                    old_value=34.0,
                    new_value=36.0,
                ),
            ]
        )


async def seed(*, demo_data: bool = False) -> None:
    """Pincodes and the demo account; invented products/history only on request.

    ``demo_data=True`` adds the simulated products, price history and alerts
    used by the automated tests. Real deployments leave it off so every price
    on screen comes from a TinyFish check.
    """
    async with SessionLocal() as session:
        new_pincodes = await seed_pincodes(session)
        user = await ensure_demo_user(session)
        created = 0
        if demo_data:
            products, created = await seed_products(session, user)
            await seed_alerts(session, user, products)
        await session.commit()
        print(
            f"Seed complete: {new_pincodes} new pincodes, account {user.name}"
            + (f", {created} simulated demo products." if demo_data else ", no simulated data.")
        )


if __name__ == "__main__":
    import sys

    asyncio.run(seed(demo_data="--with-demo-data" in sys.argv))
