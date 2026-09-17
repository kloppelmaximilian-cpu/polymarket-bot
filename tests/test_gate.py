"""The trade gate: where a view becomes (or fails to become) an order."""

from __future__ import annotations

import pytest

from pmbot.core.clock import SimulatedClock
from pmbot.core.types import (
    Decision,
    MarketProbability,
    Outcome,
    Prediction,
    Regime,
    StrategySignal,
)
from pmbot.execution.gate import GateConfig, TradeGate, rank_opportunities
from pmbot.polymarket.fees import FeeSchedule
from pmbot.risk.engine import RiskEngine, RiskLimits
from tests.conftest import make_book, make_market

START = 1_760_000_000.0


def prediction(probability=0.62, confidence=0.8, uncertainty=0.02,
               regime=Regime.TRENDING, calibrated=True, signals=None,
               features=None) -> Prediction:
    base = {"data_quality": 1.0, "pm_liq_usd": 1000.0, "basis_share": 0.05}
    base.update(features or {})
    return Prediction(
        market_id="m1", asset="BTC", timestamp=START + 150,
        probability_up=probability, probability_down=1 - probability,
        confidence=confidence, uncertainty=uncertainty, regime=regime,
        signals=signals if signals is not None else [
            StrategySignal("fair_value", probability, 0.8),
            StrategySignal("order_flow", probability + 0.02, 0.7),
        ],
        features=base, calibrated=calibrated,
    )


def gate(**config_overrides):
    config = GateConfig(**config_overrides)
    risk = RiskEngine(RiskLimits(), 1000.0, clock=SimulatedClock(START))
    return TradeGate(config, risk), risk


_DEFAULT = object()


def evaluate(gate_obj, market=None, pred=None, up=_DEFAULT, down=_DEFAULT,
             now=None, implied=0.52):
    """Evaluate both sides.  Pass ``up=None`` to simulate a missing book."""
    market = market or make_market(window_start=START)
    at = now or START + 150
    return gate_obj.evaluate(
        market=market,
        prediction=pred or prediction(),
        market_probability=MarketProbability(implied, 1 - implied, implied,
                                             1 - implied, 0.0),
        up_book=make_book("m1-UP", 0.51, 0.52, timestamp=at) if up is _DEFAULT else up,
        down_book=(
            make_book("m1-DOWN", 0.48, 0.49, timestamp=at) if down is _DEFAULT else down
        ),
        now=at,
        fee_schedule=FeeSchedule(),
    )


class TestEconomics:
    def test_edge_is_net_of_fee_and_slippage(self):
        g, _ = gate()
        up = next(o for o in evaluate(g) if o.outcome is Outcome.UP)
        assert up.gross_edge == pytest.approx(0.62 - 0.52)
        assert up.fee_cost > 0
        assert up.net_edge == pytest.approx(
            up.model_probability - up.entry_price - up.slippage_cost - up.fee_cost
        )
        assert up.net_edge < up.gross_edge

    def test_prices_off_the_ask_not_the_mid(self):
        g, _ = gate()
        up = next(o for o in evaluate(g) if o.outcome is Outcome.UP)
        assert up.entry_price == 0.52          # the ask, not the 0.515 mid

    def test_a_two_point_gross_edge_does_not_survive_at_the_middle(self):
        g, _ = gate()
        opportunities = evaluate(g, pred=prediction(probability=0.54))
        up = next(o for o in opportunities if o.outcome is Outcome.UP)
        assert up.net_edge < 0.005
        assert not up.is_tradable

    def test_a_clear_edge_is_tradable(self):
        g, _ = gate()
        up = next(o for o in evaluate(g) if o.outcome is Outcome.UP)
        assert up.is_tradable
        assert up.decision in (Decision.TRADE, Decision.HIGH_CONFIDENCE_TRADE)
        assert up.size_shares > 0

    def test_both_outcomes_are_scored(self):
        g, _ = gate()
        outcomes = {o.outcome for o in evaluate(g)}
        assert outcomes == {Outcome.UP, Outcome.DOWN}

    def test_high_confidence_classification(self):
        g, _ = gate(high_confidence_edge=0.04, high_confidence_threshold=0.7)
        up = next(
            o for o in evaluate(g, pred=prediction(probability=0.62, confidence=0.9))
            if o.outcome is Outcome.UP
        )
        assert up.net_edge >= 0.04
        assert up.decision is Decision.HIGH_CONFIDENCE_TRADE


class TestBlockers:
    def _blockers(self, opportunities, outcome=Outcome.UP):
        return next(o for o in opportunities if o.outcome is outcome).blockers

    def test_wide_spread(self):
        g, _ = gate(max_spread=0.02)
        blockers = self._blockers(
            evaluate(g, up=make_book("m1-UP", 0.45, 0.55, timestamp=START + 150))
        )
        assert any("spread" in b for b in blockers)

    def test_thin_liquidity(self):
        g, _ = gate(min_liquidity_usd=10_000.0)
        assert any("liquidity" in b for b in self._blockers(evaluate(g)))

    def test_stale_book(self):
        g, _ = gate(stale_book_seconds=2.0)
        blockers = self._blockers(
            evaluate(g, up=make_book("m1-UP", 0.51, 0.52, timestamp=START))
        )
        assert any("stale" in b for b in blockers)

    def test_crossed_book(self):
        g, _ = gate()
        blockers = self._blockers(
            evaluate(g, up=make_book("m1-UP", 0.55, 0.50, timestamp=START + 150))
        )
        assert any("crossed" in b for b in blockers)

    def test_no_book_at_all(self):
        g, _ = gate()
        blockers = self._blockers(evaluate(g, up=None))
        assert any("two-sided" in b for b in blockers)

    def test_too_little_time_left(self):
        g, _ = gate(min_seconds_remaining=60.0)
        blockers = self._blockers(evaluate(g, now=START + 280))
        assert any("remaining" in b for b in blockers)

    def test_window_too_fresh(self):
        g, _ = gate(max_seconds_remaining=200.0)
        blockers = self._blockers(evaluate(g, now=START + 10))
        assert any("too fresh" in b for b in blockers)

    def test_low_confidence(self):
        g, _ = gate(min_confidence=0.9)
        assert any("confidence" in b for b in self._blockers(evaluate(g)))

    def test_poor_data_quality(self):
        g, _ = gate(min_data_quality=0.9)
        blockers = self._blockers(
            evaluate(g, pred=prediction(features={"data_quality": 0.3}))
        )
        assert any("data quality" in b for b in blockers)

    def test_edge_inside_the_uncertainty_band(self):
        g, _ = gate(edge_uncertainty_multiple=1.0)
        blockers = self._blockers(
            evaluate(g, pred=prediction(probability=0.62, uncertainty=0.30))
        )
        assert any("uncertainty" in b for b in blockers)

    def test_strategy_disagreement(self):
        g, _ = gate(min_model_agreement=0.9)
        signals = [
            StrategySignal("fair_value", 0.62, 0.8),
            StrategySignal("mean_reversion", 0.30, 0.8),
        ]
        blockers = self._blockers(evaluate(g, pred=prediction(signals=signals)))
        assert any("agreement" in b for b in blockers)

    def test_implausibly_large_edge_is_refused(self):
        """A huge disagreement with a liquid market is usually our bug."""
        g, _ = gate(max_plausible_edge=0.10)
        blockers = self._blockers(evaluate(g, pred=prediction(probability=0.90)))
        assert any("implausibly large" in b for b in blockers)

    def test_an_edge_just_under_the_cap_is_allowed(self):
        g, _ = gate(max_plausible_edge=0.10)
        opportunities = evaluate(g, pred=prediction(probability=0.62))
        up = next(o for o in opportunities if o.outcome is Outcome.UP)
        assert up.net_edge < 0.10
        assert not any("implausibly large" in b for b in up.blockers)

    def test_calibration_can_be_required(self):
        g, _ = gate(require_calibration=True)
        blockers = self._blockers(
            evaluate(g, pred=prediction(calibrated=False))
        )
        assert any("calibrated" in b for b in blockers)

    def test_risk_veto_is_reported(self):
        g, risk = gate()
        risk.pause("test pause")
        assert any("risk" in b for b in self._blockers(evaluate(g)))

    def test_blocked_opportunities_are_still_returned_for_display(self):
        g, _ = gate(min_confidence=0.99)
        opportunities = evaluate(g)
        assert len(opportunities) == 2
        assert all(not o.is_tradable for o in opportunities)
        assert all(o.blockers for o in opportunities)


class TestDynamicThreshold:
    def test_uncertainty_raises_the_bar(self):
        g, _ = gate()
        low = g.required_edge(prediction(uncertainty=0.01), {"data_quality": 1.0})
        high = g.required_edge(prediction(uncertainty=0.10), {"data_quality": 1.0})
        assert high > low

    def test_poor_data_raises_the_bar(self):
        g, _ = gate()
        clean = g.required_edge(prediction(), {"data_quality": 1.0})
        dirty = g.required_edge(prediction(), {"data_quality": 0.4})
        assert dirty > clean

    def test_thin_liquidity_raises_the_bar(self):
        g, _ = gate(min_liquidity_usd=500.0)
        deep = g.required_edge(prediction(), {"data_quality": 1.0, "pm_liq_usd": 5000.0})
        thin = g.required_edge(prediction(), {"data_quality": 1.0, "pm_liq_usd": 50.0})
        assert thin > deep

    def test_basis_domination_raises_the_bar(self):
        g, _ = gate()
        early = g.required_edge(prediction(), {"data_quality": 1.0, "basis_share": 0.02})
        late = g.required_edge(prediction(), {"data_quality": 1.0, "basis_share": 0.80})
        assert late > early

    def test_difficult_regimes_raise_the_bar(self):
        g, _ = gate()
        calm = g.required_edge(prediction(regime=Regime.RANGING), {"data_quality": 1.0})
        wild = g.required_edge(
            prediction(regime=Regime.ABNORMAL_VOL), {"data_quality": 1.0}
        )
        assert wild > calm

    def test_multiplier_is_capped(self):
        g, _ = gate(min_edge=0.02, max_edge_multiplier=2.0)
        worst = g.required_edge(
            prediction(uncertainty=0.5, regime=Regime.ABNORMAL_VOL),
            {"data_quality": 0.0, "basis_share": 1.0, "pm_liq_usd": 0.0},
        )
        assert worst <= 0.02 * 2.0 + 1e-9


class TestRanking:
    def _opportunity(self, gate_obj, probability, liquidity, uncertainty, seconds=150):
        market = make_market(window_start=START)
        pred = prediction(probability=probability, uncertainty=uncertainty,
                          features={"data_quality": 1.0, "pm_liq_usd": liquidity})
        return next(
            o for o in gate_obj.evaluate(
                market=market, prediction=pred,
                market_probability=MarketProbability(0.52, 0.48, 0.52, 0.48, 0.0),
                up_book=make_book("m1-UP", 0.51, 0.52, bid_size=liquidity,
                                  ask_size=liquidity, timestamp=START + (300 - seconds)),
                down_book=make_book("m1-DOWN", 0.48, 0.49,
                                    timestamp=START + (300 - seconds)),
                now=START + (300 - seconds), fee_schedule=FeeSchedule(),
            )
            if o.outcome is Outcome.UP
        )

    def test_tradable_ranked_ahead_of_rejected(self):
        g, _ = gate()
        good = self._opportunity(g, 0.65, 500, 0.02)
        bad = self._opportunity(g, 0.53, 500, 0.02)
        ranked = rank_opportunities([bad, good])
        assert ranked[0] is good

    def test_score_prefers_certainty_at_equal_edge(self):
        g, _ = gate()
        certain = self._opportunity(g, 0.65, 500, 0.01)
        unsure = self._opportunity(g, 0.65, 500, 0.05)
        assert certain.score > unsure.score

    def test_score_prefers_liquidity(self):
        g, _ = gate(min_liquidity_usd=10.0)
        deep = self._opportunity(g, 0.62, 400, 0.02)
        thin = self._opportunity(g, 0.62, 20, 0.02)
        assert deep.book_state["liquidity_usd"] > thin.book_state["liquidity_usd"]
        assert deep.score > thin.score

    def test_score_is_zero_without_an_edge(self):
        g, _ = gate()
        assert self._opportunity(g, 0.50, 500, 0.02).score == 0.0

    def test_ranking_is_stable_and_complete(self):
        g, _ = gate()
        opportunities = [
            self._opportunity(g, p, 500, 0.02) for p in (0.60, 0.66, 0.63)
        ]
        ranked = rank_opportunities(opportunities)
        assert len(ranked) == 3
        scores = [o.score for o in ranked if o.is_tradable]
        assert scores == sorted(scores, reverse=True)
