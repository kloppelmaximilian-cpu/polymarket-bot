"""Defensive parsers for Polymarket API payloads.

Gamma returns several fields as *stringified JSON* (``outcomes``,
``outcomePrices``, ``clobTokenIds``) and the shape drifts between market types.
Every parser here returns ``None``/empty rather than raising, and records why,
so a single unexpected market can never break discovery for all the others.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..core.clock import parse_iso8601
from ..core.types import Market, Outcome, TokenInfo

#: Canonical asset symbols recognised in market titles/slugs.
ASSET_ALIASES: dict[str, str] = {
    "btc": "BTC", "bitcoin": "BTC", "xbt": "BTC",
    "eth": "ETH", "ethereum": "ETH", "ether": "ETH",
    "sol": "SOL", "solana": "SOL",
    "xrp": "XRP", "ripple": "XRP",
    "doge": "DOGE", "dogecoin": "DOGE",
    "bnb": "BNB", "binancecoin": "BNB",
    "hype": "HYPE", "hyperliquid": "HYPE",
    "ada": "ADA", "cardano": "ADA",
    "ltc": "LTC", "litecoin": "LTC",
    "avax": "AVAX", "avalanche": "AVAX",
    "link": "LINK", "chainlink": "LINK",
}

_UP_WORDS = {"up", "yes", "above", "higher", "over"}
_DOWN_WORDS = {"down", "no", "below", "lower", "under"}

_SLUG_TS_RE = re.compile(r"-(\d{9,12})$")
_RECURRENCE_RE = re.compile(r"(?:^|[^0-9a-z])(\d+)\s*(m|min|minute|h|hour)", re.I)


def loads_maybe(value: Any) -> Any:
    """Gamma stringifies JSON arrays; accept both forms."""
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None
    return None


def as_float(value: Any, default: float | None = None) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if f == f else default


def as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def detect_asset(*texts: str | None) -> str | None:
    """Identify the crypto asset from any of the supplied strings."""
    for text in texts:
        if not text:
            continue
        tokens = re.split(r"[^a-zA-Z0-9]+", text.lower())
        for token in tokens:
            if token in ASSET_ALIASES:
                return ASSET_ALIASES[token]
    return None


def detect_window_seconds(*texts: str | None) -> int | None:
    """Extract a recurrence length in seconds from a slug/ticker/recurrence."""
    for text in texts:
        if not text:
            continue
        match = _RECURRENCE_RE.search(text)
        if match:
            value, unit = int(match.group(1)), match.group(2).lower()
            return value * 60 if unit.startswith("m") else value * 3600
    return None


def slug_timestamp(slug: str | None) -> float | None:
    """The window-start epoch encoded in slugs like ``btc-updown-5m-1778584200``."""
    if not slug:
        return None
    match = _SLUG_TS_RE.search(slug)
    if not match:
        return None
    ts = float(match.group(1))
    # Sanity band: 2020-01-01 .. 2100-01-01
    return ts if 1577836800 <= ts <= 4102444800 else None


def classify_outcome(label: str) -> Outcome | None:
    token = label.strip().lower()
    if token in _UP_WORDS:
        return Outcome.UP
    if token in _DOWN_WORDS:
        return Outcome.DOWN
    return None


def parse_tokens(raw_market: dict[str, Any]) -> dict[Outcome, TokenInfo] | None:
    """Map outcome labels to CLOB token ids.

    Accepts both the Gamma form (parallel ``outcomes`` / ``clobTokenIds``
    arrays) and the CLOB form (a ``tokens`` array of objects).
    """
    clob_tokens = raw_market.get("tokens")
    if isinstance(clob_tokens, list) and clob_tokens:
        mapped: dict[Outcome, TokenInfo] = {}
        for entry in clob_tokens:
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("outcome", ""))
            token_id = entry.get("token_id") or entry.get("tokenId")
            outcome = classify_outcome(label)
            if outcome is None or not token_id:
                continue
            mapped[outcome] = TokenInfo(str(token_id), outcome, label)
        return mapped if len(mapped) == 2 else None

    outcomes = loads_maybe(raw_market.get("outcomes"))
    token_ids = loads_maybe(raw_market.get("clobTokenIds"))
    if not isinstance(outcomes, list) or not isinstance(token_ids, list):
        return None
    if len(outcomes) != len(token_ids) or len(outcomes) != 2:
        return None

    mapped = {}
    for label, token_id in zip(outcomes, token_ids, strict=True):
        outcome = classify_outcome(str(label))
        if outcome is None or not token_id:
            return None
        mapped[outcome] = TokenInfo(str(token_id), outcome, str(label))
    return mapped if len(mapped) == 2 else None


def parse_window(
    raw_market: dict[str, Any], raw_event: dict[str, Any] | None = None
) -> tuple[float, float] | None:
    """Resolve (window_start, window_end) as epoch seconds.

    Precedence, most trustworthy first:
      1. ``eventStartTime`` / ``endDate`` on the market (ISO-8601 UTC),
      2. ``startTime`` / ``endDate`` on the event,
      3. the epoch encoded in the slug plus the detected recurrence.

    The human title is deliberately ignored: it is rendered in US Eastern time
    while every machine field is UTC, which is a classic source of off-by-hours
    bugs.
    """
    event = raw_event or {}

    end = None
    for key, source in (
        ("endDate", raw_market), ("endDate", event),
        ("end_date_iso", raw_market), ("endDateIso", raw_market),
    ):
        value = source.get(key)
        if isinstance(value, str) and value:
            try:
                end = parse_iso8601(value)
                break
            except (ValueError, TypeError):
                continue
        if isinstance(value, (int, float)) and value > 0:
            end = float(value)
            break

    start = None
    for key, source in (
        ("eventStartTime", raw_market), ("startTime", event),
        ("eventStartTime", event), ("gameStartTime", raw_market),
    ):
        value = source.get(key)
        if isinstance(value, str) and value:
            try:
                start = parse_iso8601(value)
                break
            except (ValueError, TypeError):
                continue

    slug = raw_market.get("slug") or event.get("slug")
    if start is None:
        start = slug_timestamp(slug)

    window = detect_window_seconds(
        slug,
        event.get("seriesSlug"),
        (event.get("series") or [{}])[0].get("recurrence")
        if isinstance(event.get("series"), list) and event.get("series") else None,
    )

    if start is None and end is not None and window:
        start = end - window
    if end is None and start is not None and window:
        end = start + window
    if start is None or end is None or end <= start:
        return None
    return start, end


def parse_market(
    raw_market: dict[str, Any],
    raw_event: dict[str, Any] | None = None,
    default_taker_fee: float = 0.07,
    default_maker_fee: float = 0.0,
) -> tuple[Market | None, str]:
    """Build a :class:`Market`.  Returns ``(market, reason_if_rejected)``."""
    from .fees import FeeSchedule

    event = raw_event or {}

    tokens = parse_tokens(raw_market)
    if tokens is None:
        return None, "unparseable outcomes/clobTokenIds"

    window = parse_window(raw_market, event)
    if window is None:
        return None, "unparseable window (eventStartTime/endDate)"
    window_start, window_end = window

    condition_id = raw_market.get("conditionId") or raw_market.get("condition_id")
    if not condition_id:
        return None, "missing conditionId"

    slug = str(raw_market.get("slug") or event.get("slug") or "")
    title = str(raw_market.get("question") or event.get("title") or slug)
    series_slug = event.get("seriesSlug")
    if not series_slug and isinstance(event.get("series"), list) and event["series"]:
        series_slug = (event["series"][0] or {}).get("slug")

    asset = detect_asset(series_slug, slug, title)
    if asset is None:
        return None, "could not identify crypto asset"

    tick = as_float(
        raw_market.get("orderPriceMinTickSize")
        or raw_market.get("minimum_tick_size")
        or raw_market.get("tickSize"),
        0.01,
    ) or 0.01
    min_size = as_float(
        raw_market.get("orderMinSize") or raw_market.get("minimum_order_size"), 5.0
    ) or 5.0

    schedule = FeeSchedule.from_market_dict(
        raw_market, default_taker=default_taker_fee, default_maker=default_maker_fee
    )

    market = Market(
        market_id=str(raw_market.get("id") or condition_id),
        condition_id=str(condition_id),
        question_id=str(raw_market.get("questionID") or raw_market.get("questionId") or "")
        or None,
        slug=slug,
        asset=asset,
        title=title,
        window_start=window_start,
        window_end=window_end,
        tokens=tokens,
        tick_size=tick,
        min_order_size=min_size,
        neg_risk=as_bool(raw_market.get("negRisk") or raw_market.get("neg_risk")),
        enable_order_book=as_bool(
            raw_market.get("enableOrderBook", raw_market.get("enable_order_book", True)),
            True,
        ),
        accepting_orders=as_bool(
            raw_market.get("acceptingOrders", raw_market.get("accepting_orders", True)),
            True,
        ),
        active=as_bool(raw_market.get("active", True), True),
        closed=as_bool(raw_market.get("closed", False), False),
        resolution_source=raw_market.get("resolutionSource") or event.get("resolutionSource"),
        taker_fee_rate=schedule.taker_rate,
        maker_fee_rate=schedule.maker_rate,
        fee_type=schedule.fee_type,
        liquidity=as_float(raw_market.get("liquidity") or event.get("liquidity"), 0.0) or 0.0,
        volume=as_float(raw_market.get("volume") or event.get("volume"), 0.0) or 0.0,
        series_slug=str(series_slug) if series_slug else None,
        raw={"market": raw_market, "event_meta": {
            k: event.get(k) for k in ("id", "slug", "seriesSlug", "title") if k in event
        }},
    )
    return market, ""


def parse_book(payload: dict[str, Any], token_id: str | None = None):
    """Parse a CLOB ``/book`` response or a websocket ``book`` event.

    Polymarket returns bids ascending and asks descending; we normalise to
    bids descending / asks ascending so ``[0]`` is always the touch.
    """
    from ..core.types import BookSnapshot, PriceLevel

    tid = str(payload.get("asset_id") or payload.get("assetId") or token_id or "")
    raw_bids = payload.get("bids") or []
    raw_asks = payload.get("asks") or []

    def levels(rows: Any) -> list[PriceLevel]:
        out: list[PriceLevel] = []
        if not isinstance(rows, list):
            return out
        for row in rows:
            if isinstance(row, dict):
                price = as_float(row.get("price"))
                size = as_float(row.get("size"))
            elif isinstance(row, (list, tuple)) and len(row) >= 2:
                price, size = as_float(row[0]), as_float(row[1])
            else:
                continue
            if price is None or size is None or size <= 0:
                continue
            if not 0.0 < price < 1.0:
                continue
            out.append(PriceLevel(price, size))
        return out

    bids = sorted(levels(raw_bids), key=lambda lvl: lvl.price, reverse=True)
    asks = sorted(levels(raw_asks), key=lambda lvl: lvl.price)

    ts_raw = payload.get("timestamp")
    timestamp = 0.0
    if ts_raw is not None:
        value = as_float(ts_raw, 0.0) or 0.0
        # Polymarket sends milliseconds as a string.
        timestamp = value / 1000.0 if value > 1e11 else value

    tick = as_float(payload.get("tick_size"), 0.01) or 0.01
    return BookSnapshot(
        token_id=tid,
        bids=bids,
        asks=asks,
        timestamp=timestamp,
        tick_size=tick,
        source_hash=payload.get("hash"),
    )
