"""Geodesy helpers: heatmap hot-zone clustering and city zones for alert rules."""

from __future__ import annotations

import re
from math import asin, cos, radians, sin, sqrt

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS84 points, in kilometres."""
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    value = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * asin(sqrt(value))


# City centres used to place pincodes in "North Delhi", "South Delhi", etc.
CITY_CENTRES: dict[str, tuple[float, float]] = {"delhi": (28.6315, 77.2167)}
# Degrees off the centre before a point counts as north/south (~2 km) or
# east/west (~3 km); "central" is anything within CENTRAL_RADIUS_KM.
ZONE_LAT_MARGIN = 0.02
ZONE_LNG_MARGIN = 0.03
CENTRAL_RADIUS_KM = 5.0
_ZONE_RE = re.compile(
    r"^(?P<first>north|south|east|west|central)(?:[\s-]+(?P<second>east|west))?"
    r"\s+(?P<city>[a-z ]+)$"
)


def in_city_zone(
    wanted: str, city: str, coords: tuple[float, float] | None
) -> bool | None:
    """Whether a point lies in a zone such as "South Delhi".

    None when ``wanted`` is not a zone of a city we know, so callers fall
    back to plain name matching.
    """
    match = _ZONE_RE.match(wanted.strip().lower())
    if match is None or match["city"].strip() not in CITY_CENTRES:
        return None
    if match["city"].strip() != city.strip().lower() or coords is None:
        return False
    centre_lat, centre_lng = CITY_CENTRES[match["city"].strip()]
    lat, lng = coords
    checks = {
        "north": lat > centre_lat + ZONE_LAT_MARGIN,
        "south": lat < centre_lat - ZONE_LAT_MARGIN,
        "east": lng > centre_lng + ZONE_LNG_MARGIN,
        "west": lng < centre_lng - ZONE_LNG_MARGIN,
        "central": haversine_km(lat, lng, centre_lat, centre_lng) <= CENTRAL_RADIUS_KM,
    }
    return all(checks[part] for part in (match["first"], match["second"]) if part)
