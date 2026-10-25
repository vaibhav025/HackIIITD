"""Competitor discovery from TinyFish Search results (no network)."""

from types import SimpleNamespace

from app.services.tinyfish.search_hits import (
    clean_title,
    interleave,
    listings_from_results,
    platform_of,
    snippet_price,
)


def hit(url: str, title: str, snippet: str = "") -> SimpleNamespace:
    return SimpleNamespace(url=url, title=title, snippet=snippet)


def test_platform_from_url():
    assert platform_of("https://www.zeptonow.com/pn/x/pvid/1") == "zepto"
    assert platform_of("https://www.swiggy.com/instamart/p/abc") == "instamart"
    assert platform_of("https://www.swiggy.com/restaurants/abc") is None
    assert platform_of("https://example.com/p/1") is None


def test_title_and_price_cleanup():
    assert clean_title("Buy Haldiram's Aloo Bhujia Online") == "Haldiram's Aloo Bhujia"
    assert clean_title("Haldiram's Aloo Bhujia Sev - Buy at ₹54 Online") == "Haldiram's Aloo Bhujia Sev"
    assert clean_title("Bikano Aloo Bhujia Price - Buy") == "Bikano Aloo Bhujia"
    assert clean_title("President Butter - Instamart") == "President Butter"
    assert snippet_price("Crunchy snack ; ₹54 ; MRP ₹55") == 54
    assert snippet_price("MRP ₹60 only") is None
    assert snippet_price("Buy for Rs.1 online") is None
    assert snippet_price("Order at Rs. 1,299.50 near me") == 1299.5


def test_keeps_product_pages_only():
    results = [
        hit("https://www.amazon.in/Haldirams-Aloo-Bhujia/dp/B005OR9H62", "Haldiram's Aloo Bhujia, 200g", "₹56"),
        hit("https://www.amazon.in/aloo-bhujia/s?k=aloo+bhujia", "Aloo Bhujia"),  # search page
        hit("https://www.amazon.in/Combo/dp/B000000001", "Burfee 500g, Chiwda 200g, Bhujia 200g"),  # bundle
        hit("https://www.amazon.in/Haldirams-Aloo-Bhujia/dp/B005OR9H62?ref=x", "Haldiram's Aloo Bhujia, 200g"),  # dup
    ]
    hits = listings_from_results("amazon", results)
    assert [h.name for h in hits] == ["Haldiram's Aloo Bhujia, 200g"]
    assert hits[0].price == 56 and hits[0].url.endswith("/dp/B005OR9H62")


def test_accessories_dropped_unless_asked_for():
    results = [
        hit("https://www.zeptonow.com/pn/case/pvid/aa", "Silicone Case for AirPods Pro 2"),
        hit("https://www.zeptonow.com/pn/buds/pvid/bb", "CMF by Nothing Buds Pro 2"),
    ]
    assert [h.name for h in listings_from_results("zepto", results, "AirPods Pro 2")] == ["CMF by Nothing Buds Pro 2"]
    assert len(listings_from_results("zepto", results, "AirPods Pro 2 case")) == 2


def test_interleave_covers_every_platform_first():
    a = listings_from_results("zepto", [hit("https://www.zeptonow.com/pn/a/pvid/1", "A"), hit("https://www.zeptonow.com/pn/b/pvid/2", "B")])
    c = listings_from_results("blinkit", [hit("https://blinkit.com/prn/c/prid/3", "C")])
    assert [h.name for h in interleave([a, c])] == ["A", "C", "B"]
