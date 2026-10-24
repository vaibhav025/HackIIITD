"""SVG "browser screenshot" evidence for simulated TinyFish sessions.

The image mimics what a real agent capture shows: browser chrome with the
platform URL, the platform-coloured header with the delivery pincode, and the
product card the agent read. Every attribute and text node goes through
``_el``, which XML-escapes it (and strips characters XML cannot carry),
because product names come from user input.
"""

from __future__ import annotations

import re
import textwrap
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote_plus
from xml.sax.saxutils import escape

from .agent import format_rupees
from .base import TruePrice
from .goals import site_domain

WIDTH = 640
HEIGHT = 400
TITLE_LINE_CHARS = 34
URL_CHARS = 78
FONT = "Inter, 'Segoe UI', Roboto, Arial, sans-serif"
_XML_INVALID = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


@dataclass(frozen=True)
class Theme:
    name: str
    header: str
    logo: str
    accent: str


THEMES: dict[str, Theme] = {
    "blinkit": Theme("blinkit", "#F8CB46", "#0C831F", "#0C831F"),
    "zepto": Theme("zepto", "#3C006B", "#FFFFFF", "#FF3269"),
    "instamart": Theme("Instamart", "#FC8019", "#FFFFFF", "#FC8019"),
    "amazon": Theme("amazon.in", "#131921", "#FFFFFF", "#FF9900"),
    "flipkart": Theme("Flipkart", "#2874F0", "#FFFFFF", "#2874F0"),
}
DEFAULT_THEME = Theme("store", "#5F6368", "#FFFFFF", "#5F6368")


def esc(value: object) -> str:
    text = _XML_INVALID.sub("", str(value))
    return escape(text, {'"': "&quot;", "'": "&apos;"})


def _el(tag: str, text: str | None = None, **attrs: object) -> str:
    """One SVG element; ``font_size`` style keywords become ``font-size``."""
    rendered = "".join(
        f' {name.replace("_", "-")}="{esc(value)}"' for name, value in attrs.items()
    )
    if text is None:
        return f"<{tag}{rendered}/>"
    return f"<{tag}{rendered}>{esc(text)}</{tag}>"


def wrap_title(title: str, width: int = TITLE_LINE_CHARS, lines: int = 2) -> list[str]:
    wrapped = textwrap.wrap(title, width) or [""]
    if len(wrapped) > lines:
        wrapped = wrapped[:lines]
        wrapped[-1] = wrapped[-1][: width - 1].rstrip() + "…"
    return wrapped


def _eta_text(eta_minutes: int | None) -> str:
    if eta_minutes is None:
        return "Delivery time unavailable"
    if eta_minutes < 120:
        return f"{eta_minutes} min delivery"
    days = max(round(eta_minutes / 1440), 1)
    return f"Delivery in {days} day{'s' if days > 1 else ''}"


def _stock_badge(in_stock: bool | None) -> tuple[str, str, str]:
    if in_stock is False:
        return "#FCE8E6", "#C5221F", "Out of stock"
    if in_stock is True:
        return "#E6F4EA", "#137333", "In stock"
    return "#F1F3F4", "#5F6368", "Stock unknown"


def render_product_screenshot(
    *,
    platform: str,
    pincode: str,
    query: str,
    title: str,
    price: float | None,
    mrp: float | None,
    in_stock: bool | None,
    eta_minutes: int | None,
    true_price: TruePrice | None,
    session_id: str,
    captured_at: datetime,
) -> bytes:
    theme = THEMES.get(platform, DEFAULT_THEME)
    url = f"https://{site_domain(platform)}/s/?q={quote_plus(query)}"
    if len(url) > URL_CHARS:
        url = url[: URL_CHARS - 1] + "…"
    centre = WIDTH / 2
    parts = [
        _el("title", f"{theme.name} · {pincode} · {title}"),
        # Browser chrome.
        _el("rect", width=WIDTH, height=HEIGHT, fill="#F7F7F8"),
        _el("rect", width=WIDTH, height=36, fill="#E8EAED"),
        _el("circle", cx=16, cy=18, r=5, fill="#FF5F57"),
        _el("circle", cx=32, cy=18, r=5, fill="#FEBC2E"),
        _el("circle", cx=48, cy=18, r=5, fill="#28C840"),
        _el("rect", x=70, y=8, width=548, height=20, rx=10, fill="#FFFFFF"),
        _el("text", url, x=84, y=22, font_size=11, fill="#3C4043"),
        # Platform header with the delivery location chip.
        _el("rect", y=36, width=WIDTH, height=48, fill=theme.header),
        _el(
            "text", theme.name, x=20, y=68, font_size=22, font_weight=800,
            fill=theme.logo,
        ),
        _el(
            "rect", x=410, y=48, width=210, height=24, rx=12, fill="#FFFFFF",
            fill_opacity=0.9,
        ),
        _el(
            "text", f"Delivering to {pincode}", x=515, y=64, font_size=12,
            font_weight=600, fill="#202124", text_anchor="middle",
        ),
        # Product card with a packshot placeholder.
        _el(
            "rect", x=20, y=100, width=600, height=256, rx=12, fill="#FFFFFF",
            stroke="#E3E3E6",
        ),
        _el("rect", x=40, y=120, width=150, height=150, rx=10, fill="#EEF0F3"),
        _el(
            "rect", x=85, y=140, width=60, height=110, rx=12, fill=theme.accent,
            fill_opacity=0.18,
        ),
        _el(
            "rect", x=97, y=160, width=36, height=36, rx=6, fill=theme.accent,
            fill_opacity=0.45,
        ),
    ]
    for index, line in enumerate(wrap_title(title)):
        parts.append(
            _el(
                "text", line, x=215, y=142 + index * 22, font_size=18,
                font_weight=700, fill="#1F1F1F",
            )
        )
    if price is not None:
        price_text = format_rupees(price)
        parts.append(
            _el(
                "text", price_text, x=215, y=215, font_size=28, font_weight=800,
                fill="#1F1F1F",
            )
        )
        offset = 215 + len(price_text) * 17 + 12
        if mrp is not None and mrp > price:
            mrp_text = f"MRP {format_rupees(mrp)}"
            parts.append(
                _el(
                    "text", mrp_text, x=offset, y=213, font_size=13, fill="#80868B",
                    text_decoration="line-through",
                )
            )
            discount = round((1 - price / mrp) * 100)
            if discount > 0:
                parts.append(
                    _el(
                        "text", f"{discount}% OFF", x=offset + len(mrp_text) * 7 + 10,
                        y=213, font_size=13, font_weight=700, fill="#137333",
                    )
                )
    else:
        parts.append(
            _el("text", "Price not shown", x=215, y=215, font_size=16, fill="#80868B")
        )
    badge_fill, badge_ink, badge_label = _stock_badge(in_stock)
    parts.extend(
        [
            _el("rect", x=215, y=232, width=104, height=24, rx=12, fill=badge_fill),
            _el(
                "text", badge_label, x=267, y=248, font_size=12, font_weight=700,
                fill=badge_ink, text_anchor="middle",
            ),
            _el(
                "text", _eta_text(eta_minutes), x=333, y=248, font_size=12,
                fill="#5F6368",
            ),
        ]
    )
    if true_price is not None:
        breakdown = (
            f"Item {format_rupees(true_price['item'])} + handling "
            f"{format_rupees(true_price['handling_fee'])} + delivery "
            f"{format_rupees(true_price['delivery_fee'])} − offer "
            f"{format_rupees(true_price['offer'])}"
        )
        parts.extend(
            [
                _el(
                    "rect", x=215, y=272, width=385, height=64, rx=10, fill="#FFF8E1",
                    stroke="#F9E2A0",
                ),
                _el(
                    "text",
                    f"True price at checkout: {format_rupees(true_price['final'])}",
                    x=231, y=296, font_size=13, font_weight=700, fill="#5F4B00",
                ),
                _el("text", breakdown, x=231, y=318, font_size=11, fill="#6B5B1E"),
            ]
        )
    else:
        parts.append(
            _el(
                "text", f"Search: “{query}”", x=215, y=300, font_size=12,
                fill="#80868B",
            )
        )
    stamp = captured_at.strftime("%Y-%m-%d %H:%M UTC")
    parts.extend(
        [
            _el(
                "text", "SIMULATED", x=centre, y=250, font_size=64, font_weight=800,
                fill="#202124", fill_opacity=0.05, text_anchor="middle",
                transform=f"rotate(-18 {centre} 230)",
            ),
            _el("rect", y=372, width=WIDTH, height=28, fill="#202124"),
            _el(
                "text", f"TinyFish agent · {session_id} · {stamp}", x=16, y=390,
                font_size=10, fill="#BDC1C6",
            ),
            _el(
                "text", "SIMULATED · ShelfSense", x=WIDTH - 16, y=390, font_size=11,
                font_weight=700, fill="#FDD663", text_anchor="end",
            ),
        ]
    )
    opening = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}" font-family="{esc(FONT)}">'
    )
    return (opening + "".join(parts) + "</svg>").encode("utf-8")
