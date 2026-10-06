"""Replay data format, and a synthetic world generator for engine validation.

The replay format is a time-ordered event stream that is fed into the *same*
components the live bot uses: exchange ticks go into the composite price engine,
book snapshots and deltas into the order-book manager, prints into the trade
tape.  The backtester is therefore the live system with a different data source
and a simulated clock, not a parallel reimplementation that can quietly diverge.

--------------------------------------------------------------------------------
IMPORTANT, AND NOT A DISCLAIMER FOR ITS OWN SAKE
--------------------------------------------------------------------------------
:func:`generate_synthetic_session` produces a *simulated* world.  The market
maker in that world misprices by an amount **this module chooses** (through
``vol_bias``, ``quote_lag_seconds`` and ``quote_noise``).  A P&L figure from a
synthetic session therefore measures the engine -- accounting, fee handling,
sizing, risk limits, execution mechanics, absence of look-ahead -- and says
**nothing whatsoever** about whether the real Polymarket 5-minute books are
mispriced.  Any profitability claim has to come from :mod:`pmbot.backtesting.real`
running on recorded or downloaded market data.

The most useful synthetic test is the *negative* one: set
``market_efficiency=1.0`` and the market maker prices with the true volatility
and no lag.  A correct bot then finds essentially no edge that survives fees and
trades almost nothing.  If it still trades a lot, the edge calculation is wrong.
"""

from __future__ import annotations

import json
import math
import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..core.clock import floor_to_window
from ..core.types import Market, Outcome, PriceLevel, Tick, TokenInfo
from ..probability.analytic import FairValueInputs, fair_value


@dataclass
class ReplayEvent:
    ts: float
    kind: str                 # "tick" | "book" | "trade"
    payload: Any

    def __lt__(self, other: ReplayEvent) -> bool:
        return self.ts < other.ts


@dataclass
class WindowTruth:
    """Ground truth for one window -- only ever used for settlement/labels."""

    market_id: str
    asset: str
    window_start: float
    window_end: float
    strike: float
    settle: float
    outcome: Outcome


@dataclass
class ReplaySession:
    markets: list[Market]
    events: list[ReplayEvent]
    truth: dict[str, WindowTruth]
    label: str = "session"
    meta: dict[str, Any] = field(default_factory=dict)
    synthetic: bool = False

    def __post_init__(self) -> None:
        self.events.sort(key=lambda e: e.ts)

    @property
    def start(self) -> float:
        return self.events[0].ts if self.events else 0.0

    @property
    def end(self) -> float:
        return self.events[-1].ts if self.events else 0.0

    @property
    def hours(self) -> float:
        return (self.end - self.start) / 3600.0

    def describe(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "synthetic": self.synthetic,
            "markets": len(self.markets),
            "events": len(self.events),
            "assets": sorted({m.asset for m in self.markets}),
            "start": self.start,
            "end": self.end,
            "hours": round(self.hours, 3),
            "up_rate": (
                sum(1 for t in self.truth.values() if t.outcome is Outcome.UP)
                / len(self.truth)
            ) if self.truth else None,
            **self.meta,
        }

    def iter_until(self, ts: float, cursor: int) -> tuple[list[ReplayEvent], int]:
        """All events at or before ``ts``, plus the new cursor."""
        out: list[ReplayEvent] = []
        i = cursor
        while i < len(self.events) and self.events[i].ts <= ts:
            out.append(self.events[i])
            i += 1
        return out, i

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "label": self.label,
            "synthetic": self.synthetic,
            "meta": self.meta,
            "markets": [_market_to_dict(m) for m in self.markets],
            "truth": {
                k: {
                    "market_id": v.market_id, "asset": v.asset,
                    "window_start": v.window_start, "window_end": v.window_end,
                    "strike": v.strike, "settle": v.settle,
                    "outcome": v.outcome.value,
                }
                for k, v in self.truth.items()
            },
            "events": [
                {"ts": e.ts, "kind": e.kind, "payload": _encode_payload(e)}
                for e in self.events
            ],
        }
        path.write_text(json.dumps(payload))

    @classmethod
    def load(cls, path: Path) -> ReplaySession:
        payload = json.loads(Path(path).read_text())
        markets = [_market_from_dict(row) for row in payload["markets"]]
        truth = {
            k: WindowTruth(
                market_id=v["market_id"], asset=v["asset"],
                window_start=v["window_start"], window_end=v["window_end"],
                strike=v["strike"], settle=v["settle"],
                outcome=Outcome(v["outcome"]),
            )
            for k, v in payload["truth"].items()
        }
        events = [_decode_event(row) for row in payload["events"]]
        return cls(
            markets=markets, events=events, truth=truth,
            label=payload.get("label", "session"),
            meta=payload.get("meta", {}),
            synthetic=payload.get("synthetic", False),
        )


# --------------------------------------------------------------- serialisation


def _market_to_dict(market: Market) -> dict[str, Any]:
    return {
        "market_id": market.market_id, "condition_id": market.condition_id,
        "question_id": market.question_id, "slug": market.slug, "asset": market.asset,
        "title": market.title, "window_start": market.window_start,
        "window_end": market.window_end, "tick_size": market.tick_size,
        "min_order_size": market.min_order_size, "neg_risk": market.neg_risk,
        "enable_order_book": market.enable_order_book,
        "accepting_orders": market.accepting_orders, "active": market.active,
        "closed": market.closed, "taker_fee_rate": market.taker_fee_rate,
        "maker_fee_rate": market.maker_fee_rate, "fee_type": market.fee_type,
        "resolution_source": market.resolution_source,
        "series_slug": market.series_slug,
        "tokens": {o.value: t.token_id for o, t in market.tokens.items()},
    }


def _market_from_dict(row: dict[str, Any]) -> Market:
    tokens = {
        Outcome(key): TokenInfo(value, Outcome(key), key.title())
        for key, value in row["tokens"].items()
    }
    return Market(
        market_id=row["market_id"], condition_id=row["condition_id"],
        question_id=row.get("question_id"), slug=row["slug"], asset=row["asset"],
        title=row.get("title", ""), window_start=row["window_start"],
        window_end=row["window_end"], tokens=tokens,
        tick_size=row.get("tick_size", 0.01),
        min_order_size=row.get("min_order_size", 5.0),
        neg_risk=row.get("neg_risk", False),
        enable_order_book=row.get("enable_order_book", True),
        accepting_orders=row.get("accepting_orders", True),
        active=row.get("active", True), closed=row.get("closed", False),
        taker_fee_rate=row.get("taker_fee_rate", 0.07),
        maker_fee_rate=row.get("maker_fee_rate", 0.0),
        fee_type=row.get("fee_type"),
        resolution_source=row.get("resolution_source"),
        series_slug=row.get("series_slug"),
    )


def _encode_payload(event: ReplayEvent) -> Any:
    if event.kind == "tick":
        tick: Tick = event.payload
        return {
            "exchange": tick.exchange, "symbol": tick.symbol, "asset": tick.asset,
            "price": tick.price, "size": tick.size, "timestamp": tick.timestamp,
            "bid": tick.bid, "ask": tick.ask, "is_trade": tick.is_trade,
        }
    if event.kind == "book":
        token_id, bids, asks, tick_size = event.payload
        return {
            "token_id": token_id, "tick_size": tick_size,
            "bids": [[lvl.price, lvl.size] for lvl in bids],
            "asks": [[lvl.price, lvl.size] for lvl in asks],
        }
    token_id, price, size, side = event.payload
    return {"token_id": token_id, "price": price, "size": size, "side": side}


def _decode_event(row: dict[str, Any]) -> ReplayEvent:
    kind = row["kind"]
    payload = row["payload"]
    if kind == "tick":
        return ReplayEvent(row["ts"], kind, Tick(
            exchange=payload["exchange"], symbol=payload["symbol"],
            asset=payload["asset"], price=payload["price"], size=payload["size"],
            timestamp=payload["timestamp"], received_at=row["ts"],
            bid=payload.get("bid"), ask=payload.get("ask"),
            is_trade=payload.get("is_trade", True),
        ))
    if kind == "book":
        return ReplayEvent(row["ts"], kind, (
            payload["token_id"],
            [PriceLevel(p, s) for p, s in payload["bids"]],
            [PriceLevel(p, s) for p, s in payload["asks"]],
            payload.get("tick_size", 0.01),
        ))
    return ReplayEvent(row["ts"], kind, (
        payload["token_id"], payload["price"], payload["size"], payload.get("side"),
    ))


# ------------------------------------------------------------------- synthetic


@dataclass
class SyntheticConfig:
    """Parameters of the simulated world.

    ``market_efficiency`` is the headline knob.  At 1.0 the simulated market
    maker uses the true volatility with no lag and no bias, so there is nothing
    to win; at 0.0 it is maximally wrong in the ways the fields below describe.
    """

    assets: Sequence[str] = ("BTC", "ETH", "SOL")
    start_prices: dict[str, float] = field(
        default_factory=lambda: {"BTC": 100_000.0, "ETH": 3_500.0, "SOL": 200.0}
    )
    annual_vol: dict[str, float] = field(
        default_factory=lambda: {"BTC": 0.50, "ETH": 0.65, "SOL": 0.90}
    )
    windows: int = 48
    window_seconds: int = 300
    tick_hz: float = 1.0
    exchanges: Sequence[str] = ("binance", "coinbase", "kraken", "okx", "bybit")
    exchange_noise_bps: float = 1.5
    start_time: float = 1_760_000_000.0

    market_efficiency: float = 0.55
    vol_bias: float = 1.30            # MM's volatility estimate / the truth
    quote_lag_seconds: float = 4.0    # how stale the MM's spot is
    quote_noise: float = 0.012        # additive noise on the MM's probability
    spread_ticks: int = 1
    top_depth_shares: float = 30.0
    deeper_depth_shares: float = 60.0
    trade_rate_per_min: float = 120.0
    tick_size: float = 0.01
    min_order_size: float = 5.0
    taker_fee_rate: float = 0.07
    #: occasional volatility bursts, so regimes actually differ
    burst_probability: float = 0.12
    burst_multiplier: float = 3.0
    seed: int = 20240101


def generate_synthetic_session(config: SyntheticConfig | None = None) -> ReplaySession:
    """Build a synthetic replay session (see the module docstring's caveat)."""
    cfg = config or SyntheticConfig()
    rng = np.random.default_rng(cfg.seed)
    pyrng = random.Random(cfg.seed)

    efficiency = min(max(cfg.market_efficiency, 0.0), 1.0)
    # At efficiency 1 the maker is perfect; at 0 it carries the full bias.
    vol_bias = 1.0 + (cfg.vol_bias - 1.0) * (1.0 - efficiency)
    lag = cfg.quote_lag_seconds * (1.0 - efficiency)
    noise_scale = cfg.quote_noise * (1.0 - efficiency)

    dt = 1.0 / cfg.tick_hz
    sec_per_year = 365.0 * 24.0 * 3600.0
    total_seconds = cfg.windows * cfg.window_seconds
    warmup = 600.0                       # so vol/strike estimators are primed
    start = floor_to_window(cfg.start_time, cfg.window_seconds) - warmup

    events: list[ReplayEvent] = []
    markets: list[Market] = []
    truth: dict[str, WindowTruth] = {}

    for asset in cfg.assets:
        sigma_annual = cfg.annual_vol.get(asset, 0.6)
        sigma = sigma_annual / math.sqrt(sec_per_year)
        n_steps = int((total_seconds + warmup) / dt) + 1

        # Price path with occasional volatility bursts.
        burst = np.ones(n_steps)
        i = 0
        while i < n_steps:
            if pyrng.random() < cfg.burst_probability / (60.0 / dt):
                length = int(pyrng.uniform(20, 120) / dt)
                burst[i : i + length] = cfg.burst_multiplier
                i += length
            else:
                i += 1
        shocks = rng.normal(0.0, 1.0, n_steps) * sigma * math.sqrt(dt) * burst
        log_path = np.cumsum(shocks)
        price_path = cfg.start_prices.get(asset, 1000.0) * np.exp(log_path)
        times = start + np.arange(n_steps) * dt

        # Reference-exchange ticks: each venue sees the truth plus its own noise.
        for step in range(n_steps):
            ts = float(times[step])
            truth_price = float(price_path[step])
            for exchange in cfg.exchanges:
                noise = rng.normal(0.0, cfg.exchange_noise_bps * 1e-4)
                observed = truth_price * (1.0 + noise)
                is_trade = pyrng.random() < 0.6
                size = abs(rng.normal(0.4, 0.3)) if is_trade else 0.0
                events.append(ReplayEvent(ts, "tick", Tick(
                    exchange=exchange, symbol=asset + "USDT", asset=asset,
                    price=observed, size=size, timestamp=ts, received_at=ts,
                    bid=observed * (1 - 1e-5), ask=observed * (1 + 1e-5),
                    is_trade=is_trade,
                )))

        def price_at(
            ts: float, _path=price_path, _n=n_steps, _start=start, _dt=dt
        ) -> float:
            # The loop variables are bound as defaults: this closure is only
            # ever used within its own iteration, and binding makes that
            # explicit rather than relying on it.
            index = int(round((ts - _start) / _dt))
            index = min(max(index, 0), _n - 1)
            return float(_path[index])

        # One market per 5-minute window.
        for w in range(cfg.windows):
            window_start = start + warmup + w * cfg.window_seconds
            window_end = window_start + cfg.window_seconds
            strike = price_at(window_start)
            settle = price_at(window_end)
            outcome = Outcome.UP if settle >= strike else Outcome.DOWN

            market_id = f"{asset.lower()}-syn-{int(window_start)}"
            up_token = f"{market_id}-UP"
            down_token = f"{market_id}-DOWN"
            market = Market(
                market_id=market_id,
                condition_id=f"0xsyn{abs(hash(market_id)) % (10 ** 30):030d}",
                question_id=None,
                slug=f"{asset.lower()}-updown-5m-{int(window_start)}",
                asset=asset,
                title=f"{asset} Up or Down (synthetic)",
                window_start=window_start, window_end=window_end,
                tokens={
                    Outcome.UP: TokenInfo(up_token, Outcome.UP, "Up"),
                    Outcome.DOWN: TokenInfo(down_token, Outcome.DOWN, "Down"),
                },
                tick_size=cfg.tick_size, min_order_size=cfg.min_order_size,
                neg_risk=False, enable_order_book=True, accepting_orders=True,
                active=True, closed=False,
                resolution_source="synthetic",
                taker_fee_rate=cfg.taker_fee_rate, maker_fee_rate=0.0,
                fee_type="synthetic", series_slug=f"{asset.lower()}-up-or-down-5m",
            )
            markets.append(market)
            truth[market_id] = WindowTruth(
                market_id=market_id, asset=asset, window_start=window_start,
                window_end=window_end, strike=strike, settle=settle, outcome=outcome,
            )

            # Market-maker quotes through the window.
            quote_times = np.arange(window_start, window_end, 1.0)
            for quote_ts in quote_times:
                lagged = price_at(float(quote_ts) - lag)
                remaining = window_end - float(quote_ts)
                mm_prob = fair_value(FairValueInputs(
                    spot=lagged, strike=strike, seconds_remaining=remaining,
                    sigma_per_sec=sigma * vol_bias, drift_per_sec=0.0,
                )).probability_up
                mm_prob += rng.normal(0.0, noise_scale) if noise_scale > 0 else 0.0
                mm_prob = min(max(mm_prob, 0.01), 0.99)

                half = cfg.spread_ticks * cfg.tick_size / 2.0
                up_bid = _floor_tick(mm_prob - half, cfg.tick_size)
                up_ask = _ceil_tick(mm_prob + half, cfg.tick_size)
                if up_ask <= up_bid:
                    up_ask = _ceil_tick(up_bid + cfg.tick_size, cfg.tick_size)

                for token_id, bid, ask in (
                    (up_token, up_bid, up_ask),
                    (down_token, _floor_tick(1 - up_ask, cfg.tick_size),
                     _ceil_tick(1 - up_bid, cfg.tick_size)),
                ):
                    bids, asks = _build_levels(
                        bid, ask, cfg, rng,
                    )
                    events.append(ReplayEvent(
                        float(quote_ts), "book",
                        (token_id, bids, asks, cfg.tick_size),
                    ))

                # Prints, so maker fills and the trade tape are populated.
                expected = cfg.trade_rate_per_min / 60.0
                for _ in range(rng.poisson(expected)):
                    side = "BUY" if pyrng.random() < 0.5 else "SELL"
                    price = up_ask if side == "BUY" else up_bid
                    size = abs(rng.normal(12.0, 8.0)) + 1.0
                    events.append(ReplayEvent(
                        float(quote_ts) + pyrng.random(), "trade",
                        (up_token, price, size, side),
                    ))

    return ReplaySession(
        markets=markets, events=events, truth=truth,
        label=f"synthetic-eff{efficiency:.2f}-seed{cfg.seed}",
        synthetic=True,
        meta={
            "market_efficiency": efficiency,
            "effective_vol_bias": vol_bias,
            "effective_quote_lag_s": lag,
            "effective_quote_noise": noise_scale,
            "seed": cfg.seed,
            "windows_per_asset": cfg.windows,
            "WARNING": (
                "Synthetic world. P&L here measures the engine, not real-market "
                "alpha: the mispricing was injected by the generator."
            ),
        },
    )


def _build_levels(bid: float, ask: float, cfg: SyntheticConfig, rng) -> tuple[list, list]:
    tick = cfg.tick_size
    bids: list[PriceLevel] = []
    asks: list[PriceLevel] = []
    for level in range(4):
        bid_price = round(bid - level * tick, 6)
        ask_price = round(ask + level * tick, 6)
        size = (
            cfg.top_depth_shares if level == 0
            else cfg.deeper_depth_shares * (1 + level)
        )
        size *= float(rng.uniform(0.6, 1.4))
        if 0.0 < bid_price < 1.0:
            bids.append(PriceLevel(bid_price, round(size, 2)))
        if 0.0 < ask_price < 1.0:
            asks.append(PriceLevel(ask_price, round(size, 2)))
    return bids, asks


def _floor_tick(value: float, tick: float) -> float:
    return round(max(math.floor(value / tick) * tick, tick), 6)


def _ceil_tick(value: float, tick: float) -> float:
    return round(min(math.ceil(value / tick) * tick, 1.0 - tick), 6)
