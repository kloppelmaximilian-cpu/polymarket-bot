"""Robust composite reference price.

No single venue may be able to move the bot's view of the world.  For each
asset we keep the newest observation per exchange, drop anything stale, reject
outliers by median-absolute-deviation, and combine the survivors with weights
that reflect feed health and observation recency.

The composite is also the series that feeds the volatility estimator and the
strike registry, so it keeps a bounded history per asset.
"""

from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field

from ..core.clock import Clock, default_clock, floor_to_window
from ..core.types import CompositePrice, Tick
from ..logging_setup import get_logger
from ..probability.vol import VolatilityEstimator, VolEstimate

MAD_TO_SIGMA = 1.4826          # consistency factor for a normal distribution


def _is_better_strike(candidate: StrikeRecord, existing: StrikeRecord) -> bool:
    """Higher quality wins; at equal quality, closer to the boundary wins."""
    if candidate.rank != existing.rank:
        return candidate.rank > existing.rank
    return candidate.offset < existing.offset


@dataclass
class ExchangeObservation:
    exchange: str
    price: float
    timestamp: float
    received_at: float
    bid: float | None = None
    ask: float | None = None
    is_trade: bool = True


#: Strike quality, best first.  A better observation always replaces a worse
#: one -- the bug this ordering prevents is a strike back-filled seconds before
#: the window opened being kept in preference to the exact snapshot taken at the
#: boundary itself.
STRIKE_QUALITY_RANK = {
    "exact": 3, "external": 2, "interpolated": 1, "stale": 0, "unknown": -1,
}


@dataclass
class StrikeRecord:
    """The reference price at a 5-minute window boundary."""

    window_start: float
    price: float
    quality: str           # "exact" | "external" | "interpolated" | "stale" | "unknown"
    observed_at: float
    n_sources: int = 0

    @property
    def is_usable(self) -> bool:
        return self.quality in ("exact", "external", "interpolated") and self.price > 0

    @property
    def rank(self) -> int:
        return STRIKE_QUALITY_RANK.get(self.quality, -1)

    @property
    def offset(self) -> float:
        """How far from the boundary the observation was taken, in seconds."""
        return abs(self.observed_at - self.window_start) if self.observed_at else float("inf")


@dataclass
class AssetState:
    asset: str
    observations: dict[str, ExchangeObservation] = field(default_factory=dict)
    history: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=3600))
    vol: VolatilityEstimator = field(default_factory=VolatilityEstimator)
    strikes: dict[float, StrikeRecord] = field(default_factory=dict)
    last_composite: CompositePrice | None = None
    trade_flow: deque[tuple[float, float, float]] = field(
        default_factory=lambda: deque(maxlen=2000)
    )  # (ts, signed_size, price)


class CompositePriceEngine:
    """Aggregates per-exchange ticks into one trustworthy price per asset."""

    def __init__(
        self,
        assets: list[str],
        stale_seconds: float = 3.0,
        min_sources: int = 2,
        divergence_bps: float = 25.0,
        mad_threshold: float = 4.0,
        window_seconds: int = 300,
        clock: Clock | None = None,
        history_seconds: int = 3600,
    ):
        self.clock = clock or default_clock()
        self.stale_seconds = stale_seconds
        self.min_sources = min_sources
        self.divergence_bps = divergence_bps
        self.mad_threshold = mad_threshold
        self.window_seconds = window_seconds
        self.log = get_logger("pmbot.composite")
        self._health_scores: dict[str, float] = {}
        self.states: dict[str, AssetState] = {
            a.upper(): AssetState(
                asset=a.upper(),
                history=deque(maxlen=history_seconds * 4),
            )
            for a in assets
        }

    # ------------------------------------------------------------- ingestion
    def set_health(self, exchange: str, score: float) -> None:
        """Feed health scores are injected by the runner each cycle."""
        self._health_scores[exchange] = max(0.0, min(1.0, score))

    def on_tick(self, tick: Tick) -> None:
        state = self.states.get(tick.asset)
        if state is None:
            return
        prev = state.observations.get(tick.exchange)
        # Keep the newest observation only; ignore out-of-order arrivals.
        if prev is not None and tick.received_at < prev.received_at:
            return
        state.observations[tick.exchange] = ExchangeObservation(
            exchange=tick.exchange,
            price=tick.price,
            timestamp=tick.timestamp,
            received_at=tick.received_at,
            bid=tick.bid,
            ask=tick.ask,
            is_trade=tick.is_trade,
        )
        if tick.is_trade and tick.size > 0:
            signed = tick.size
            if tick.bid is not None and tick.ask is not None:
                mid = (tick.bid + tick.ask) / 2.0
                signed = tick.size if tick.price >= mid else -tick.size
            state.trade_flow.append((tick.received_at, signed, tick.price))

    # ------------------------------------------------------------ composite
    def compute(self, asset: str, now: float | None = None) -> CompositePrice | None:
        state = self.states.get(asset.upper())
        if state is None:
            return None
        now = self.clock.time() if now is None else now

        fresh = [
            obs for obs in state.observations.values()
            if now - obs.received_at <= self.stale_seconds
        ]
        if not fresh:
            comp = CompositePrice(
                asset=state.asset, price=0.0, timestamp=now, contributors={},
                n_sources=0, dispersion_bps=0.0, is_healthy=False,
                reason="no fresh observations",
            )
            state.last_composite = comp
            return comp

        prices = [o.price for o in fresh]
        median = statistics.median(prices)

        # MAD-based outlier rejection; with <3 sources there is nothing robust
        # to reject against, so we keep everything and let dispersion flag it.
        survivors = fresh
        if len(fresh) >= 3:
            deviations = [abs(p - median) for p in prices]
            mad = statistics.median(deviations) * MAD_TO_SIGMA
            if mad > 0:
                limit = self.mad_threshold * mad
                kept = [o for o in fresh if abs(o.price - median) <= limit]
                if len(kept) >= max(2, self.min_sources):
                    survivors = kept

        weights: dict[str, float] = {}
        total_weight = 0.0
        weighted_sum = 0.0
        for obs in survivors:
            health = self._health_scores.get(obs.exchange, 1.0)
            age = max(now - obs.received_at, 0.0)
            recency = math.exp(-age / max(self.stale_seconds, 1e-9))
            # Book updates are a cleaner price signal than a single print.
            kind = 1.0 if not obs.is_trade else 0.85
            w = max(health * recency * kind, 1e-6)
            weights[obs.exchange] = w
            total_weight += w
            weighted_sum += w * obs.price

        price = weighted_sum / total_weight if total_weight > 0 else median
        surv_prices = [o.price for o in survivors]
        spread = (max(surv_prices) - min(surv_prices)) if len(surv_prices) > 1 else 0.0
        dispersion_bps = (spread / price * 1e4) if price > 0 else 0.0

        n = len(survivors)
        healthy = n >= self.min_sources and dispersion_bps <= self.divergence_bps
        reason = ""
        if n < self.min_sources:
            reason = f"only {n} healthy source(s), need {self.min_sources}"
        elif dispersion_bps > self.divergence_bps:
            reason = f"cross-exchange divergence {dispersion_bps:.1f}bps"

        comp = CompositePrice(
            asset=state.asset,
            price=price,
            timestamp=now,
            contributors={e: round(w / total_weight, 4) for e, w in weights.items()}
            if total_weight > 0 else {},
            n_sources=n,
            dispersion_bps=dispersion_bps,
            is_healthy=healthy,
            reason=reason,
        )
        state.last_composite = comp

        if price > 0:
            state.history.append((now, price))
            state.vol.update(now, price)
            self._maybe_record_strike(state, now, price, n)
        return comp

    def compute_all(self, now: float | None = None) -> dict[str, CompositePrice]:
        now = self.clock.time() if now is None else now
        return {
            asset: comp
            for asset in self.states
            if (comp := self.compute(asset, now)) is not None
        }

    # --------------------------------------------------------------- strikes
    def _maybe_record_strike(
        self, state: AssetState, now: float, price: float, n_sources: int
    ) -> None:
        """Snapshot the reference price at each 5-minute grid boundary.

        A 5-minute up/down market is struck at the reference price when its
        window opens, so the bot must capture that instant.  ``exact`` means a
        fresh composite within one second of the boundary.

        Crucially this *upgrades* an existing lower-quality record.  Without
        that, a strike back-filled while the market was still being watched
        pre-open would be kept forever, leaving the strike several seconds
        stale -- worth a couple of basis points, which on a five-minute window
        is a sizeable fraction of the whole move.
        """
        window = floor_to_window(now, self.window_seconds)
        offset = now - window
        if offset <= 1.0:
            quality = "exact"
        elif offset <= 5.0:
            quality = "interpolated"
        else:
            return  # too late to claim we know the strike for this window

        candidate = StrikeRecord(
            window_start=window, price=price, quality=quality,
            observed_at=now, n_sources=n_sources,
        )
        existing = state.strikes.get(window)
        if existing is not None and not _is_better_strike(candidate, existing):
            return
        state.strikes[window] = candidate
        # Bound memory: keep the most recent 48 windows (4 hours).
        if len(state.strikes) > 48:
            for key in sorted(state.strikes)[:-48]:
                del state.strikes[key]

    def strike_for(
        self, asset: str, window_start: float, now: float | None = None
    ) -> StrikeRecord:
        """Best available strike for a window, back-filled from history.

        ``now`` guards against inventing a strike for a window that has not
        opened yet: a market watched before its open has no strike, and
        pretending otherwise silently pins it to a pre-open price.
        """
        state = self.states.get(asset.upper())
        window_start = float(int(window_start))
        if state is None:
            return StrikeRecord(window_start, 0.0, "unknown", 0.0)

        now = self.clock.time() if now is None else now
        if now < window_start:
            # The window has not opened; there is nothing to snapshot yet.
            return StrikeRecord(window_start, 0.0, "unknown", 0.0)

        record = state.strikes.get(window_start)
        if record is not None and record.quality == "exact":
            return record

        # Back-fill from the price history: the last observation at or before
        # the boundary, provided it is close enough to be meaningful.
        best: tuple[float, float] | None = None
        for ts, price in reversed(state.history):
            if ts <= window_start:
                best = (ts, price)
                break
        if best is not None and window_start - best[0] <= 5.0:
            candidate = StrikeRecord(
                window_start=window_start, price=best[1], quality="interpolated",
                observed_at=best[0], n_sources=0,
            )
            if record is None or _is_better_strike(candidate, record):
                state.strikes[window_start] = candidate
                return candidate

        if record is not None:
            return record
        return StrikeRecord(window_start, 0.0, "unknown", 0.0)

    def seed_strike(
        self, asset: str, window_start: float, price: float, quality: str = "external"
    ) -> None:
        """Inject a strike from an external source (oracle or historical data)."""
        state = self.states.get(asset.upper())
        if state is None or price <= 0:
            return
        state.strikes[float(int(window_start))] = StrikeRecord(
            window_start=float(int(window_start)),
            price=float(price),
            quality=quality,
            observed_at=self.clock.time(),
        )

    # -------------------------------------------------------------- queries
    def volatility(self, asset: str) -> VolEstimate:
        state = self.states.get(asset.upper())
        if state is None:
            return VolatilityEstimator().estimate()
        return state.vol.estimate()

    def price(self, asset: str) -> float | None:
        state = self.states.get(asset.upper())
        if state is None or state.last_composite is None:
            return None
        return state.last_composite.price or None

    def price_as_of(self, asset: str, now: float) -> tuple[float | None, float]:
        """The composite price as it stood at or before ``now``.

        Returns ``(price, observed_at)``.  This is what makes the feature engine
        structurally safe against look-ahead: it asks for the price *as of* a
        time rather than for "the latest", so a caller that has already ingested
        later data cannot accidentally be handed the future.
        """
        state = self.states.get(asset.upper())
        if state is None:
            return None, 0.0
        composite = state.last_composite
        if composite is not None and composite.timestamp <= now + 1e-9:
            return (composite.price or None), composite.timestamp
        for ts, price in reversed(state.history):
            if ts <= now + 1e-9:
                return price, ts
        return None, 0.0

    def history(self, asset: str, seconds: float, now: float | None = None):
        state = self.states.get(asset.upper())
        if state is None:
            return []
        now = self.clock.time() if now is None else now
        cutoff = now - seconds
        return [(t, p) for t, p in state.history if t >= cutoff]

    def per_exchange_prices(self, asset: str) -> dict[str, float]:
        state = self.states.get(asset.upper())
        if state is None:
            return {}
        return {o.exchange: o.price for o in state.observations.values()}

    def trade_flow(self, asset: str, seconds: float, now: float | None = None):
        state = self.states.get(asset.upper())
        if state is None:
            return []
        now = self.clock.time() if now is None else now
        cutoff = now - seconds
        return [(t, s, p) for t, s, p in state.trade_flow if t >= cutoff]
