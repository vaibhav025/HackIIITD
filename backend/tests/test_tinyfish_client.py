"""Live TinyFish client: card parsing, error mapping, check_pincode (offline)."""

from __future__ import annotations

import httpx
import pytest
from tinyfish import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    InternalServerError,
    RateLimitError,
)

from app.config import Settings
from app.services.tinyfish import MockTinyFishClient, TinyFishError
from app.services.tinyfish.tinyfish_client import (
    TinyFishLiveClient,
    check_pincode,
    map_sdk_error,
    parse_card,
    pick_card,
)

QUERY = "Amul Taaza Toned Milk 500 ml"


def _response(status: int, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status, headers=headers, request=httpx.Request("POST", "https://example.test")
    )


def test_parse_card_reads_price_mrp_stock_and_eta() -> None:
    card = "8 MINS\nAmul Taaza Toned Fresh Milk\n500 ml\n₹27\n₹29\nADD"
    parsed = parse_card(card)
    assert parsed.name == "Amul Taaza Toned Fresh Milk"
    assert parsed.price == 27.0
    assert parsed.mrp == 29.0
    assert parsed.in_stock is True
    assert parsed.eta_minutes == 8


def test_parse_card_ignores_discount_amounts_and_detects_out_of_stock() -> None:
    card = "₹5 OFF\nAmul Taaza Milk\n₹1,024.50 ₹1,099\nOut of Stock"
    parsed = parse_card(card)
    assert parsed.price == 1024.5
    assert parsed.mrp == 1099.0
    assert parsed.in_stock is False
    assert parsed.name == "Amul Taaza Milk"


def test_pick_card_prefers_best_match_and_rejects_unrelated() -> None:
    cards = ["Mother Dairy Toned Milk 500 ml ₹28 ADD", "Amul Taaza Toned Milk 500 ml ₹27 ADD"]
    picked = pick_card(cards, QUERY)
    assert picked is not None and picked[0].startswith("Amul")
    assert pick_card(["Tata Salt 1 kg ₹28 ADD"], QUERY) is None
    assert pick_card([], QUERY) is None


def test_map_sdk_error_classifies_auth_credits_rate_limits_and_outages() -> None:
    auth = map_sdk_error(AuthenticationError("bad key", response=_response(401)))
    assert not auth.retryable and "TINYFISH_API_KEY" in str(auth)

    wallet = map_sdk_error(
        APIStatusError("empty", response=_response(402), status_code=402)
    )
    assert not wallet.retryable and "credits" in str(wallet)

    limited = map_sdk_error(
        RateLimitError("slow down", response=_response(429, {"Retry-After": "5"}))
    )
    assert limited.retryable

    assert map_sdk_error(InternalServerError("boom", response=_response(503))).retryable
    assert map_sdk_error(APIConnectionError("offline")).retryable


@pytest.mark.asyncio
async def test_live_client_refuses_unsupported_apps_without_calling_tinyfish() -> None:
    client = TinyFishLiveClient(Settings(tinyfish_api_key="test-key", mock_mode=False))
    with pytest.raises(TinyFishError) as caught:
        await client.check("amazon", "110017", QUERY)
    assert not caught.value.retryable


def test_live_client_requires_a_key() -> None:
    with pytest.raises(TinyFishError):
        TinyFishLiveClient(Settings(tinyfish_api_key="", mock_mode=False))


@pytest.mark.asyncio
async def test_check_pincode_returns_validated_json_with_saved_screenshot() -> None:
    result = await check_pincode(
        "blinkit", "110017", QUERY, client=MockTinyFishClient(delay=(0, 0))
    )
    assert set(result) >= {"app", "pincode", "in_stock", "price", "eta", "screenshot_url"}
    assert result["app"] == "blinkit"
    assert result["pincode"] == "110017"
    assert result["mode"] == "simulated"
    assert result["screenshot_url"].startswith("/media/screenshots/adhoc/")


@pytest.mark.asyncio
async def test_check_pincode_rejects_bad_input() -> None:
    client = MockTinyFishClient(delay=(0, 0))
    with pytest.raises(ValueError):
        await check_pincode("myntra", "110017", QUERY, client=client)
    with pytest.raises(ValueError):
        await check_pincode("blinkit", "1100", QUERY, client=client)


@pytest.mark.asyncio
async def test_live_runs_over_the_job_limit_are_refused(monkeypatch) -> None:
    from fastapi import HTTPException
    from sqlalchemy import select

    from app.config import get_settings
    from app.db import SessionLocal
    from app.models.product import Product, ProductPincode
    from app.services.runner import create_run

    settings = get_settings()
    monkeypatch.setattr(settings, "tinyfish_api_key", "test-key")
    monkeypatch.setattr(settings, "mock_mode", False)
    monkeypatch.setattr(settings, "tinyfish_live_max_jobs_per_run", 1)
    async with SessionLocal() as session:
        product = (await session.scalars(select(Product).where(Product.paused.is_(False)))).first()
        pairs = (
            await session.scalars(
                select(ProductPincode).where(ProductPincode.product_id == product.id)
            )
        ).all()
        with pytest.raises(HTTPException) as caught:
            await create_run(
                session,
                product,
                trigger="manual",
                platforms=sorted({pair.platform for pair in pairs}),
                pincodes=sorted({pair.pincode for pair in pairs}),
            )
    assert caught.value.detail["code"] == "live_job_limit"


def test_agent_goal_is_read_only_and_names_the_pincode() -> None:
    from app.services.tinyfish.tinyfish_client import AgentCheckOutput, build_agent_goal

    goal = build_agent_goal("zepto", "110017", QUERY, None)
    assert "110017" in goal and QUERY in goal
    for rule in ("Never click ADD", "Never log in", "checkout", "blocked=true"):
        assert rule in goal
    parsed = AgentCheckOutput.model_validate(
        {"location_set": True, "product_name": "Amul", "in_stock": True, "price": 40,
         "mrp": None, "eta_minutes": 13, "blocked": False, "notes": None}
    )
    assert parsed.price == 40.0 and parsed.eta_minutes == 13


@pytest.mark.asyncio
async def test_failed_live_check_falls_back_to_cached_result(tmp_path, monkeypatch) -> None:
    import json

    from app.services.tinyfish import demo_cache

    cache = tmp_path / "demo_results.json"
    cache.write_text(json.dumps([{
        "platform": "zepto", "pincode": "110017", "query": QUERY, "product": "Amul Taaza",
        "in_stock": True, "price": 77.0, "mrp": None, "eta_minutes": 21,
        "screenshot": None, "run_id": "r1", "checked_at": "2026-10-18T14:00:00",
    }]))
    monkeypatch.setattr(demo_cache, "CACHE_PATH", cache)
    demo_cache.load_cache.cache_clear()
    monkeypatch.setattr(demo_cache, "load_cache", lambda path=cache: tuple(json.loads(cache.read_text(encoding="utf-8"))))

    class Blocked:
        mode = "live"

        async def check(self, *args, **kwargs):
            raise TinyFishError("blocked", retryable=False, credits_used=1)

    fallback = demo_cache.CachedFallbackClient(Blocked(), demo=False)
    result = await fallback.check("zepto", "110017", QUERY)
    assert result.price == 77.0 and result.raw["source"] == "demo_cache"
    with pytest.raises(TinyFishError):  # nothing cached for this pincode
        await fallback.check("zepto", "110001", QUERY)
    demo = demo_cache.CachedFallbackClient(Blocked(), demo=True)
    assert (await demo.check("zepto", "110017", QUERY)).raw["reason"] == "demo mode"


FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures"


def test_amazon_parser_reads_real_fetch_output() -> None:
    from app.services.tinyfish.marketplace import parse_amazon

    page = parse_amazon(
        (FIXTURES / "amazon_bhujia.txt").read_text(encoding="utf-8"),
        "Haldiram's Delhi Bhujia, 200g : Amazon.in: Grocery & Gourmet Foods",
    )
    assert page.name == "Haldiram's Delhi Bhujia, 200g"
    assert page.price == 56.0 and page.in_stock is True
    assert page.mrp is None  # the ₹290 MRP on the page belongs to a 1 kg pack below
    assert page.delivery_fee == 60.0 and page.delivery_date is not None
    assert page.delivery_date.day == 20 and page.delivery_date.month == 11

    gone = parse_amazon((FIXTURES / "amazon_unavailable.txt").read_text(encoding="utf-8"), "Amul Taaza Pouch")
    assert gone.in_stock is False and gone.price is None


def test_flipkart_parser_reads_real_fetch_output() -> None:
    from app.services.tinyfish.marketplace import parse_flipkart

    page = parse_flipkart((FIXTURES / "flipkart_bhujia.txt").read_text(encoding="utf-8"), "{TITLE} Price in India")
    assert page.name == "Haldiram's Plain Bhujia Sev (200 g)"
    assert page.price == 53.0 and page.mrp == 58.0
    assert page.in_stock is False  # the page's button said "Notify Me"



@pytest.mark.asyncio
async def test_app_status_endpoint_lists_every_app() -> None:
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://t") as client:
        res = await client.get("/api/tinyfish/apps")
    assert res.status_code == 200
    apps = {row["platform"]: row for row in res.json()}
    assert set(apps) == {"blinkit", "zepto", "instamart", "amazon", "flipkart"}
    assert all(row["status"] in ("live", "cached", "unavailable", "simulated") for row in apps.values())


def test_pack_size_matching_rejects_other_packs() -> None:
    from app.services.tinyfish.pack import pack_label, same_pack
    from app.services.tinyfish.tinyfish_client import not_listed_note

    assert same_pack(QUERY, "Amul Taaza Pouch, 500 ml") is True
    assert same_pack(QUERY, "Amul Taaza Toned Milk 0.5 L") is True
    assert same_pack(QUERY, "Amul Taaza Homogenised Toned Milk (Tetra Pack) 200 ml") is False
    assert same_pack(QUERY, "Amul Taaza Toned Milk 1 ltr") is False
    assert same_pack(QUERY, "Amul Taaza 200ml x 2") is False
    assert same_pack(QUERY, "Amul Taaza Toned Milk") is None  # name has no size: can't tell
    assert pack_label("Haldiram's Bhujia 1Kg") == "1 kg"
    note = not_listed_note(QUERY, "Amul Taaza Toned Milk 1 ltr", 77.0)
    assert note.startswith("500 ml not listed") and "₹77" in note


@pytest.mark.asyncio
async def test_default_seed_adds_no_simulated_products() -> None:
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models.product import Product
    from scripts.seed import seed

    async with SessionLocal() as session:
        before = await session.scalar(select(func.count(Product.id)))
    await seed()  # real deployments: pincodes and account only
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count(Product.id))) == before


def test_amazon_offer_without_stock_text_counts_as_in_stock() -> None:
    from app.services.tinyfish.marketplace import parse_amazon

    text = "##### One-time purchase ₹56.00 ₹28.00 per g ₹60 delivery Friday, 20 November Ships from: X"
    page = parse_amazon(text, "Haldiram's Delhi Bhujia, 200g : Amazon.in")
    assert page.price == 56.0 and page.in_stock is True


def test_exact_model_matching_for_gadgets() -> None:
    from app.services.tinyfish.pack import same_variant

    assert same_variant("JBL Go 3 Bluetooth Speaker", "JBL Go 3 Wireless Portable Speaker") is True
    assert same_variant("JBL Go 3 Bluetooth Speaker", "JBL Go 4 Ultra Portable Speaker") is False
    assert same_variant("Xiaomi Power Bank 3i 20000mAh", "Xiaomi Power Bank 4i 20000mAh 33W") is False
    assert same_variant("Xiaomi Power Bank 3i 20000mAh", "Mi Power Bank 3i 20000mAh 18W") is True
    assert same_variant(QUERY, "Amul Taaza Toned Milk 0.5 L") is True
    assert same_variant(QUERY, "Amul Taaza Toned Milk 1 ltr") is False
    assert same_variant("boAt Airdopes 141", None) is None


def test_gadget_pages_read_the_real_price_not_add_ons_or_ads() -> None:
    from app.services.tinyfish.marketplace import parse_amazon, parse_flipkart
    from app.services.tinyfish.pack import same_variant

    amazon = parse_amazon((FIXTURES / "amazon_jbl_go3.txt").read_text(encoding="utf-8"), "JBL Go 3 Wireless Portable Bluetooth Mini Speaker : Amazon.in")
    assert amazon.price == 2849.05 and amazon.mrp == 3999.0 and amazon.in_stock is True  # not the ₹149 warranty plan
    airpods = parse_amazon((FIXTURES / "amazon_airpods_unavailable.txt").read_text(encoding="utf-8"), "Apple AirPods Pro 2")
    assert airpods.in_stock is False and airpods.price is None
    flipkart = parse_flipkart((FIXTURES / "flipkart_jbl_go3.txt").read_text(encoding="utf-8"), "Buy JBL GO 3 with IP67 Water and Dust Resistant 4.2 W Bluetooth Speaker")
    assert flipkart.price == 2999.0 and flipkart.mrp == 3999.0  # not the ₹1,799 sponsored boAt ad
    assert same_variant("Xiaomi Power Bank 3i 20000mAh", "Gizmofreaks Pouch for Mi Power Bank 3i 20000mAh") is False


def test_flipkart_gadget_price_after_selected_variant_and_model_from_url() -> None:
    from app.services.tinyfish.marketplace import parse_flipkart
    from app.services.tinyfish.pack import same_variant
    from app.services.tinyfish.tinyfish_client import url_slug_words

    mi = parse_flipkart((FIXTURES / "flipkart_mi_3i.txt").read_text(encoding="utf-8"), "Mi 20000 mAh 18 W Power Bank Price in India")
    assert mi.price == 3499.0 and mi.in_stock is True  # not an ad, not the ₹3,324 after-offer price
    boat = parse_flipkart((FIXTURES / "flipkart_boat_141.txt").read_text(encoding="utf-8"), "boAt Airdopes 141 Gen 2")
    assert boat.price == 799.0 and boat.mrp == 3990.0 and boat.in_stock is False  # "Notify Me"
    slug = url_slug_words("https://www.flipkart.com/mi-3i-20000-mah-power-bank-fast-charging-18w/p/itmd42cbbe08e65e")
    assert same_variant("Xiaomi Power Bank 3i 20000mAh", f"Mi 20000 mAh 18 W Power Bank {slug}") is True
    assert same_variant("Xiaomi Power Bank 3i 20000mAh", "Mi 20000 mAh 18 W Power Bank") is False
