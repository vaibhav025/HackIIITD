"""Pack-size and model matching, so a price is only reported for the exact item asked for.

Agents and product searches often land on a neighbouring pack (200 ml or 1 L
when 500 ml was asked for). Comparing the pack size in the query with the pack
size in the matched product name catches that.
"""

from __future__ import annotations

import re

_SIZE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(ml|millilitre|milliliter|l|ltr|litre|liter|g|gm|gms|gram|grams|kg|kgs)\b",
    re.IGNORECASE,
)
_MULTI_RE = re.compile(r"(?:\b(?:x|×)\s*(\d+)\b|\bpack\s+of\s+(\d+)\b|\b(\d+)\s*(?:x|×)\s*\d)", re.IGNORECASE)
_UNITS = {
    "ml": ("ml", 1), "millilitre": ("ml", 1), "milliliter": ("ml", 1),
    "l": ("ml", 1000), "ltr": ("ml", 1000), "litre": ("ml", 1000), "liter": ("ml", 1000),
    "g": ("g", 1), "gm": ("g", 1), "gms": ("g", 1), "gram": ("g", 1), "grams": ("g", 1),
    "kg": ("g", 1000), "kgs": ("g", 1000),
}


def pack_size(text: str | None) -> tuple[str, float, int] | None:
    """(unit, amount, count) e.g. "500 ml" -> ("ml", 500, 1), "2 x 200 ml" -> ("ml", 200, 2)."""
    if not text:
        return None
    match = _SIZE_RE.search(text)
    if match is None:
        return None
    unit, factor = _UNITS[match.group(2).lower()]
    count = 1
    multi = _MULTI_RE.search(text)
    if multi:
        count = int(next(group for group in multi.groups() if group))
    return unit, round(float(match.group(1)) * factor, 3), max(count, 1)


def same_pack(query: str, product_name: str | None) -> bool | None:
    """True/False when both sides name a pack size; None when either is unknown."""
    wanted, found = pack_size(query), pack_size(product_name)
    if wanted is None or found is None:
        return None
    return wanted == found


def pack_label(text: str | None) -> str | None:
    size = pack_size(text)
    if size is None:
        return None
    unit, amount, count = size
    if unit == "ml" and amount >= 1000:
        label = f"{amount / 1000:g} L"
    elif unit == "g" and amount >= 1000:
        label = f"{amount / 1000:g} kg"
    else:
        label = f"{amount:g} {unit}"
    return f"{count} × {label}" if count > 1 else label


_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def model_numbers(text: str | None) -> set[str]:
    """Numbers that identify a model or pack: "JBL Go 3" -> {"3"}, "3i 20000mAh" -> {"3", "20000"}."""
    # Pack sizes are compared by same_pack (so "500 ml" equals "0.5 L"); skip them here.
    return set(_NUMBER_RE.findall(_SIZE_RE.sub(" ", text or "")))


_ACCESSORY_RE = re.compile(
    r"\b(pouch|cover|skin|sleeve|protector|screen guard|tempered glass|sticker|decal|strap|holder|mount)\b",
    re.IGNORECASE,
)


def same_variant(query: str, product_name: str | None) -> bool | None:
    """False when the pack size differs or a model number from the query is missing.

    True when everything that can be compared matches, None when the matched
    name is unknown. Covers groceries (500 ml vs 1 L) and gadgets (Go 3 vs Go 4).
    """
    if not product_name:
        return None
    if same_pack(query, product_name) is False:
        return False
    # "Pouch for Mi Power Bank 3i" mentions the model but is an accessory.
    accessory = _ACCESSORY_RE.search(product_name)
    if accessory and not re.search(re.escape(accessory.group(1)), query, re.IGNORECASE):
        return False
    return model_numbers(query) <= model_numbers(product_name)
