"""Regime detection.

The meta-controller needs to know *what kind of market this is right now*
before it decides which strategies to listen to.  Detection is deliberately
rule-based and readable rather than a clustering model: with five-minute
windows there is no time to accumulate enough in-regime samples to fit
something opaque, and an unexplainable regime flip is an operational hazard.

Ordering matters -- the checks run from "something is wrong" to "the market is
ordinary", so a liquidity shock is never mislabelled as a trend.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..core.types import Regime
from ..features.engine import FeatureSet


@dataclass
class RegimeConfig:
    high_vol_ratio: float = 1.6       # realised vs its own recent baseline
    low_vol_ratio: float = 0.6
    abnormal_vol_ratio: float = 2.8
    jump_ratio: float = 1.8           # realised / bipower -> jumps present
    trend_efficiency: float = 0.45
    range_efficiency: float = 0.22
    divergence_bps_multiple: float = 0.8
    liquidity_floor_usd: float = 120.0
    spread_shock_ticks: float = 4.0


@dataclass
class RegimeState:
    regime: Regime = Regime.RANGING
    confidence: float = 0.0
    detail: str = ""
    scores: dict[str, float] = field(default_factory=dict)

    @property
    def is_tradable(self) -> bool:
        """Regimes in which taking risk is defensible at all."""
        return self.regime not in (
            Regime.UNSTABLE, Regime.LIQUIDITY_SHOCK, Regime.ABNORMAL_VOL,
        )


class RegimeDetector:
    """Classifies the current state of one market."""

    def __init__(self, config: RegimeConfig | None = None, vol_baseline_halflife: float = 900.0):
        self.config = config or RegimeConfig()
        self._vol_baseline: dict[str, float] = {}
        self._halflife = vol_baseline_halflife

    def _baseline_ratio(self, asset: str, sigma: float) -> float:
        """Current volatility against its own slow-moving baseline."""
        previous = self._vol_baseline.get(asset)
        if previous is None or previous <= 0:
            self._vol_baseline[asset] = sigma
            return 1.0
        ratio = sigma / previous if previous > 0 else 1.0
        # Slow EWMA update, so a single burst does not become the new normal.
        alpha = 0.02
        self._vol_baseline[asset] = (1 - alpha) * previous + alpha * sigma
        return ratio

    def detect(self, fs: FeatureSet) -> RegimeState:
        f = fs.features
        cfg = self.config
        scores: dict[str, float] = {}

        sigma = f.get("sigma_per_sec", 0.0)
        vol_ratio = self._baseline_ratio(fs.asset, sigma) if sigma > 0 else 1.0
        scores["vol_ratio"] = vol_ratio

        # --- 1. data / feed integrity ---------------------------------------
        quality = f.get("data_quality", 0.0)
        if quality < 0.5 or f.get("feed_healthy", 1.0) < 1.0:
            return RegimeState(
                Regime.UNSTABLE, 0.9,
                f"data quality {quality:.2f}", scores,
            )

        # --- 2. cross-venue disagreement ------------------------------------
        dispersion = f.get("xchg_spread_bps", 0.0)
        sigma_window = max(f.get("sigma_window_bps", 1.0), 1.0)
        scores["dispersion_ratio"] = dispersion / sigma_window
        if dispersion > cfg.divergence_bps_multiple * sigma_window:
            return RegimeState(
                Regime.DIVERGENT, 0.8,
                f"venues disagree by {dispersion:.1f}bps", scores,
            )

        # --- 3. liquidity ----------------------------------------------------
        liquidity = f.get("pm_liq_usd", 0.0)
        spread_ticks = f.get("pm_spread_ticks", 0.0)
        scores["liquidity"] = liquidity
        if liquidity < cfg.liquidity_floor_usd or spread_ticks > cfg.spread_shock_ticks:
            return RegimeState(
                Regime.LIQUIDITY_SHOCK, 0.75,
                f"liquidity ${liquidity:.0f}, spread {spread_ticks:.1f} ticks", scores,
            )

        # --- 4. volatility character ----------------------------------------
        jump = f.get("vol_jump_ratio", 1.0)
        scores["jump_ratio"] = jump
        if vol_ratio > cfg.abnormal_vol_ratio:
            return RegimeState(
                Regime.ABNORMAL_VOL, 0.8,
                f"volatility {vol_ratio:.1f}x baseline", scores,
            )
        if jump > cfg.jump_ratio and vol_ratio > 1.3:
            return RegimeState(
                Regime.NEWS_LIKE, 0.7,
                f"jump component {jump:.2f} with vol {vol_ratio:.1f}x", scores,
            )

        # --- 5. ordinary regimes ---------------------------------------------
        efficiency = f.get("efficiency_ratio", 0.3)
        scores["efficiency"] = efficiency
        if vol_ratio > cfg.high_vol_ratio:
            return RegimeState(
                Regime.HIGH_VOL, 0.6, f"volatility {vol_ratio:.1f}x baseline", scores,
            )
        if vol_ratio < cfg.low_vol_ratio:
            return RegimeState(
                Regime.LOW_VOL, 0.6, f"volatility {vol_ratio:.1f}x baseline", scores,
            )
        if efficiency > cfg.trend_efficiency:
            return RegimeState(
                Regime.TRENDING, 0.5 + 0.5 * min(efficiency, 1.0),
                f"efficiency {efficiency:.2f}", scores,
            )
        if efficiency < cfg.range_efficiency:
            return RegimeState(
                Regime.RANGING, 0.5 + 0.5 * (1.0 - efficiency),
                f"efficiency {efficiency:.2f}", scores,
            )
        return RegimeState(Regime.RANGING, 0.4, f"efficiency {efficiency:.2f}", scores)


#: Which strategies are worth listening to in each regime.  A strategy absent
#: from a regime's list is not disabled -- it is down-weighted by the ensemble.
REGIME_PREFERENCES: dict[Regime, set[str]] = {
    Regime.TRENDING: {"fair_value", "momentum", "breakout", "order_flow", "cross_exchange"},
    Regime.RANGING: {"fair_value", "mean_reversion", "microstructure", "mispricing", "volatility"},
    Regime.HIGH_VOL: {"fair_value", "order_flow", "momentum", "volatility"},
    Regime.LOW_VOL: {"fair_value", "mean_reversion", "microstructure", "mispricing"},
    Regime.NEWS_LIKE: {"fair_value", "order_flow", "cross_exchange"},
    Regime.DIVERGENT: {"fair_value"},
    Regime.ABNORMAL_VOL: {"fair_value"},
    Regime.LIQUIDITY_SHOCK: set(),
    Regime.UNSTABLE: set(),
}


def regime_weight(regime: Regime, strategy: str) -> float:
    """Multiplier applied to a strategy's ensemble weight in a given regime."""
    preferred = REGIME_PREFERENCES.get(regime)
    if preferred is None:
        return 1.0
    if not preferred:
        return 0.0
    return 1.0 if strategy in preferred else 0.45
