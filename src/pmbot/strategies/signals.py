"""The concrete strategies.

Each one isolates a single, economically-motivated source of information, so
that the ensemble can learn which sources work in which regime instead of being
handed one opaque score.
"""

from __future__ import annotations

import math

from ..core.types import Regime, StrategySignal
from ..features.engine import FeatureSet
from ..probability.analytic import implied_volatility
from .base import Strategy, StrategyConfig, squash


class FairValueStrategy(Strategy):
    """The anchor: the digital's analytic price given spot, strike, time, vol.

    Contributes no view of its own -- it is the zero-drift baseline every other
    strategy tilts away from.  Its confidence falls as basis/measurement noise
    starts to dominate the remaining diffusive move, which is what happens in
    the last seconds of a window.
    """

    name = "fair_value"
    requires = ("analytic_up", "analytic_z")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        basis_share = f.get("basis_share", 0.0)
        vol_reliable = f.get("vol_reliable", 0.0)
        # Confidence: high when the diffusive term dominates and vol is well
        # estimated; low when we are mostly pricing our own measurement error.
        confidence = (1.0 - basis_share) * (0.55 + 0.45 * vol_reliable)
        confidence *= f.get("data_quality", 0.0)
        return self.from_probability(
            f["analytic_up"], confidence, "analytic digital fair value",
            {"analytic_z": f["analytic_z"], "basis_share": basis_share},
        )


class MomentumStrategy(Strategy):
    """Short-horizon trend continuation.

    Over seconds-to-minutes, crypto exhibits weak but real continuation when a
    move is backed by trade flow and the path is efficient (trending rather
    than chopping).  Both conditions are required: an unsupported spike is the
    mean-reversion setup, not a momentum one.
    """

    name = "momentum"
    requires = ("analytic_z", "ret_30s_bps")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        sigma_window = max(f.get("sigma_window_bps", 1.0), 1.0)

        r15 = f.get("ret_15s_bps", 0.0)
        r30 = f.get("ret_30s_bps", 0.0)
        r60 = f.get("ret_60s_bps", 0.0)
        # Normalise each return by the volatility scale it was drawn from.
        n15 = r15 / (sigma_window * math.sqrt(15 / 300))
        n30 = r30 / (sigma_window * math.sqrt(30 / 300))
        n60 = r60 / (sigma_window * math.sqrt(60 / 300))
        blended = 0.5 * n30 + 0.3 * n15 + 0.2 * n60

        efficiency = f.get("efficiency_ratio", 0.0)
        flow_support = f.get("trade_imb_30s", 0.0)
        agreement = 1.0 if blended * flow_support >= 0 else -0.5

        # Trend quality gate: chop kills continuation.
        quality = max(0.0, min(1.0, efficiency * 1.6))
        drift = squash(blended, 2.0) * 0.30 * quality * (1.0 if agreement > 0 else 0.3)

        confidence = (
            0.35 + 0.35 * quality + 0.20 * min(abs(flow_support), 1.0)
        ) * f.get("data_quality", 0.0)
        if abs(blended) < 0.3:
            confidence *= 0.4

        return self.from_drift(
            fs, drift, confidence,
            f"momentum {blended:+.2f}sd eff={efficiency:.2f} flow={flow_support:+.2f}",
            {"blended": blended, "efficiency": efficiency, "flow": flow_support},
        )


class MeanReversionStrategy(Strategy):
    """Fade fast, unsupported extensions.

    Fires when the price has stretched far in a short time *without* order-flow
    backing and the path is inefficient -- the microstructure signature of a
    liquidity air-pocket rather than informed buying.
    """

    name = "mean_reversion"
    requires = ("analytic_z", "ret_30s_bps")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        sigma_window = max(f.get("sigma_window_bps", 1.0), 1.0)
        r30 = f.get("ret_30s_bps", 0.0)
        n30 = r30 / (sigma_window * math.sqrt(30 / 300))

        efficiency = f.get("efficiency_ratio", 0.5)
        flow = f.get("trade_imb_30s", 0.0)
        boll = f.get("boll_pos", 0.0)
        rsi_dev = f.get("rsi_dev", 0.0)

        stretched = abs(n30) > 1.0 or abs(boll) > 1.0
        unsupported = abs(flow) < 0.25 or (n30 * flow < 0)
        choppy = efficiency < 0.35

        if not (stretched and unsupported and choppy):
            return self.abstain("no unsupported extension")

        extension = 0.6 * squash(n30, 2.0) + 0.25 * squash(boll, 1.5) + 0.15 * rsi_dev
        drift = -extension * 0.22
        confidence = (
            0.30 + 0.30 * min(abs(extension), 1.0) + 0.20 * (1.0 - efficiency)
        ) * f.get("data_quality", 0.0)

        return self.from_drift(
            fs, drift, confidence,
            f"fading {n30:+.2f}sd extension, eff={efficiency:.2f}",
            {"n30": n30, "boll": boll, "efficiency": efficiency, "flow": flow},
        )


class OrderFlowStrategy(Strategy):
    """Aggressor imbalance on the reference exchanges.

    Signed trade flow is the most direct observable of informed pressure and is
    the shortest-horizon predictor available, so it is scaled up when it is both
    large and persistent across horizons.
    """

    name = "order_flow"
    requires = ("analytic_z", "trade_imb_30s")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        i10 = f.get("trade_imb_10s", 0.0)
        i30 = f.get("trade_imb_30s", 0.0)
        i60 = f.get("trade_imb_60s", 0.0)
        count = f.get("trade_count_30s", 0.0)

        if count < 5:
            return self.abstain("too few trades to read flow")

        persistence = 1.0 if (i10 * i30 > 0 and i30 * i60 > 0) else 0.45
        blended = 0.45 * i30 + 0.35 * i10 + 0.20 * i60
        large = f.get("large_trade_ratio", 0.0)

        drift = squash(blended, 0.5) * 0.25 * persistence * (1.0 + 0.5 * large)
        confidence = (
            0.30 + 0.30 * min(abs(blended) * 2.0, 1.0)
            + 0.20 * (persistence > 0.5) + 0.10 * min(count / 40.0, 1.0)
        ) * f.get("data_quality", 0.0)

        return self.from_drift(
            fs, drift, confidence,
            f"flow imbalance {blended:+.2f} persist={persistence:.1f} n={count:.0f}",
            {"i10": i10, "i30": i30, "i60": i60, "large": large},
        )


class BreakoutStrategy(Strategy):
    """Range escape with flow confirmation.

    A close at the extreme of the window's range, on an efficient path with
    confirming flow, is the one configuration where continuation is strongest
    on this horizon.
    """

    name = "breakout"
    requires = ("analytic_z", "range_pos")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        pos = f.get("range_pos", 0.5)
        width = f.get("range_width_bps", 0.0)
        sigma_window = max(f.get("sigma_window_bps", 1.0), 1.0)
        efficiency = f.get("efficiency_ratio", 0.0)
        flow = f.get("trade_imb_30s", 0.0)

        at_top, at_bottom = pos > 0.88, pos < 0.12
        if not (at_top or at_bottom):
            return self.abstain("price not at range extreme")
        if width < 0.4 * sigma_window:
            return self.abstain("range too narrow to be a breakout")
        if efficiency < 0.30:
            return self.abstain("breakout not supported by an efficient path")

        direction = 1.0 if at_top else -1.0
        if flow * direction < -0.15:
            return self.abstain("flow contradicts the breakout")

        strength = min(width / sigma_window, 2.0) / 2.0
        drift = direction * 0.28 * strength * (0.6 + 0.4 * efficiency)
        confidence = (
            0.30 + 0.30 * strength + 0.20 * efficiency + 0.15 * min(abs(flow), 1.0)
        ) * f.get("data_quality", 0.0)

        return self.from_drift(
            fs, drift, confidence,
            f"breakout {'up' if direction > 0 else 'down'} pos={pos:.2f} width={width:.0f}bps",
            {"range_pos": pos, "width": width, "efficiency": efficiency},
        )


class VolatilityStrategy(Strategy):
    """Trade the market's volatility assumption, not its direction.

    Inverting the digital gives the volatility the market's own price implies.
    When that is far from our realised-vol estimate the *width* of the market's
    distribution is wrong: an over-stated vol pushes every price toward 0.50,
    which underprices the favourite, and vice versa.
    """

    name = "volatility"
    requires = ("analytic_up", "implied_up", "sigma_per_sec", "t_remaining")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        ctx = fs.context
        if ctx.spot <= 0 or ctx.strike <= 0 or ctx.seconds_remaining <= 5:
            return self.abstain("no usable spot/strike/time")
        if abs(f.get("dist_sigma", 0.0)) < 0.15:
            return self.abstain("too close to the strike to read implied vol")

        market_sigma = implied_volatility(
            f["implied_up"], ctx.spot, ctx.strike, ctx.seconds_remaining,
        )
        if market_sigma is None or market_sigma <= 0:
            return self.abstain("market price implies no attainable volatility")

        our_sigma = f["sigma_per_sec"]
        if our_sigma <= 0:
            return self.abstain("no volatility estimate")

        ratio = market_sigma / our_sigma
        log_gap = math.log(ratio)
        if abs(log_gap) < 0.18:                     # < ~20% disagreement
            return self.abstain(f"vol agreement (ratio {ratio:.2f})")

        confidence = (
            min(abs(log_gap) / 0.7, 1.0) * 0.75 * f.get("vol_reliable", 0.0)
        ) * f.get("data_quality", 0.0)

        return self.from_probability(
            f["analytic_up"], confidence,
            f"market implies {market_sigma / our_sigma:.2f}x our vol",
            {"implied_sigma": market_sigma, "our_sigma": our_sigma, "ratio": ratio},
        )


class CrossExchangeStrategy(Strategy):
    """Cross-venue dislocation.

    When one venue leads, the composite has not yet caught up and the remaining
    convergence is a short, mechanical drift.  Large dispersion also means the
    reference price is untrustworthy, so the strategy stands down rather than
    trading its own noise.
    """

    name = "cross_exchange"
    requires = ("analytic_z", "xchg_lead_max_bps")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        n_sources = f.get("n_sources", 0.0)
        if n_sources < 3:
            return self.abstain("need 3+ venues for a dislocation read")

        dispersion = f.get("xchg_spread_bps", 0.0)
        sigma_window = max(f.get("sigma_window_bps", 1.0), 1.0)
        lead = f.get("xchg_lead_max_bps", 0.0)

        if dispersion > 0.8 * sigma_window:
            return self.abstain(f"dispersion {dispersion:.1f}bps too wide to trust")
        if abs(lead) < 0.05 * sigma_window:
            return self.abstain("no meaningful lead")

        drift = squash(lead / (0.25 * sigma_window), 1.5) * 0.15
        confidence = (
            0.25 + 0.25 * min(abs(lead) / (0.3 * sigma_window), 1.0)
            + 0.20 * min(n_sources / 5.0, 1.0)
        ) * f.get("data_quality", 0.0)

        return self.from_drift(
            fs, drift, confidence,
            f"venue lead {lead:+.1f}bps, dispersion {dispersion:.1f}bps",
            {"lead": lead, "dispersion": dispersion, "n_sources": n_sources},
        )


class MicrostructureStrategy(Strategy):
    """Read the Polymarket book itself.

    Depth imbalance and the microprice-vs-mid gap predict where the *market's*
    price is about to go.  That is information about the counterparty, not about
    bitcoin, so it is translated into a probability tilt around the market's own
    de-vigged price rather than around our fair value.
    """

    name = "microstructure"
    requires = ("implied_up", "pm_imb_5c", "pm_micro_dev")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        implied = f["implied_up"]
        imbalance = f.get("pm_imb_5c", 0.0)
        top_imbalance = f.get("pm_imb_top", 0.0)
        micro_dev = f.get("pm_micro_dev", 0.0)
        imb_change = f.get("pm_imb_change", 0.0)
        pm_flow = f.get("pm_trade_imb", 0.0)
        liquidity = f.get("pm_liq_usd", 0.0)

        if liquidity < 50.0:
            return self.abstain("book too thin to read")

        pressure = (
            0.40 * imbalance + 0.20 * top_imbalance + 0.20 * imb_change
            + 0.20 * pm_flow
        )
        # Micro deviation is already in probability units; the rest is a tilt.
        shift = micro_dev + squash(pressure, 0.6) * 0.03
        probability = implied + shift

        confidence = (
            0.25 + 0.30 * min(abs(pressure), 1.0)
            + 0.20 * min(liquidity / 2000.0, 1.0)
            + 0.15 * min(f.get("pm_trade_count", 0.0) / 20.0, 1.0)
        ) * f.get("data_quality", 0.0)

        return self.from_probability(
            probability, confidence,
            f"book pressure {pressure:+.2f}, micro dev {micro_dev:+.3f}",
            {"imbalance": imbalance, "micro_dev": micro_dev, "pm_flow": pm_flow},
        )


class MispricingStrategy(Strategy):
    """Direct model-vs-market disagreement, expressed as an implied strike.

    Inverting the market price yields the strike the market is behaving as
    though it were trading against.  When that drifts far from the real strike
    the market is stale -- typically because a mover on the reference exchanges
    has not yet been repriced here.
    """

    name = "mispricing"
    requires = ("analytic_up", "implied_up", "analytic_z")

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        f = fs.features
        gap = f["analytic_up"] - f["implied_up"]
        if abs(gap) < 0.01:
            return self.abstain("model agrees with the market")

        sensitivity = f.get("analytic_sensitivity", 0.0)
        dist_sigma = abs(f.get("dist_sigma", 0.0))

        # A gap is only meaningful when the model is not itself in a region
        # where tiny price changes swing the probability wildly.
        stability = 1.0 / (1.0 + max(sensitivity, 0.0) * 1e-3)
        confidence = (
            min(abs(gap) / 0.10, 1.0) * (0.35 + 0.35 * stability)
            + 0.15 * min(dist_sigma, 1.0)
        ) * f.get("data_quality", 0.0) * f.get("vol_reliable", 0.5)

        return self.from_probability(
            f["analytic_up"], confidence,
            f"model-market gap {gap:+.3f}",
            {"gap": gap, "sensitivity": sensitivity},
        )


DEFAULT_STRATEGIES: dict[str, type[Strategy]] = {
    FairValueStrategy.name: FairValueStrategy,
    MomentumStrategy.name: MomentumStrategy,
    MeanReversionStrategy.name: MeanReversionStrategy,
    OrderFlowStrategy.name: OrderFlowStrategy,
    BreakoutStrategy.name: BreakoutStrategy,
    VolatilityStrategy.name: VolatilityStrategy,
    CrossExchangeStrategy.name: CrossExchangeStrategy,
    MicrostructureStrategy.name: MicrostructureStrategy,
    MispricingStrategy.name: MispricingStrategy,
}


def build_strategies(
    names: list[str], configs: dict[str, StrategyConfig] | None = None
) -> list[Strategy]:
    configs = configs or {}
    out: list[Strategy] = []
    for name in names:
        cls = DEFAULT_STRATEGIES.get(name)
        if cls is None:
            continue
        out.append(cls(configs.get(name)))
    return out
