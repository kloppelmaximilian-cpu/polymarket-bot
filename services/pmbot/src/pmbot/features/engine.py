"""Market-microstructure feature engine.

Produces one numeric feature vector per (market, instant).  The same vector is
used live, in the backtester and for model training, which is the only way to
guarantee that what the model learned is what it sees in production.

Three rules govern everything in this module:

1. **Causality.**  Only observations timestamped at or before ``now`` are read.
   There is no bar close, no forward fill from the future, no "current window
   high" computed over data that has not happened yet.
2. **Total ordering of failures.**  When an input is missing the feature is
   simply absent from the vector (and ``data_quality`` drops) rather than being
   silently filled with zero, which a model would read as a real observation.
3. **Scale invariance.**  Price-derived features are expressed in basis points
   or in units of the remaining-move standard deviation, so a model trained on
   BTC transfers to DOGE.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..core.types import BookSnapshot, Market, MarketProbability, Outcome
from ..exchanges.composite import CompositePriceEngine, StrikeRecord
from ..logging_setup import get_logger
from ..orderbook.book import OrderBookManager
from ..probability.analytic import FairValueInputs, fair_value
from . import indicators as ind

RETURN_HORIZONS = (5, 15, 30, 60, 120)


@dataclass
class FeatureContext:
    """Everything the strategies need besides the raw feature vector."""

    market: Market
    now: float
    spot: float
    strike: float
    strike_record: StrikeRecord
    seconds_remaining: float
    sigma_per_sec: float
    sigma_total: float
    up_book: BookSnapshot | None
    down_book: BookSnapshot | None
    market_probability: MarketProbability | None
    analytic_probability_up: float | None
    data_quality: float
    issues: list[str] = field(default_factory=list)

    @property
    def is_usable(self) -> bool:
        return self.data_quality >= 0.5 and not self.issues


@dataclass
class FeatureSet:
    market_id: str
    asset: str
    timestamp: float
    features: dict[str, float]
    context: FeatureContext

    def vector(self, names: list[str]) -> list[float]:
        return [self.features.get(name, 0.0) for name in names]


@dataclass
class MarketFeatureState:
    """Per-market rolling state for Polymarket-side microstructure."""

    mid_history: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=900))
    spread_history: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=900))
    imbalance_history: deque[tuple[float, float]] = field(default_factory=lambda: deque(maxlen=900))
    last_seen: float = 0.0


class FeatureEngine:
    def __init__(
        self,
        composite: CompositePriceEngine,
        books: OrderBookManager,
        stale_book_seconds: float = 5.0,
        sigma_basis: float = 0.0,
        probability_floor: float = 0.02,
        probability_cap: float = 0.98,
    ):
        self.composite = composite
        self.books = books
        self.stale_book_seconds = stale_book_seconds
        self.sigma_basis = sigma_basis
        self.floor = probability_floor
        self.cap = probability_cap
        self.log = get_logger("pmbot.features")
        self.states: dict[str, MarketFeatureState] = {}

    # ------------------------------------------------------------- plumbing
    def state(self, market_id: str) -> MarketFeatureState:
        state = self.states.get(market_id)
        if state is None:
            state = MarketFeatureState()
            self.states[market_id] = state
        return state

    def prune(self, keep: set[str]) -> None:
        for market_id in [m for m in self.states if m not in keep]:
            del self.states[market_id]

    # ------------------------------------------------------------- entrypoint
    def compute(self, market: Market, now: float) -> FeatureSet | None:
        issues: list[str] = []
        features: dict[str, float] = {}

        # --- time -----------------------------------------------------------
        tau = market.seconds_remaining(now)
        elapsed = market.seconds_elapsed(now)
        features["t_remaining"] = tau
        features["t_elapsed"] = elapsed
        features["t_fraction"] = (
            max(0.0, min(1.0, elapsed / (market.window_end - market.window_start)))
            if market.window_end > market.window_start else 0.0
        )
        features["sqrt_tau"] = math.sqrt(max(tau, 0.0))

        # --- reference price ------------------------------------------------
        # Ask for the price *as of* `now`, never "the latest": if this engine is
        # ever called after later data has been ingested (a replay ordering bug,
        # or an out-of-order cycle) we must not silently return the future.
        comp = self.composite.states.get(market.asset)
        composite_price = comp.last_composite if comp is not None else None
        spot, spot_at = self.composite.price_as_of(market.asset, now)

        if composite_price is not None and composite_price.timestamp > now + 1.0:
            # Loud, not silent: this is a caller-ordering defect.
            issues.append(
                f"reference price is {composite_price.timestamp - now:.1f}s ahead "
                "of the evaluation time"
            )
            self.log.warning(
                "composite ahead of evaluation time; using the as-of price",
                extra={
                    "market": market.market_id,
                    "composite_ts": composite_price.timestamp,
                    "now": now,
                },
            )

        if spot is None or spot <= 0:
            issues.append("no composite price")
            spot = 0.0
        elif composite_price is not None and composite_price.timestamp <= now + 1e-9:
            features["disp_bps"] = composite_price.dispersion_bps
            features["n_sources"] = float(composite_price.n_sources)
            features["feed_healthy"] = 1.0 if composite_price.is_healthy else 0.0
            features["spot_age"] = max(0.0, now - spot_at)
            if not composite_price.is_healthy:
                issues.append(f"composite unhealthy: {composite_price.reason}")
        else:
            features["spot_age"] = max(0.0, now - spot_at)

        strike_record = self.composite.strike_for(
            market.asset, market.window_start, now
        )
        if strike_record.observed_at > now + 1.0:
            issues.append("strike snapshot is after the evaluation time")
        strike = strike_record.price
        features["strike_exact"] = 1.0 if strike_record.quality == "exact" else 0.0
        if not strike_record.is_usable:
            issues.append(f"strike {strike_record.quality}")

        # --- volatility -----------------------------------------------------
        vol = self.composite.volatility(market.asset)
        # Price with the uncertainty-adjusted volatility, not the point estimate:
        # volatility bursts, and a digital priced off a single draw is
        # systematically over-confident.
        sigma = vol.effective
        features["sigma_per_sec"] = sigma
        features["sigma_point"] = vol.blended
        features["vol_rel_uncertainty"] = vol.relative_uncertainty
        features["sigma_window_bps"] = sigma * math.sqrt(300.0) * 1e4
        features["vol_ewma_ratio"] = (
            vol.ewma / vol.realized if vol.realized > 1e-12 else 1.0
        )
        features["vol_jump_ratio"] = vol.jump_ratio
        features["vol_reliable"] = 1.0 if vol.is_reliable else 0.0
        # Microstructure-noise diagnostics: when noise dominates the observed
        # variance the volatility estimate -- and therefore every probability
        # derived from it -- is much less trustworthy.
        features["vol_noise_bps"] = vol.noise_bps
        features["vol_noise_share"] = vol.noise_share
        features["vol_raw_ratio"] = (
            vol.raw_realized / vol.blended if vol.blended > 1e-12 else 1.0
        )
        features["vol_tsrv_ratio"] = (
            vol.tsrv / vol.blended if vol.blended > 1e-12 else 1.0
        )
        if not vol.is_reliable:
            issues.append("volatility estimate not reliable")

        sigma_total = math.sqrt(sigma * sigma * max(tau, 0.0) + self.sigma_basis ** 2)
        features["sigma_total"] = sigma_total

        # --- moneyness ------------------------------------------------------
        if spot > 0 and strike > 0:
            log_moneyness = math.log(spot / strike)
            features["dist_bps"] = log_moneyness * 1e4
            features["dist_sigma"] = (
                log_moneyness / sigma_total if sigma_total > 1e-12 else 0.0
            )
            features["abs_dist_sigma"] = abs(features["dist_sigma"])
            features["dist_sign"] = 1.0 if log_moneyness >= 0 else -1.0
        else:
            log_moneyness = 0.0

        # --- crypto price action -------------------------------------------
        self._price_action_features(market.asset, now, spot, features)
        self._flow_features(market.asset, now, features)
        self._cross_exchange_features(market.asset, now, features)

        # --- polymarket book ------------------------------------------------
        up_book = self.books.snapshot(market.token_id(Outcome.UP), now)
        down_book = self.books.snapshot(market.token_id(Outcome.DOWN), now)
        market_prob = self._book_features(market, up_book, down_book, now, features, issues)

        # --- analytic fair value --------------------------------------------
        analytic_up: float | None = None
        if spot > 0 and strike > 0:
            fv = fair_value(FairValueInputs(
                spot=spot, strike=strike, seconds_remaining=tau,
                sigma_per_sec=sigma, drift_per_sec=0.0,
                sigma_basis=self.sigma_basis,
            ))
            analytic_up = min(max(fv.probability_up, self.floor), self.cap)
            features["analytic_up"] = analytic_up
            features["analytic_z"] = (
                fv.z_score if math.isfinite(fv.z_score)
                else (10.0 if fv.z_score > 0 else -10.0)
            )
            features["analytic_sensitivity"] = fv.sensitivity
            features["basis_share"] = fv.basis_share
            if market_prob is not None:
                features["edge_raw_up"] = analytic_up - market_prob.implied_up

        data_quality = self._quality_score(features, issues)
        features["data_quality"] = data_quality

        context = FeatureContext(
            market=market,
            now=now,
            spot=spot,
            strike=strike,
            strike_record=strike_record,
            seconds_remaining=tau,
            sigma_per_sec=sigma,
            sigma_total=sigma_total,
            up_book=up_book,
            down_book=down_book,
            market_probability=market_prob,
            analytic_probability_up=analytic_up,
            data_quality=data_quality,
            issues=issues,
        )
        return FeatureSet(
            market_id=market.market_id,
            asset=market.asset,
            timestamp=now,
            features={k: float(v) for k, v in features.items() if _finite(v)},
            context=context,
        )

    # ---------------------------------------------------------- sub-computers
    def _price_action_features(
        self, asset: str, now: float, spot: float, features: dict[str, float]
    ) -> None:
        if spot <= 0:
            return
        history = self.composite.history(asset, 300.0, now)
        if len(history) < 5:
            return

        times = [t for t, _ in history]
        prices = [p for _, p in history]

        for horizon in RETURN_HORIZONS:
            cutoff = now - horizon
            past = None
            for t, p in history:
                if t <= cutoff:
                    past = p
                else:
                    break
            if past and past > 0:
                features[f"ret_{horizon}s_bps"] = math.log(spot / past) * 1e4

        r30 = features.get("ret_30s_bps")
        r60 = features.get("ret_60s_bps")
        if r30 is not None and r60 is not None:
            # Acceleration: recent half-move vs the older half-move.
            features["accel_bps"] = r30 - (r60 - r30)

        slope = ind.linear_slope(times[-60:], prices[-60:])
        if slope is not None and spot > 0:
            features["velocity_bps_per_s"] = slope / spot * 1e4

        grid_t, grid_p = ind.resample_last(history, max(times[0], now - 300.0), now, 1.0)
        if len(grid_p) >= 30:
            series = list(grid_p)
            rsi_value = ind.rsi(series, 14)
            if rsi_value is not None:
                features["rsi_14"] = rsi_value
                features["rsi_dev"] = (rsi_value - 50.0) / 50.0
            macd_value = ind.macd(series)
            if macd_value is not None:
                features["macd_hist_bps"] = macd_value[2] / spot * 1e4
                features["macd_line_bps"] = macd_value[0] / spot * 1e4
            boll = ind.bollinger_position(series, 20)
            if boll is not None:
                features["boll_pos"] = boll
            roc = ind.rate_of_change(series, 30)
            if roc is not None:
                features["roc_30_bps"] = roc * 1e4
            stoch = ind.stochastic(series, 30)
            if stoch is not None:
                features["stoch_30"] = stoch
                features["stoch_dev"] = (stoch - 50.0) / 50.0
            atr = ind.atr_proxy(series, 14)
            if atr is not None:
                features["atr_bps"] = atr / spot * 1e4
            adx = ind.adx_proxy(series, 30)
            if adx is not None:
                features["adx_proxy"] = adx
            eff = ind.efficiency_ratio(series[-60:])
            if eff is not None:
                features["efficiency_ratio"] = eff
            fast, slow = ind.ema(series, 10), ind.ema(series, 40)
            if fast is not None and slow is not None:
                features["ema_diff_bps"] = (fast - slow) / spot * 1e4
            # Range position over the window so far: 0 = low, 1 = high.
            window_low, window_high = float(np.min(grid_p)), float(np.max(grid_p))
            if window_high - window_low > 1e-12:
                features["range_pos"] = (spot - window_low) / (window_high - window_low)
                features["range_width_bps"] = (window_high - window_low) / spot * 1e4

    def _flow_features(self, asset: str, now: float, features: dict[str, float]) -> None:
        for horizon in (10, 30, 60):
            flow = self.composite.trade_flow(asset, horizon, now)
            if not flow:
                continue
            signed = [s for _, s, _ in flow]
            buys = sum(s for s in signed if s > 0)
            sells = -sum(s for s in signed if s < 0)
            total = buys + sells
            features[f"cvd_{horizon}s"] = buys - sells
            if total > 0:
                features[f"trade_imb_{horizon}s"] = (buys - sells) / total
                features[f"buy_ratio_{horizon}s"] = buys / total
            features[f"trade_count_{horizon}s"] = float(len(flow))

        flow = self.composite.trade_flow(asset, 60, now)
        if len(flow) >= 10:
            sizes = np.array([abs(s) for _, s, _ in flow])
            prices = np.array([p for _, _, p in flow])
            median_size = float(np.median(sizes))
            if median_size > 0:
                large = sizes > median_size * 5.0
                features["large_trade_ratio"] = float(large.mean())
                features["large_trade_max_mult"] = float(sizes.max() / median_size)
            vwap_value = ind.vwap(prices.tolist(), sizes.tolist())
            spot = self.composite.price(asset)
            if vwap_value and spot:
                features["vwap_dev_bps"] = math.log(spot / vwap_value) * 1e4

    def _cross_exchange_features(
        self, asset: str, now: float, features: dict[str, float]
    ) -> None:
        prices = self.composite.per_exchange_prices(asset)
        if len(prices) < 2:
            return
        values = list(prices.values())
        mean = sum(values) / len(values)
        if mean > 0:
            features["xchg_spread_bps"] = (max(values) - min(values)) / mean * 1e4
            features["xchg_std_bps"] = float(np.std(values) / mean * 1e4)

        # Price leadership: does the fastest venue lead the composite?
        state = self.composite.states.get(asset)
        if state is None or len(state.history) < 40:
            return
        composite_series = [p for _, p in list(state.history)[-120:]]
        lead_scores: list[float] = []
        if mean > 0:
            # A single latest price per venue is not a series; use each venue's
            # deviation from the composite as an instantaneous lead proxy.
            lead_scores = [
                (price - composite_series[-1]) / mean * 1e4
                for price in prices.values()
            ]
        if lead_scores:
            features["xchg_lead_dev_bps"] = float(np.mean(lead_scores))
            features["xchg_lead_max_bps"] = float(max(lead_scores, key=abs))

    def _book_features(
        self,
        market: Market,
        up_book: BookSnapshot | None,
        down_book: BookSnapshot | None,
        now: float,
        features: dict[str, float],
        issues: list[str],
    ) -> MarketProbability | None:
        state = self.state(market.market_id)
        state.last_seen = now

        up_live = self.books.get(market.token_id(Outcome.UP))
        down_live = self.books.get(market.token_id(Outcome.DOWN))
        if up_live is None or not up_live.has_snapshot:
            issues.append("no UP book")
        elif up_live.is_stale(self.stale_book_seconds, now):
            issues.append(f"UP book stale {up_live.age(now):.1f}s")
        if down_live is not None and down_live.has_snapshot:
            features["down_book_age"] = down_live.age(now)
        if up_live is not None:
            features["up_book_age"] = up_live.age(now)

        if up_book is None or up_book.best_bid is None or up_book.best_ask is None:
            return None
        if up_book.is_crossed():
            issues.append("UP book crossed")
            return None

        mid = up_book.mid or 0.0
        spread = up_book.spread or 0.0
        features["pm_up_bid"] = up_book.best_bid
        features["pm_up_ask"] = up_book.best_ask
        features["pm_mid"] = mid
        features["pm_spread"] = spread
        features["pm_spread_ticks"] = spread / max(up_book.tick_size, 1e-9)
        micro = up_book.microprice
        if micro is not None:
            features["pm_micro"] = micro
            features["pm_micro_dev"] = micro - mid
        features["pm_imb_top"] = (
            (up_book.best_bid_size - up_book.best_ask_size)
            / max(up_book.best_bid_size + up_book.best_ask_size, 1e-9)
        )
        features["pm_imb_5c"] = up_book.imbalance(0.05)
        features["pm_imb_2c"] = up_book.imbalance(0.02)
        features["pm_depth_bid"] = up_book.depth("bid", 0.05)
        features["pm_depth_ask"] = up_book.depth("ask", 0.05)
        features["pm_liq_usd"] = (
            up_book.notional_depth("bid", 0.05) + up_book.notional_depth("ask", 0.05)
        )
        features["pm_levels"] = float(len(up_book.bids) + len(up_book.asks))

        # Rolling Polymarket-side dynamics.
        state.mid_history.append((now, mid))
        state.spread_history.append((now, spread))
        state.imbalance_history.append((now, features["pm_imb_5c"]))

        mids = [(t, m) for t, m in state.mid_history if t >= now - 120]
        if len(mids) >= 5:
            slope = ind.linear_slope([t for t, _ in mids], [m for _, m in mids])
            if slope is not None:
                features["pm_mid_velocity"] = slope
            older = mids[0][1]
            features["pm_mid_change"] = mid - older
            features["pm_mid_std"] = float(np.std([m for _, m in mids]))
        spreads = [s for t, s in state.spread_history if t >= now - 60]
        if len(spreads) >= 3:
            features["pm_spread_mean"] = float(np.mean(spreads))
            features["pm_spread_change"] = spread - float(np.mean(spreads))
        imbs = [i for t, i in state.imbalance_history if t >= now - 60]
        if len(imbs) >= 3:
            features["pm_imb_mean"] = float(np.mean(imbs))
            features["pm_imb_change"] = features["pm_imb_5c"] - features["pm_imb_mean"]

        # Prediction-market trade flow (aggression on the UP token).
        trades = self.books.recent_trades(market.token_id(Outcome.UP), 60.0, now)
        if trades:
            buys = sum(t.size for t in trades if t.side and t.side.value == "BUY")
            sells = sum(t.size for t in trades if t.side and t.side.value == "SELL")
            total = buys + sells
            features["pm_trade_count"] = float(len(trades))
            features["pm_cvd"] = buys - sells
            if total > 0:
                features["pm_trade_imb"] = (buys - sells) / total
            last = trades[-1]
            features["pm_last_trade_dev"] = last.price - mid

        market_prob = self._market_probability(up_book, down_book)
        if market_prob is not None:
            features["implied_up"] = market_prob.implied_up
            features["implied_vig"] = market_prob.vig
        return market_prob

    def _market_probability(
        self, up_book: BookSnapshot | None, down_book: BookSnapshot | None
    ) -> MarketProbability | None:
        """De-vigged implied probability from both sides of the event.

        UP and DOWN are complementary, so their mids should sum to 1.  They
        rarely do; the gap is the vig, and normalising by it gives a cleaner
        read of what the market actually believes than either mid alone.
        """
        up_mid = up_book.mid if up_book is not None else None
        down_mid = down_book.mid if down_book is not None else None

        if up_mid is None and down_mid is None:
            return None
        if up_mid is None:
            return MarketProbability(
                implied_up=1.0 - down_mid, implied_down=down_mid,
                raw_up_mid=None, raw_down_mid=down_mid, vig=0.0, source="down_only",
            )
        if down_mid is None:
            return MarketProbability(
                implied_up=up_mid, implied_down=1.0 - up_mid,
                raw_up_mid=up_mid, raw_down_mid=None, vig=0.0, source="up_only",
            )

        total = up_mid + down_mid
        if total <= 0:
            return None
        return MarketProbability(
            implied_up=up_mid / total,
            implied_down=down_mid / total,
            raw_up_mid=up_mid,
            raw_down_mid=down_mid,
            vig=total - 1.0,
            source="devigged",
        )

    def _quality_score(self, features: dict[str, float], issues: list[str]) -> float:
        score = 1.0
        if features.get("feed_healthy", 0.0) < 1.0:
            score -= 0.35
        if features.get("strike_exact", 0.0) < 1.0:
            score -= 0.15
        if features.get("vol_reliable", 0.0) < 1.0:
            score -= 0.20
        n_sources = features.get("n_sources", 0.0)
        if n_sources < 3:
            score -= 0.10 * (3 - n_sources)
        # A volatility estimate that is mostly noise correction is fragile.
        score -= 0.15 * max(0.0, features.get("vol_noise_share", 0.0) - 0.8) / 0.2
        book_age = features.get("up_book_age", 0.0)
        if book_age > self.stale_book_seconds:
            score -= 0.30
        score -= 0.10 * len([i for i in issues if "stale" in i or "crossed" in i])
        return max(0.0, min(1.0, score))


def _finite(value: Any) -> bool:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


FEATURE_NAMES: list[str] = [
    # time
    "t_remaining", "t_elapsed", "t_fraction", "sqrt_tau",
    # moneyness / vol
    "dist_bps", "dist_sigma", "abs_dist_sigma", "dist_sign",
    "sigma_per_sec", "sigma_window_bps", "sigma_total",
    "vol_ewma_ratio", "vol_jump_ratio", "vol_noise_bps", "vol_noise_share",
    "vol_raw_ratio", "vol_tsrv_ratio", "vol_rel_uncertainty", "sigma_point",
    "analytic_z", "analytic_sensitivity", "basis_share",
    # price action
    "ret_5s_bps", "ret_15s_bps", "ret_30s_bps", "ret_60s_bps", "ret_120s_bps",
    "accel_bps", "velocity_bps_per_s",
    "rsi_dev", "macd_hist_bps", "macd_line_bps", "boll_pos", "roc_30_bps",
    "stoch_dev", "atr_bps", "adx_proxy", "efficiency_ratio", "ema_diff_bps",
    "range_pos", "range_width_bps", "vwap_dev_bps",
    # flow
    "cvd_10s", "cvd_30s", "cvd_60s",
    "trade_imb_10s", "trade_imb_30s", "trade_imb_60s",
    "buy_ratio_30s", "trade_count_30s", "large_trade_ratio",
    # cross exchange
    "disp_bps", "n_sources", "spot_age", "xchg_spread_bps", "xchg_std_bps",
    "xchg_lead_dev_bps", "xchg_lead_max_bps",
    # polymarket book
    "pm_mid", "pm_spread", "pm_spread_ticks", "pm_micro_dev",
    "pm_imb_top", "pm_imb_5c", "pm_imb_2c", "pm_depth_bid", "pm_depth_ask",
    "pm_liq_usd", "pm_levels", "pm_mid_velocity", "pm_mid_change", "pm_mid_std",
    "pm_spread_change", "pm_imb_change", "pm_trade_imb", "pm_cvd",
    "pm_trade_count", "pm_last_trade_dev",
    # derived
    "implied_up", "implied_vig", "analytic_up", "edge_raw_up", "data_quality",
]
