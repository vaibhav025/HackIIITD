"""Alert rule evaluation after runs, plus delivery to linked channels.

Rules live in ``alert_rules`` per product. The defaults below apply only while
a product has no rule rows at all, so disabling every rule really silences it.

Kinds:
  oos_any           seller out of stock at any selected pin
  oos_area          seller out of stock at pins in ``rule_json.pincodes`` or
                    whose area/city matches ``rule_json.areas``
  price_change_pct  a price change event above the threshold (last 24h)
  price_gap_pct     seller priced above the cheapest in-stock rival
  rating_below      seller rating under the threshold (``rating_drop`` alias)
  rival_oos         a rival out of stock — a chance to capture the shelf
  custom            keyword fallback: the rule text is parsed with the
                    deterministic plain-English parser and, when it maps to a
                    concrete kind, evaluated as that kind (alerts keep kind
                    "custom" and quote the rule); otherwise it never fires.

Every alert carries a dedupe_key. Condition alerts include the day, so a
persisting problem alerts at most once a day; price-change alerts are keyed
by their change event, so every new move alerts again. Delivery respects the
user's Telegram channel switch and defers alerts raised during quiet hours
until ``deliver_deferred_alerts`` runs after the quiet window.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal
from ..models.base import utcnow
from ..models.checks import ChangeEvent, CheckResult
from ..models.intelligence import Alert, AlertRule
from ..models.product import Pincode, Product
from ..models.telegram import TelegramLink
from ..models.user import User, UserSettings
from ..utils.geo import in_city_zone
from .ai.fallback import FallbackAIProvider
from .heatmap import selected_pairs
from .insights import _latest_rival_rows, _latest_seller_rows
from .price_thresholds import SENSITIVITY_THRESHOLDS, product_threshold_pct

logger = logging.getLogger("shelfsense.alerts")

ALERT_KINDS = (
    "oos_any",
    "oos_area",
    "price_change_pct",
    "rating_below",
    "rating_drop",
    "price_gap_pct",
    "rival_oos",
    "custom",
)
KIND_ALIASES = {"rating_drop": "rating_below"}
DEFAULT_RATING_THRESHOLD = 4.0
# Rules without their own threshold use the product's price-sensitivity
# threshold (essential 4%, regular 7%, premium 10%), the same bar the price
# recommendations use. Explicit user thresholds are never changed.
DEFAULT_GAP_THRESHOLD_PCT = SENSITIVITY_THRESHOLDS["regular"]


def default_gap_threshold(product: Product) -> float:
    return product_threshold_pct(product)

ALERT_MESSAGE_LIMIT = 2000
DEFERRED_ALERT_WINDOW = timedelta(hours=24)


def default_alert_rules(product: Product) -> list[dict]:
    return [
        {"kind": "oos_any", "threshold": None, "rule_text": "Any pin is out of stock"},
        {
            "kind": "price_change_pct",
            "threshold": product.max_change_pct,
            "rule_text": f"Price moved by more than {product.max_change_pct}%",
        },
        {
            "kind": "rating_below",
            "threshold": DEFAULT_RATING_THRESHOLD,
            "rule_text": f"Rating drops below {DEFAULT_RATING_THRESHOLD}",
        },
        {
            "kind": "price_gap_pct",
            "threshold": default_gap_threshold(product),
            "rule_text": (
                f"Price is more than {default_gap_threshold(product):g}% above the rival"
            ),
        },
    ]


# Kind of the placeholder row written when the seller removes every rule, so an
# emptied list stays empty instead of falling back to the defaults. It is not
# an alert kind, so evaluation and the API never surface it.
RULES_CLEARED_KIND = "rules_cleared"

# Kinds a chat can receive on Telegram, plus the two non-alert streams.
TELEGRAM_ALERT_KINDS = (
    "oos_any",
    "oos_area",
    "price_change_pct",
    "price_gap_pct",
    "rating_below",
    "rival_oos",
    "custom",
)
TELEGRAM_STREAMS = (*TELEGRAM_ALERT_KINDS, "recommendations", "briefing")
# Stored ``TelegramLink.alert_types`` (a NOT NULL JSON list):
#   []        every alert kind and stream (the default for new links)
#   ["none"]  nothing at all — the seller unselected every option
#   [...]     exactly those kinds / streams
# The API exposes the same as ``null`` (everything), ``[]`` (nothing), or a list.
TELEGRAM_NOTHING = "none"


def telegram_types_out(stored: list | None) -> list[str] | None:
    """Stored ``alert_types`` → API value (None = everything, [] = nothing)."""
    if not stored:
        return None
    return [str(item) for item in stored if item != TELEGRAM_NOTHING]


def telegram_types_in(value: list[str] | None) -> list[str]:
    """API value → stored ``alert_types``."""
    if value is None:
        return []
    chosen = list(dict.fromkeys(str(item) for item in value))
    if not chosen:
        return [TELEGRAM_NOTHING]
    if set(TELEGRAM_STREAMS) <= set(chosen):
        return []
    return chosen


def link_wants(link: TelegramLink, stream: str) -> bool:
    """Whether a linked chat opted into an alert kind, "recommendations" or "briefing"."""
    stored = link.alert_types or []
    if not stored:
        return True
    return KIND_ALIASES.get(stream, stream) in {
        KIND_ALIASES.get(str(item), str(item)) for item in stored
    }


async def stored_rules(
    session: AsyncSession, product: Product
) -> list[AlertRule | dict]:
    """Every rule the seller sees, active or not.

    Defaults apply only while the product has never had rules saved; once the
    seller removed them all, a placeholder row keeps the list empty.
    """
    stored = list(
        (
            await session.scalars(
                select(AlertRule).where(AlertRule.product_id == product.id)
            )
        ).all()
    )
    if not stored:
        return default_alert_rules(product)
    return [rule for rule in stored if rule.kind != RULES_CLEARED_KIND]


async def effective_rules(
    session: AsyncSession, product: Product
) -> list[AlertRule | dict]:
    """Rules to evaluate: the active subset of ``stored_rules``."""
    return [
        rule
        for rule in await stored_rules(session, product)
        if _rule_field(rule, "active", True)
    ]


async def replace_alert_rules(
    session: AsyncSession, product_id: str, rules: list[dict]
) -> None:
    """Replace a product's rules; an empty list is remembered as "no rules"."""
    await session.execute(delete(AlertRule).where(AlertRule.product_id == product_id))
    if rules:
        session.add_all(AlertRule(product_id=product_id, **rule) for rule in rules)
    else:
        session.add(
            AlertRule(
                product_id=product_id,
                kind=RULES_CLEARED_KIND,
                rule_text="All alert rules removed",
                rule_json={},
                active=False,
            )
        )
    await session.commit()


def _rule_field(rule: AlertRule | dict, name: str, default=None):
    if isinstance(rule, dict):
        return rule.get(name, default)
    value = getattr(rule, name, default)
    return default if value is None else value


def _rule_threshold(rule: AlertRule | dict, default: float | None) -> float | None:
    threshold = _rule_field(rule, "threshold")
    return float(threshold) if threshold is not None else default


def _matches_area(
    area: str, city: str, wanted: str, coords: tuple[float, float] | None = None
) -> bool:
    wanted = wanted.strip().lower()
    if not wanted:
        return False
    zone = in_city_zone(wanted, city, coords)
    if zone is not None:
        return zone
    area, city = area.lower(), city.lower()
    # Never match on the city name inside a longer phrase: "South Delhi" holds
    # "delhi" but must not select every Delhi pincode.
    return wanted == city or wanted == area or wanted in area or area in wanted


async def resolve_rule_pincodes(session: AsyncSession, areas: list[str]) -> list[str]:
    """Pincodes whose area or city matches any of the named areas."""
    if not areas:
        return []
    rows = (await session.scalars(select(Pincode))).all()
    return sorted(
        row.code
        for row in rows
        if any(
            _matches_area(row.area_name, row.city, wanted, (row.lat, row.lng))
            for wanted in areas
        )
    )


class _Evaluation:
    """Latest data for one product, shared by every rule evaluator."""

    def __init__(
        self,
        product: Product,
        now: datetime,
        seller_latest: dict[tuple, CheckResult],
        rival_latest: dict[tuple, CheckResult],
        places: dict[str, tuple[str, str]],
        coords: dict[str, tuple[float, float]] | None = None,
    ) -> None:
        self.product = product
        self.now = now
        self.day = now.date().isoformat()
        self.seller_latest = seller_latest
        self.rival_latest = rival_latest
        self.places = places
        self.coords = coords or {}
        self.cheapest_rival: dict[tuple[str, str], float] = {}
        for (_competitor_id, platform, pincode), row in rival_latest.items():
            if row.status != "ok" or row.in_stock is not True or row.price is None:
                continue
            current = self.cheapest_rival.get((platform, pincode))
            if current is None or row.price < current:
                self.cheapest_rival[(platform, pincode)] = row.price

    def area(self, pincode: str) -> str:
        place = self.places.get(pincode)
        return place[0] if place else pincode


def _candidate(kind: str, message: str, evidence: dict, dedupe_key: str) -> dict:
    return {
        "kind": kind,
        "message": message[:ALERT_MESSAGE_LIMIT],
        "evidence": evidence,
        "dedupe_key": dedupe_key[:500],
    }


def _oos_candidates(ev: _Evaluation, kind: str, pins: set[str] | None, rule_key: str):
    product = ev.product
    for (platform, pincode), row in ev.seller_latest.items():
        if row.in_stock is not False or (pins is not None and pincode not in pins):
            continue
        yield _candidate(
            kind,
            f"{product.name} is out of stock in {ev.area(pincode)} ({pincode}) "
            f"on {platform}.",
            {"platform": platform, "pincode": pincode, "price": row.price},
            f"{rule_key}:{product.id}:{platform}:{pincode}:{ev.day}",
        )


def _area_pins(ev: _Evaluation, rule: AlertRule | dict) -> set[str]:
    rule_json = _rule_field(rule, "rule_json", {}) or {}
    pins = {str(code) for code in rule_json.get("pincodes") or []}
    areas = [str(area) for area in rule_json.get("areas") or []]
    for code, (area, city) in ev.places.items():
        coords = ev.coords.get(code)
        if any(_matches_area(area, city, wanted, coords) for wanted in areas):
            pins.add(code)
    return pins


async def _price_change_candidates(
    session: AsyncSession, ev: _Evaluation, threshold: float
) -> list[dict]:
    product = ev.product
    events = (
        await session.scalars(
            select(ChangeEvent)
            .where(
                ChangeEvent.product_id == product.id,
                ChangeEvent.kind.in_(("price_rise", "price_drop")),
                ChangeEvent.detected_at >= ev.now - timedelta(hours=24),
            )
            .order_by(ChangeEvent.detected_at.desc())
        )
    ).all()
    candidates: list[dict] = []
    for event in events:
        if event.old_value in (None, 0) or event.new_value is None:
            continue
        pct = abs(event.new_value - event.old_value) / event.old_value * 100
        if pct < threshold:
            continue
        direction = "up" if event.new_value > event.old_value else "down"
        candidates.append(
            _candidate(
                "price_change_pct",
                f"{product.name} price is {direction} {pct:.1f}% on "
                f"{event.platform}/{event.pincode} "
                f"(₹{event.old_value:.2f} → ₹{event.new_value:.2f}).",
                {
                    "platform": event.platform,
                    "pincode": event.pincode,
                    "old_value": event.old_value,
                    "new_value": event.new_value,
                    "pct": round(pct, 2),
                },
                f"price_change:{product.id}:{event.id}",
            )
        )
    return candidates


def _rating_candidates(ev: _Evaluation, threshold: float) -> list[dict]:
    product = ev.product
    candidates: list[dict] = []
    for (platform, pincode), row in ev.seller_latest.items():
        if row.rating is None or row.rating >= threshold:
            continue
        candidates.append(
            _candidate(
                "rating_below",
                f"{product.name} rating {row.rating:.1f} is below {threshold:.1f} "
                f"in {ev.area(pincode)} ({pincode}) on {platform}.",
                {
                    "platform": platform,
                    "pincode": pincode,
                    "rating": row.rating,
                    "threshold": threshold,
                },
                f"rating:{product.id}:{platform}:{pincode}:"
                f"{round(float(row.rating), 2)}:{ev.day}",
            )
        )
    return candidates


def _gap_candidates(ev: _Evaluation, threshold: float) -> list[dict]:
    product = ev.product
    candidates: list[dict] = []
    for (platform, pincode), row in ev.seller_latest.items():
        if row.price is None or row.status != "ok":
            continue
        rival_price = ev.cheapest_rival.get((platform, pincode))
        if not rival_price:
            continue
        gap = (row.price / rival_price - 1) * 100
        if gap < threshold:
            continue
        candidates.append(
            _candidate(
                "price_gap_pct",
                f"{product.name} on {platform} in {ev.area(pincode)} is priced "
                f"{gap:.1f}% above the rival "
                f"(₹{row.price:.2f} vs ₹{rival_price:.2f}).",
                {
                    "platform": platform,
                    "pincode": pincode,
                    "price": row.price,
                    "rival_price": rival_price,
                    "gap_pct": round(gap, 2),
                },
                f"price_gap:{product.id}:{platform}:{pincode}:"
                f"{round(row.price, 2)}:{round(rival_price, 2)}:{ev.day}",
            )
        )
    return candidates


def _rival_oos_candidates(ev: _Evaluation) -> list[dict]:
    product = ev.product
    candidates: list[dict] = []
    for (competitor_id, platform, pincode), row in ev.rival_latest.items():
        if row.in_stock is not False:
            continue
        candidates.append(
            _candidate(
                "rival_oos",
                f"A competitor is out of stock for {product.name} in "
                f"{ev.area(pincode)} ({pincode}) on {platform} — chance to capture "
                "the shelf.",
                {"competitor_id": competitor_id, "platform": platform, "pincode": pincode},
                f"rival_oos:{product.id}:{competitor_id}:{platform}:{pincode}:{ev.day}",
            )
        )
    return candidates


async def _rule_candidates(
    session: AsyncSession, ev: _Evaluation, rule: AlertRule | dict
) -> list[dict]:
    kind = KIND_ALIASES.get(_rule_field(rule, "kind"), _rule_field(rule, "kind"))
    rule_id = rule.id if isinstance(rule, AlertRule) else None
    if kind == "oos_any":
        return list(_oos_candidates(ev, "oos_any", None, "oos"))
    if kind == "oos_area":
        return list(
            _oos_candidates(ev, "oos_area", _area_pins(ev, rule), f"oos_area:{rule_id}")
        )
    if kind == "price_change_pct":
        threshold = _rule_threshold(rule, ev.product.max_change_pct) or 0.0
        return await _price_change_candidates(session, ev, threshold)
    if kind == "rating_below":
        return _rating_candidates(ev, _rule_threshold(rule, DEFAULT_RATING_THRESHOLD) or 0.0)
    if kind == "price_gap_pct":
        return _gap_candidates(
            ev, _rule_threshold(rule, default_gap_threshold(ev.product)) or 0.0
        )
    if kind == "rival_oos":
        return _rival_oos_candidates(ev)
    if kind == "custom":
        return await _custom_candidates(session, ev, rule, rule_id)
    return []


async def _custom_candidates(
    session: AsyncSession, ev: _Evaluation, rule: AlertRule | dict, rule_id: str | None
) -> list[dict]:
    text = (_rule_field(rule, "rule_text") or "").strip()
    if not text:
        return []
    parsed = await FallbackAIProvider().parse_alert_rule(text)
    if parsed.kind == "custom":
        return []
    derived = {
        "kind": parsed.kind,
        "threshold": _rule_field(rule, "threshold", parsed.threshold),
        "rule_json": {**parsed.rule_json, **(_rule_field(rule, "rule_json", {}) or {})},
    }
    quoted = text if len(text) <= 80 else text[:79] + "…"
    return [
        {
            **candidate,
            "kind": "custom",
            "message": f"Custom rule “{quoted}”: {candidate['message']}"[
                :ALERT_MESSAGE_LIMIT
            ],
            "evidence": {**candidate["evidence"], "rule_text": text},
            "dedupe_key": f"custom:{rule_id}:{candidate['dedupe_key']}"[:500],
        }
        for candidate in await _rule_candidates(session, ev, derived)
    ]


async def evaluate_alerts(
    session: AsyncSession,
    product: Product,
    *,
    run_id: str | None = None,
    now: datetime | None = None,
) -> list[Alert]:
    """Evaluate rules against the latest data and persist unseen alerts."""
    now = now if now is not None else utcnow()
    rules = await effective_rules(session, product)
    if not rules:
        return []
    pairs = await selected_pairs(session, product.id)
    seller_latest = {
        key: row
        for key, row in (await _latest_seller_rows(session, product.id, now=now)).items()
        if key[0] in pairs.get(key[1], ())
    }
    rival_latest = {
        key: row
        for key, row in (await _latest_rival_rows(session, product.id, now=now)).items()
        if key[1] in pairs.get(key[2], ())
    }
    pincode_rows = (
        await session.scalars(select(Pincode).where(Pincode.code.in_(pairs)))
    ).all()
    places = {row.code: (row.area_name, row.city) for row in pincode_rows}
    coords = {row.code: (row.lat, row.lng) for row in pincode_rows}
    ev = _Evaluation(product, now, seller_latest, rival_latest, places, coords)

    candidates: list[dict] = []
    for rule in rules:
        if _rule_field(rule, "kind") in ALERT_KINDS:
            candidates.extend(await _rule_candidates(session, ev, rule))
    if not candidates:
        return []
    keys = {candidate["dedupe_key"] for candidate in candidates}
    existing = set(
        (
            await session.scalars(
                select(Alert.dedupe_key).where(Alert.dedupe_key.in_(keys))
            )
        ).all()
    )
    created: list[Alert] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = candidate["dedupe_key"]
        if key in existing or key in seen:
            continue
        seen.add(key)
        alert = Alert(
            user_id=product.user_id,
            product_id=product.id,
            kind=candidate["kind"],
            message=candidate["message"],
            evidence=candidate["evidence"],
            dedupe_key=key,
        )
        session.add(alert)
        created.append(alert)
    if created:
        await session.commit()
        for alert in created:
            await session.refresh(alert)
        logger.info(
            "created %s alert(s) product=%s run=%s",
            len(created),
            product.id,
            run_id,
        )
    return created


def _within_quiet_hours(user_settings: UserSettings | None, now_local) -> bool:
    if user_settings is None:
        return False
    start = user_settings.quiet_hours_start
    end = user_settings.quiet_hours_end
    if not start or not end:
        return False
    try:
        start_minutes = int(start[:2]) * 60 + int(start[3:5])
        end_minutes = int(end[:2]) * 60 + int(end[3:5])
        current = now_local.hour * 60 + now_local.minute
    except (ValueError, IndexError):
        return False
    if start_minutes <= end_minutes:
        return start_minutes <= current < end_minutes
    return current >= start_minutes or current < end_minutes


def telegram_allowed(user_settings: UserSettings | None) -> bool:
    channels = user_settings.channels if user_settings is not None else None
    return not isinstance(channels, dict) or channels.get("telegram", True) is not False


async def deliver_alerts(
    session: AsyncSession, alerts: list[Alert]
) -> int:
    """Push alerts to linked Telegram chats; returns how many were delivered.

    Skipped entirely for users who switched the Telegram channel off. During
    quiet hours alerts stay unsent and ``deliver_deferred_alerts`` picks them
    up later. A chat only receives alerts raised after it was linked.
    Delivery is a no-op when the bot is not running.
    """
    from .telegram_features import alert_photo, send_alert  # local import avoids cycles

    if not alerts:
        return 0
    delivered = 0
    product_ids = {alert.product_id for alert in alerts}
    links = list(
        (
            await session.scalars(
                select(TelegramLink).where(TelegramLink.product_id.in_(product_ids))
            )
        ).all()
    )
    if not links:
        return 0
    links_by_product: dict[str, list[TelegramLink]] = {}
    for link in links:
        links_by_product.setdefault(link.product_id, []).append(link)
    users = {
        row.id: row
        for row in (
            await session.scalars(
                select(User).where(User.id.in_({link.user_id for link in links}))
            )
        ).all()
    }
    settings_rows = {
        row.user_id: row
        for row in (
            await session.scalars(
                select(UserSettings).where(UserSettings.user_id.in_(users.keys()))
            )
        ).all()
    }
    for alert in alerts:
        photo = await alert_photo(session, alert)
        for link in links_by_product.get(alert.product_id, []):
            if not link_wants(link, alert.kind):
                continue
            if alert.created_at < link.connected_at:
                continue
            user = users.get(link.user_id)
            if user is None:
                continue
            user_settings = settings_rows.get(link.user_id)
            if not telegram_allowed(user_settings):
                continue
            try:
                local_now = datetime.now(ZoneInfo(user.timezone))
            except (ZoneInfoNotFoundError, ValueError):
                local_now = datetime.now(UTC)
            if _within_quiet_hours(user_settings, local_now):
                continue
            sent = await send_alert(link.chat_id, f"[ShelfSense] {alert.message}", photo)
            if sent:
                alert.sent_telegram = True
                delivered += 1
    await session.commit()
    return delivered


async def deliver_deferred_alerts(now: datetime | None = None) -> int:
    """Retry recent unsent alerts (e.g. raised during quiet hours)."""
    now = now if now is not None else utcnow()
    async with SessionLocal() as session:
        pending = list(
            (
                await session.scalars(
                    select(Alert)
                    .where(
                        Alert.sent_telegram.is_(False),
                        Alert.created_at >= now - DEFERRED_ALERT_WINDOW,
                        or_(
                            Alert.product_id.in_(select(TelegramLink.product_id)),
                        ),
                    )
                    .order_by(Alert.created_at)
                )
            ).all()
        )
        return await deliver_alerts(session, pending)
