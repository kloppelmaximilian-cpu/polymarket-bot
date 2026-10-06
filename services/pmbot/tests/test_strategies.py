"""Strategies, regime detection and the meta-model."""

from __future__ import annotations

import pytest

from pmbot.core.types import Regime, StrategySignal
from pmbot.features.engine import FeatureContext, FeatureSet
from pmbot.strategies.base import Strategy, StrategyConfig, squash
from pmbot.strategies.ensemble import (
    MetaModel,
    StrategyPerformanceTracker,
    from_logit,
    to_logit,
)
from pmbot.strategies.ml_strategy import MLStrategy
from pmbot.strategies.regime import (
    REGIME_PREFERENCES,
    RegimeDetector,
    regime_weight,
)
from pmbot.strategies.signals import DEFAULT_STRATEGIES, build_strategies
from tests.conftest import make_book, make_market

BASE_FEATURES = {
    "t_remaining": 150.0, "t_elapsed": 150.0, "t_fraction": 0.5, "sqrt_tau": 12.2,
    "analytic_up": 0.60, "analytic_z": 0.2533, "analytic_sensitivity": 20.0,
    "sigma_per_sec": 8.9e-5, "sigma_window_bps": 15.4, "sigma_total": 0.00109,
    "basis_share": 0.05, "vol_reliable": 1.0, "vol_jump_ratio": 1.0,
    "data_quality": 1.0, "feed_healthy": 1.0, "n_sources": 5.0,
    "dist_bps": 2.8, "dist_sigma": 0.2533, "abs_dist_sigma": 0.2533,
    "implied_up": 0.55, "implied_vig": 0.0,
    "pm_mid": 0.55, "pm_spread": 0.01, "pm_spread_ticks": 1.0,
    "pm_micro_dev": 0.001, "pm_imb_top": 0.1, "pm_imb_5c": 0.15, "pm_imb_2c": 0.1,
    "pm_liq_usd": 800.0, "pm_trade_imb": 0.1, "pm_trade_count": 15.0,
    "pm_imb_change": 0.02,
    "ret_15s_bps": 3.0, "ret_30s_bps": 5.0, "ret_60s_bps": 7.0,
    "trade_imb_10s": 0.3, "trade_imb_30s": 0.35, "trade_imb_60s": 0.3,
    "trade_count_30s": 25.0, "large_trade_ratio": 0.1,
    "efficiency_ratio": 0.6, "range_pos": 0.5, "range_width_bps": 12.0,
    "boll_pos": 0.4, "rsi_dev": 0.2,
    "xchg_spread_bps": 2.0, "xchg_lead_max_bps": 1.0,
}


def feature_set(**overrides) -> FeatureSet:
    features = dict(BASE_FEATURES)
    features.update(overrides)
    market = make_market()
    context = FeatureContext(
        market=market, now=market.window_start + 150, spot=100_028.0,
        strike=100_000.0,
        strike_record=type("R", (), {"price": 100_000.0, "quality": "exact",
                                     "is_usable": True, "observed_at": 0.0})(),
        seconds_remaining=features["t_remaining"],
        sigma_per_sec=features["sigma_per_sec"],
        sigma_total=features["sigma_total"],
        up_book=make_book("m1-UP", 0.54, 0.56),
        down_book=make_book("m1-DOWN", 0.44, 0.46),
        market_probability=None,
        analytic_probability_up=features.get("analytic_up"),
        data_quality=features["data_quality"],
    )
    return FeatureSet("m1", "BTC", context.now, features, context)


class TestBase:
    def test_squash_is_bounded(self):
        assert -1.0 < squash(1000.0, 1.0) <= 1.0
        assert squash(0.0, 1.0) == 0.0
        assert squash(5.0, 0.0) == 0.0

    def test_logit_round_trip(self):
        for probability in (0.01, 0.25, 0.5, 0.75, 0.99):
            assert from_logit(to_logit(probability)) == pytest.approx(probability, abs=1e-6)

    def test_logit_is_clamped(self):
        assert to_logit(0.0) == pytest.approx(-6.0)
        assert to_logit(1.0) == pytest.approx(6.0)

    def test_drift_conversion_respects_the_z_score(self):
        class Tilt(Strategy):
            name = "tilt"

            def _evaluate(self, fs, regime):
                return self.from_drift(fs, 0.3, 0.8, "test")

        signal = Tilt().evaluate(feature_set(), Regime.TRENDING)
        from pmbot.probability.analytic import norm_cdf

        assert signal.probability_up == pytest.approx(norm_cdf(0.2533 + 0.3))

    def test_drift_is_capped_per_strategy(self):
        class Wild(Strategy):
            name = "wild"

            def _evaluate(self, fs, regime):
                return self.from_drift(fs, 99.0, 1.0, "test")

        strategy = Wild(StrategyConfig(max_drift_sd=0.4))
        from pmbot.probability.analytic import norm_cdf

        signal = strategy.evaluate(feature_set(), Regime.TRENDING)
        assert signal.probability_up == pytest.approx(norm_cdf(0.2533 + 0.4))

    def test_a_broken_strategy_abstains_rather_than_raising(self):
        class Broken(Strategy):
            name = "broken"

            def _evaluate(self, fs, regime):
                raise RuntimeError("kaboom")

        signal = Broken().evaluate(feature_set(), Regime.TRENDING)
        assert signal.abstain is True
        assert "RuntimeError" in signal.reason

    def test_missing_required_features_abstain(self):
        class Needy(Strategy):
            name = "needy"
            requires = ("nonexistent_feature",)

            def _evaluate(self, fs, regime):
                raise AssertionError("must not be reached")

        signal = Needy().evaluate(feature_set(), Regime.TRENDING)
        assert signal.abstain
        assert "missing" in signal.reason

    def test_disabled_strategy_abstains(self):
        strategies = build_strategies(["momentum"], {"momentum": StrategyConfig(enabled=False)})
        assert strategies[0].evaluate(feature_set(), Regime.TRENDING).abstain

    def test_regime_disabled_strategy_abstains(self):
        config = StrategyConfig(disabled_regimes={Regime.HIGH_VOL})
        strategy = build_strategies(["momentum"], {"momentum": config})[0]
        assert strategy.evaluate(feature_set(), Regime.HIGH_VOL).abstain
        assert not strategy.evaluate(feature_set(), Regime.TRENDING).abstain


class TestSignalDirection:
    def test_all_default_strategies_run_without_error(self):
        for name in DEFAULT_STRATEGIES:
            signal = build_strategies([name])[0].evaluate(feature_set(), Regime.TRENDING)
            assert 0.0 <= signal.probability_up <= 1.0
            assert 0.0 <= signal.confidence <= 1.0

    def test_fair_value_returns_the_analytic_probability(self):
        signal = build_strategies(["fair_value"])[0].evaluate(
            feature_set(), Regime.RANGING
        )
        assert signal.probability_up == pytest.approx(0.60)

    def test_fair_value_confidence_falls_when_basis_dominates(self):
        strategy = build_strategies(["fair_value"])[0]
        clean = strategy.evaluate(feature_set(basis_share=0.02), Regime.RANGING)
        noisy = strategy.evaluate(feature_set(basis_share=0.80), Regime.RANGING)
        assert noisy.confidence < clean.confidence

    def test_momentum_follows_the_move(self):
        strategy = build_strategies(["momentum"])[0]
        up = strategy.evaluate(
            feature_set(ret_15s_bps=8, ret_30s_bps=12, ret_60s_bps=14,
                        efficiency_ratio=0.7, trade_imb_30s=0.5),
            Regime.TRENDING,
        )
        down = strategy.evaluate(
            feature_set(ret_15s_bps=-8, ret_30s_bps=-12, ret_60s_bps=-14,
                        efficiency_ratio=0.7, trade_imb_30s=-0.5),
            Regime.TRENDING,
        )
        assert up.probability_up > 0.60 > down.probability_up

    def test_momentum_is_muted_in_chop(self):
        strategy = build_strategies(["momentum"])[0]
        trending = strategy.evaluate(
            feature_set(ret_30s_bps=12, efficiency_ratio=0.8), Regime.TRENDING
        )
        choppy = strategy.evaluate(
            feature_set(ret_30s_bps=12, efficiency_ratio=0.05), Regime.RANGING
        )
        assert abs(trending.probability_up - 0.6) > abs(choppy.probability_up - 0.6)

    def test_mean_reversion_only_fires_on_unsupported_extension(self):
        strategy = build_strategies(["mean_reversion"])[0]
        assert strategy.evaluate(feature_set(), Regime.RANGING).abstain
        fired = strategy.evaluate(
            feature_set(ret_30s_bps=30, trade_imb_30s=0.0, efficiency_ratio=0.1,
                        boll_pos=2.0),
            Regime.RANGING,
        )
        assert not fired.abstain
        assert fired.probability_up < 0.60          # fading the up-move

    def test_order_flow_needs_trades(self):
        strategy = build_strategies(["order_flow"])[0]
        assert strategy.evaluate(feature_set(trade_count_30s=1), Regime.TRENDING).abstain
        signal = strategy.evaluate(feature_set(trade_count_30s=40), Regime.TRENDING)
        assert signal.probability_up > 0.60

    def test_breakout_requires_an_extreme_and_confirmation(self):
        strategy = build_strategies(["breakout"])[0]
        assert strategy.evaluate(feature_set(range_pos=0.5), Regime.TRENDING).abstain
        assert strategy.evaluate(
            feature_set(range_pos=0.95, range_width_bps=1.0), Regime.TRENDING
        ).abstain
        signal = strategy.evaluate(
            feature_set(range_pos=0.95, range_width_bps=14.0, efficiency_ratio=0.6,
                        trade_imb_30s=0.4),
            Regime.TRENDING,
        )
        assert not signal.abstain
        assert signal.probability_up > 0.60

    def test_breakout_abstains_when_flow_contradicts(self):
        strategy = build_strategies(["breakout"])[0]
        assert strategy.evaluate(
            feature_set(range_pos=0.95, range_width_bps=14.0, efficiency_ratio=0.6,
                        trade_imb_30s=-0.5),
            Regime.TRENDING,
        ).abstain

    def test_volatility_abstains_when_the_market_agrees(self):
        """When the market's price implies the same volatility we estimate,
        there is no width disagreement to trade."""
        strategy = build_strategies(["volatility"])[0]
        signal = strategy.evaluate(feature_set(implied_up=0.60), Regime.RANGING)
        assert signal.abstain
        assert "agreement" in signal.reason

    def test_volatility_fires_when_the_market_implies_a_different_width(self):
        strategy = build_strategies(["volatility"])[0]
        # implied_up 0.55 against our 0.60 at this moneyness means the market is
        # pricing roughly twice our volatility.
        signal = strategy.evaluate(feature_set(implied_up=0.55), Regime.RANGING)
        assert not signal.abstain
        assert "our vol" in signal.reason
        assert signal.probability_up == pytest.approx(0.60)

    def test_volatility_abstains_too_close_to_the_strike(self):
        strategy = build_strategies(["volatility"])[0]
        assert strategy.evaluate(feature_set(dist_sigma=0.01), Regime.RANGING).abstain

    def test_cross_exchange_needs_three_venues(self):
        strategy = build_strategies(["cross_exchange"])[0]
        assert strategy.evaluate(feature_set(n_sources=2), Regime.TRENDING).abstain

    def test_cross_exchange_stands_down_on_wide_dispersion(self):
        strategy = build_strategies(["cross_exchange"])[0]
        assert strategy.evaluate(
            feature_set(xchg_spread_bps=100.0), Regime.TRENDING
        ).abstain

    def test_microstructure_tilts_around_the_market_price(self):
        strategy = build_strategies(["microstructure"])[0]
        signal = strategy.evaluate(
            feature_set(pm_imb_5c=0.8, pm_micro_dev=0.01, pm_trade_imb=0.5),
            Regime.RANGING,
        )
        assert signal.probability_up > 0.55        # above the implied 0.55

    def test_microstructure_abstains_on_a_thin_book(self):
        strategy = build_strategies(["microstructure"])[0]
        assert strategy.evaluate(feature_set(pm_liq_usd=10.0), Regime.RANGING).abstain

    def test_mispricing_abstains_when_model_agrees(self):
        strategy = build_strategies(["mispricing"])[0]
        assert strategy.evaluate(
            feature_set(analytic_up=0.55, implied_up=0.552), Regime.RANGING
        ).abstain

    def test_mispricing_confidence_grows_with_the_gap(self):
        strategy = build_strategies(["mispricing"])[0]
        small = strategy.evaluate(feature_set(analytic_up=0.58), Regime.RANGING)
        large = strategy.evaluate(feature_set(analytic_up=0.75), Regime.RANGING)
        assert large.confidence > small.confidence

    def test_data_quality_scales_every_confidence(self):
        for name in DEFAULT_STRATEGIES:
            strategy = build_strategies([name])[0]
            good = strategy.evaluate(feature_set(data_quality=1.0), Regime.TRENDING)
            bad = strategy.evaluate(feature_set(data_quality=0.1), Regime.TRENDING)
            if not good.abstain and not bad.abstain:
                assert bad.confidence <= good.confidence + 1e-9, name


class TestMLStrategy:
    def test_abstains_without_a_model(self):
        signal = MLStrategy(None).evaluate(feature_set(), Regime.TRENDING)
        assert signal.abstain
        assert "no model" in signal.reason

    def test_abstains_when_uncalibrated(self):
        class Fake:
            is_calibrated = False
            feature_names = ["analytic_up"]

            def predict(self, features):
                return 0.7

            def test_metrics(self):
                return {"brier_skill": 0.1}

            version = "fake"

        assert MLStrategy(Fake()).evaluate(feature_set(), Regime.TRENDING).abstain

    def test_abstains_when_too_many_features_missing(self):
        class Fake:
            is_calibrated = True
            feature_names = [f"missing_{i}" for i in range(10)]
            version = "fake"

            def predict(self, features):
                return 0.7

            def test_metrics(self):
                return {"brier_skill": 0.1}

        assert MLStrategy(Fake()).evaluate(feature_set(), Regime.TRENDING).abstain

    def test_confidence_capped_by_validated_skill(self):
        class Fake:
            is_calibrated = True
            feature_names = ["analytic_up", "dist_sigma"]
            version = "fake"

            def __init__(self, skill):
                self.skill = skill

            def predict(self, features):
                return 0.7

            def test_metrics(self):
                return {"brier_skill": self.skill}

        weak = MLStrategy(Fake(0.005)).evaluate(feature_set(), Regime.TRENDING)
        strong = MLStrategy(Fake(0.20)).evaluate(feature_set(), Regime.TRENDING)
        assert weak.confidence < strong.confidence
        assert weak.confidence < 0.1


class TestRegimeDetector:
    def test_unstable_on_poor_data(self):
        state = RegimeDetector().detect(feature_set(data_quality=0.2))
        assert state.regime is Regime.UNSTABLE
        assert state.is_tradable is False

    def test_divergent_on_wide_cross_exchange_spread(self):
        state = RegimeDetector().detect(feature_set(xchg_spread_bps=50.0))
        assert state.regime is Regime.DIVERGENT

    def test_liquidity_shock_on_a_thin_book(self):
        state = RegimeDetector().detect(feature_set(pm_liq_usd=10.0))
        assert state.regime is Regime.LIQUIDITY_SHOCK
        assert state.is_tradable is False

    def test_liquidity_shock_on_a_wide_spread(self):
        state = RegimeDetector().detect(feature_set(pm_spread_ticks=10.0))
        assert state.regime is Regime.LIQUIDITY_SHOCK

    def test_trending_vs_ranging(self):
        detector = RegimeDetector()
        assert detector.detect(feature_set(efficiency_ratio=0.8)).regime is Regime.TRENDING
        detector = RegimeDetector()
        assert detector.detect(feature_set(efficiency_ratio=0.05)).regime is Regime.RANGING

    def test_abnormal_volatility_detected_against_the_baseline(self):
        detector = RegimeDetector()
        base = 8.9e-5
        for _ in range(40):
            detector.detect(feature_set(sigma_per_sec=base))
        state = detector.detect(feature_set(sigma_per_sec=base * 5))
        assert state.regime in (Regime.ABNORMAL_VOL, Regime.HIGH_VOL, Regime.NEWS_LIKE)

    def test_regime_weights(self):
        assert regime_weight(Regime.TRENDING, "momentum") == 1.0
        assert regime_weight(Regime.RANGING, "momentum") < 1.0
        assert regime_weight(Regime.UNSTABLE, "momentum") == 0.0
        assert regime_weight(Regime.LIQUIDITY_SHOCK, "fair_value") == 0.0

    def test_every_regime_has_a_preference_entry(self):
        for regime in Regime:
            assert regime in REGIME_PREFERENCES


class TestMetaModel:
    def test_no_signals_means_no_view(self):
        result = MetaModel().combine([], Regime.TRENDING)
        assert result.probability_up == 0.5
        assert result.confidence == 0.0

    def test_all_abstaining_means_no_view(self):
        signals = [StrategySignal("a", 0.8, 0.0, abstain=True)]
        assert MetaModel().combine(signals, Regime.TRENDING).probability_up == 0.5

    def test_combines_in_log_odds(self):
        signals = [StrategySignal("fair_value", 0.60, 1.0),
                   StrategySignal("momentum", 0.80, 1.0)]
        result = MetaModel(adaptive=False).combine(signals, Regime.TRENDING)
        assert 0.60 < result.probability_up < 0.80

    def test_confidence_weighting(self):
        loud = MetaModel(adaptive=False).combine(
            [StrategySignal("fair_value", 0.50, 0.1),
             StrategySignal("momentum", 0.90, 1.0)],
            Regime.TRENDING,
        )
        quiet = MetaModel(adaptive=False).combine(
            [StrategySignal("fair_value", 0.50, 1.0),
             StrategySignal("momentum", 0.90, 0.1)],
            Regime.TRENDING,
        )
        assert loud.probability_up > quiet.probability_up

    def test_anchor_retains_a_floor_weight(self):
        """A chorus of weak signals must not drag the ensemble off fair value."""
        signals = [StrategySignal("fair_value", 0.50, 1.0)] + [
            StrategySignal(f"s{i}", 0.95, 0.05) for i in range(8)
        ]
        result = MetaModel(adaptive=False).combine(signals, Regime.TRENDING)
        assert result.probability_up < 0.75

    def test_disagreement_lowers_confidence(self):
        agree = MetaModel(adaptive=False).combine(
            [StrategySignal("a", 0.7, 0.8), StrategySignal("b", 0.72, 0.8)],
            Regime.TRENDING,
        )
        disagree = MetaModel(adaptive=False).combine(
            [StrategySignal("a", 0.7, 0.8), StrategySignal("b", 0.3, 0.8)],
            Regime.TRENDING,
        )
        assert disagree.confidence < agree.confidence
        assert disagree.agreement < agree.agreement

    def test_dispersion_becomes_uncertainty(self):
        tight = MetaModel(adaptive=False).combine(
            [StrategySignal("a", 0.60, 1.0), StrategySignal("b", 0.61, 1.0)],
            Regime.TRENDING,
        )
        wide = MetaModel(adaptive=False).combine(
            [StrategySignal("a", 0.20, 1.0), StrategySignal("b", 0.90, 1.0)],
            Regime.TRENDING,
        )
        assert wide.uncertainty > tight.uncertainty

    def test_untradable_regime_silences_everything_but_the_anchor(self):
        signals = [StrategySignal("fair_value", 0.60, 1.0),
                   StrategySignal("momentum", 0.95, 1.0)]
        result = MetaModel(adaptive=False).combine(signals, Regime.LIQUIDITY_SHOCK)
        assert result.probability_up == pytest.approx(0.60, abs=0.02)

    def test_contributions_sum_to_one(self):
        signals = [StrategySignal("a", 0.6, 0.5), StrategySignal("b", 0.7, 0.8)]
        result = MetaModel(adaptive=False).combine(signals, Regime.TRENDING)
        assert sum(result.contributions.values()) == pytest.approx(1.0)


class TestPerformanceTracker:
    def test_good_strategies_gain_weight_and_bad_ones_lose_it(self):
        tracker = StrategyPerformanceTracker(halflife=20.0)
        for _ in range(60):
            tracker.record(
                [StrategySignal("good", 0.85, 0.8), StrategySignal("bad", 0.15, 0.8)],
                Regime.TRENDING, resolved_up=True,
            )
        good = tracker.performance_weight("good", Regime.TRENDING)
        bad = tracker.performance_weight("bad", Regime.TRENDING)
        assert good > 1.0 > bad

    def test_weights_are_bounded(self):
        tracker = StrategyPerformanceTracker(halflife=5.0, min_weight=0.3, max_weight=1.8)
        for _ in range(500):
            tracker.record([StrategySignal("perfect", 0.999, 1.0)],
                           Regime.TRENDING, resolved_up=True)
        assert tracker.performance_weight("perfect", Regime.TRENDING) <= 1.8

    def test_unknown_strategy_starts_neutral(self):
        tracker = StrategyPerformanceTracker()
        assert tracker.performance_weight("brand_new", Regime.TRENDING) == pytest.approx(1.0)

    def test_abstaining_signals_are_not_scored(self):
        tracker = StrategyPerformanceTracker()
        tracker.record([StrategySignal("a", 0.9, 0.0, abstain=True)],
                       Regime.TRENDING, resolved_up=False)
        assert tracker.score("a").n == 0

    def test_snapshot_round_trip(self, tmp_path):
        tracker = StrategyPerformanceTracker()
        for _ in range(30):
            tracker.record([StrategySignal("a", 0.8, 0.9)], Regime.TRENDING, True)
        path = tmp_path / "perf.json"
        tracker.save(path)
        restored = StrategyPerformanceTracker()
        assert restored.load(path) is True
        assert restored.score("a").n == 30

    def test_load_missing_file_is_false(self, tmp_path):
        assert StrategyPerformanceTracker().load(tmp_path / "nope.json") is False
