"""Building replay sessions from *real* data.

Synthetic sessions validate the machinery.  Only these two paths can say
anything about whether an edge actually exists.

**From the bot's own recordings** (:func:`session_from_database`).  Running in
paper mode records, once per second per market, the full order-book state, the
composite reference price and the resolved outcome.  Replaying that is as close
to ground truth as it gets: the books and prices are exactly what the bot saw,
including every gap, stale tick and thin moment.  This is the recommended route
and it needs nothing but time.

**From public history** (:func:`session_from_history`).  Exchange klines give
the reference price path; Polymarket's ``/prices-history`` gives the market's
own mid over the window.  A book has to be *reconstructed* around that mid,
which means depth and the exact spread are assumptions, not observations.
Results from this path are therefore weaker evidence than recorded sessions,
and the session is tagged so no report can quietly present one as the other.

Neither path is available without network access to the venues; see
``scripts/fetch_history.py``.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from ..core.types import Market, Outcome, PriceLevel, Tick, TokenInfo
from ..logging_setup import get_logger
from .replay import ReplayEvent, ReplaySession, WindowTruth

log = get_logger("pmbot.backtesting.real")


@dataclass
class BookReconstruction:
    """Assumptions used when a real book was not recorded, only a mid price."""

    spread: float = 0.01
    top_size: float = 30.0
    depth_levels: int = 4
    depth_growth: float = 1.8
    tick_size: float = 0.01

    def levels(self, mid: float) -> tuple[list[PriceLevel], list[PriceLevel]]:
        half = self.spread / 2.0
        bid = _floor_tick(mid - half, self.tick_size)
        ask = _ceil_tick(mid + half, self.tick_size)
        if ask <= bid:
            ask = _ceil_tick(bid + self.tick_size, self.tick_size)
        bids, asks = [], []
        for level in range(self.depth_levels):
            size = self.top_size * (self.depth_growth ** level)
            bid_price = round(bid - level * self.tick_size, 6)
            ask_price = round(ask + level * self.tick_size, 6)
            if 0.0 < bid_price < 1.0:
                bids.append(PriceLevel(bid_price, round(size, 2)))
            if 0.0 < ask_price < 1.0:
                asks.append(PriceLevel(ask_price, round(size, 2)))
        return bids, asks


def _floor_tick(value: float, tick: float) -> float:
    return round(max(math.floor(value / tick) * tick, tick), 6)


def _ceil_tick(value: float, tick: float) -> float:
    return round(min(math.ceil(value / tick) * tick, 1.0 - tick), 6)


# ------------------------------------------------------------------ database


async def session_from_database(
    db,
    start_ts: float | None = None,
    end_ts: float | None = None,
    assets: Sequence[str] | None = None,
    label: str = "recorded",
) -> ReplaySession:
    """Rebuild a replay session from the bot's own recorded paper/live session.

    Uses the ``markets``, ``book_snapshots``, ``features`` and ``public_trades``
    tables.  Only markets with a recorded ``resolved_outcome`` are included,
    because an unresolved window cannot be scored.
    """
    clauses = ["resolved_outcome IS NOT NULL"]
    params: list[Any] = []
    if start_ts is not None:
        clauses.append("window_start >= ?")
        params.append(start_ts)
    if end_ts is not None:
        clauses.append("window_end <= ?")
        params.append(end_ts)
    if assets:
        clauses.append(f"asset IN ({','.join('?' for _ in assets)})")
        params.extend(a.upper() for a in assets)

    market_rows = await db.query(
        f"SELECT * FROM markets WHERE {' AND '.join(clauses)} ORDER BY window_start",
        params,
    )
    if not market_rows:
        return ReplaySession([], [], {}, label=label, meta={"source": "database"})

    markets: list[Market] = []
    truth: dict[str, WindowTruth] = {}
    market_ids: list[str] = []
    for row in market_rows:
        market = _market_from_row(row)
        markets.append(market)
        market_ids.append(market.market_id)
        truth[market.market_id] = WindowTruth(
            market_id=market.market_id, asset=market.asset,
            window_start=market.window_start, window_end=market.window_end,
            strike=float(row.get("strike_price") or 0.0),
            settle=float(row.get("settle_price") or 0.0),
            outcome=Outcome(row["resolved_outcome"]),
        )

    placeholders = ",".join("?" for _ in market_ids)
    events: list[ReplayEvent] = []

    book_rows = await db.query(
        f"""
        SELECT ts, market_id, token_id, best_bid, best_ask, bid_size, ask_size,
               depth_bid, depth_ask, liquidity
        FROM book_snapshots
        WHERE market_id IN ({placeholders})
        ORDER BY ts
        """,
        market_ids,
    )
    reconstruction = BookReconstruction()
    for row in book_rows:
        bid, ask = row.get("best_bid"), row.get("best_ask")
        if bid is None or ask is None:
            continue
        # Recorded top-of-book is real; the levels behind it are reconstructed
        # from the recorded aggregate depth.
        bid_size = float(row.get("bid_size") or reconstruction.top_size)
        ask_size = float(row.get("ask_size") or reconstruction.top_size)
        depth_bid = float(row.get("depth_bid") or bid_size)
        depth_ask = float(row.get("depth_ask") or ask_size)
        bids = [PriceLevel(float(bid), bid_size)]
        asks = [PriceLevel(float(ask), ask_size)]
        remaining_bid = max(depth_bid - bid_size, 0.0)
        remaining_ask = max(depth_ask - ask_size, 0.0)
        for level in range(1, reconstruction.depth_levels):
            share = 0.5 ** level
            bid_price = round(float(bid) - level * reconstruction.tick_size, 6)
            ask_price = round(float(ask) + level * reconstruction.tick_size, 6)
            if 0.0 < bid_price < 1.0 and remaining_bid > 0:
                bids.append(PriceLevel(bid_price, round(remaining_bid * share, 2)))
            if 0.0 < ask_price < 1.0 and remaining_ask > 0:
                asks.append(PriceLevel(ask_price, round(remaining_ask * share, 2)))
        events.append(ReplayEvent(
            float(row["ts"]), "book",
            (str(row["token_id"]), bids, asks, reconstruction.tick_size),
        ))

    trade_rows = await db.query(
        f"""
        SELECT ts, token_id, price, size, side FROM public_trades
        WHERE market_id IN ({placeholders}) ORDER BY ts
        """,
        market_ids,
    )
    for row in trade_rows:
        events.append(ReplayEvent(
            float(row["ts"]), "trade",
            (str(row["token_id"]), float(row["price"]), float(row["size"] or 0.0),
             row.get("side")),
        ))

    feature_rows = await db.query(
        f"""
        SELECT ts, asset, spot FROM features
        WHERE market_id IN ({placeholders}) AND spot > 0 ORDER BY ts
        """,
        market_ids,
    )
    # The recorded composite becomes a single synthetic "recorded" venue: it is
    # already the aggregate, so re-splitting it across venues would fabricate a
    # cross-exchange structure that never existed.
    for row in feature_rows:
        ts = float(row["ts"])
        events.append(ReplayEvent(ts, "tick", Tick(
            exchange="recorded", symbol=str(row["asset"]), asset=str(row["asset"]),
            price=float(row["spot"]), size=0.0, timestamp=ts, received_at=ts,
            is_trade=False,
        )))

    return ReplaySession(
        markets=markets, events=events, truth=truth, label=label, synthetic=False,
        meta={
            "source": "database",
            "book_rows": len(book_rows),
            "trade_rows": len(trade_rows),
            "price_rows": len(feature_rows),
            "note": (
                "Top-of-book is as recorded; deeper levels are reconstructed "
                "from recorded aggregate depth. The reference price is the "
                "recorded composite, replayed as one venue."
            ),
        },
    )


def _market_from_row(row: dict[str, Any]) -> Market:
    return Market(
        market_id=str(row["market_id"]), condition_id=str(row["condition_id"]),
        question_id=row.get("question_id"), slug=str(row.get("slug") or ""),
        asset=str(row["asset"]), title=str(row.get("title") or ""),
        window_start=float(row["window_start"]), window_end=float(row["window_end"]),
        tokens={
            Outcome.UP: TokenInfo(str(row["up_token_id"]), Outcome.UP, "Up"),
            Outcome.DOWN: TokenInfo(str(row["down_token_id"]), Outcome.DOWN, "Down"),
        },
        tick_size=float(row.get("tick_size") or 0.01),
        min_order_size=float(row.get("min_order_size") or 5.0),
        neg_risk=bool(row.get("neg_risk")),
        enable_order_book=True, accepting_orders=True, active=True, closed=False,
        resolution_source=row.get("resolution_source"),
        taker_fee_rate=float(row.get("taker_fee_rate") or 0.07),
        maker_fee_rate=float(row.get("maker_fee_rate") or 0.0),
        fee_type=row.get("fee_type"), series_slug=row.get("series_slug"),
    )


# ------------------------------------------------------------------- history


@dataclass
class HistoricalWindow:
    """One window assembled from downloaded history."""

    market: Market
    price_path: list[tuple[float, float]]          # (ts, reference price)
    market_mid: list[tuple[float, float]]          # (ts, UP token mid)
    resolved: Outcome | None = None
    strike: float | None = None
    settle: float | None = None


def session_from_history(
    windows: Iterable[HistoricalWindow],
    reconstruction: BookReconstruction | None = None,
    reference_venue: str = "history",
    label: str = "history",
) -> ReplaySession:
    """Assemble a replay session from downloaded price history.

    Books are *reconstructed* around the recorded mid, so depth and spread are
    modelling assumptions.  The session is tagged accordingly.
    """
    reconstruction = reconstruction or BookReconstruction()
    events: list[ReplayEvent] = []
    markets: list[Market] = []
    truth: dict[str, WindowTruth] = {}

    for window in windows:
        market = window.market
        markets.append(market)

        for ts, price in window.price_path:
            events.append(ReplayEvent(ts, "tick", Tick(
                exchange=reference_venue, symbol=market.asset, asset=market.asset,
                price=price, size=0.0, timestamp=ts, received_at=ts, is_trade=False,
            )))

        for ts, mid in window.market_mid:
            mid = min(max(mid, 0.01), 0.99)
            bids, asks = reconstruction.levels(mid)
            events.append(ReplayEvent(
                ts, "book",
                (market.token_id(Outcome.UP), bids, asks, reconstruction.tick_size),
            ))
            down_bids, down_asks = reconstruction.levels(1.0 - mid)
            events.append(ReplayEvent(
                ts, "book",
                (market.token_id(Outcome.DOWN), down_bids, down_asks,
                 reconstruction.tick_size),
            ))

        outcome = window.resolved
        strike = window.strike
        settle = window.settle
        if outcome is None and strike and settle:
            outcome = Outcome.UP if settle >= strike else Outcome.DOWN
        if outcome is None:
            continue
        truth[market.market_id] = WindowTruth(
            market_id=market.market_id, asset=market.asset,
            window_start=market.window_start, window_end=market.window_end,
            strike=strike or 0.0, settle=settle or 0.0, outcome=outcome,
        )

    return ReplaySession(
        markets=[m for m in markets if m.market_id in truth],
        events=events, truth=truth, label=label, synthetic=False,
        meta={
            "source": "history",
            "reconstruction": {
                "spread": reconstruction.spread,
                "top_size": reconstruction.top_size,
                "depth_levels": reconstruction.depth_levels,
            },
            "WARNING": (
                "Order-book depth and spread are reconstructed from a mid-price "
                "series, not observed. Execution results are weaker evidence "
                "than a recorded session."
            ),
        },
    )


def windows_from_klines(
    asset: str,
    klines: Sequence[tuple[float, float]],
    market_mids: dict[float, list[tuple[float, float]]],
    markets: dict[float, Market],
    window_seconds: int = 300,
) -> list[HistoricalWindow]:
    """Slice a continuous reference-price series into per-window replays.

    ``klines`` is ``[(epoch_seconds, price)]`` at whatever resolution is
    available; ``market_mids`` and ``markets`` are keyed by window-start epoch.
    """
    ordered = sorted(klines)
    asset = asset.upper()
    out: list[HistoricalWindow] = []
    for window_start, market in sorted(markets.items()):
        if market.asset.upper() != asset:
            continue
        window_end = window_start + window_seconds
        # Include a warmup prefix so the estimators are primed before the open.
        lo = window_start - 600
        path = [(ts, price) for ts, price in ordered if lo <= ts <= window_end + 5]
        if len(path) < 10:
            continue
        strike = next((p for ts, p in path if ts >= window_start), None)
        settle = None
        for ts, price in path:
            if ts <= window_end:
                settle = price
        out.append(HistoricalWindow(
            market=market, price_path=path,
            market_mid=market_mids.get(window_start, []),
            strike=strike, settle=settle,
        ))
    return out


def save_session(session: ReplaySession, path) -> None:
    session.save(path)
    log.info(
        "replay session saved",
        extra={"path": str(path), **{k: v for k, v in session.describe().items()
                                     if k not in ("WARNING", "note")}},
    )
