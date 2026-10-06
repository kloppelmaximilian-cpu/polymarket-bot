"""Backtester: accounting, causality and the properties that make it credible."""

from __future__ import annotations

import pytest

from pmbot.backtesting.engine import BacktestConfig, BacktestEngine
from pmbot.backtesting.metrics import (
    PerformanceReport,
    TradeRecord,
    drawdown_series,
    evaluate_trades,
    streaks,
)
from pmbot.backtesting.montecarlo import (
    MonteCarloConfig,
    StressScenario,
    apply_stress,
    bootstrap_trades,
    run_robustness,
    stationary_bootstrap_indices,
)
from pmbot.backtesting.replay import (
    ReplaySession,
    SyntheticConfig,
    generate_synthetic_session,
)
from pmbot.backtesting.walkforward import (
    SeedSweepResult,
    SliceResult,
    WalkForwardResult,
)
from pmbot.core.types import Outcome

STRATEGIES = [
    "fair_value", "momentum", "mean_reversion", "order_flow", "breakout",
    "volatility", "cross_exchange", "microstructure", "mispricing",
]


@pytest.fixture(scope="module")
def small_session():
    return generate_synthetic_session(SyntheticConfig(
        assets=("BTC",), windows=6, seed=3, market_efficiency=0.2,
    ))


class TestSyntheticGenerator:
    def test_windows_are_exactly_five_minutes(self, small_session):
        for market in small_session.markets:
            assert market.window_end - market.window_start == 300.0

    def test_windows_sit_on_the_utc_grid(self, small_session):
        for market in small_session.markets:
            assert market.window_start % 300 == 0

    def test_truth_matches_the_close_versus_open_rule(self, small_session):
        for truth in small_session.truth.values():
            expected = Outcome.UP if truth.settle >= truth.strike else Outcome.DOWN
            assert truth.outcome is expected

    def test_events_are_time_ordered(self, small_session):
        timestamps = [event.ts for event in small_session.events]
        assert timestamps == sorted(timestamps)

    def test_efficiency_controls_the_injected_mispricing(self):
        efficient = generate_synthetic_session(SyntheticConfig(
            assets=("BTC",), windows=2, seed=1, market_efficiency=1.0
        ))
        sloppy = generate_synthetic_session(SyntheticConfig(
            assets=("BTC",), windows=2, seed=1, market_efficiency=0.0
        ))
        assert efficient.meta["effective_vol_bias"] == pytest.approx(1.0)
        assert sloppy.meta["effective_vol_bias"] > 1.0
        assert efficient.meta["effective_quote_lag_s"] == 0.0

    def test_session_round_trips_through_disk(self, small_session, tmp_path):
        path = tmp_path / "session.json"
        small_session.save(path)
        restored = ReplaySession.load(path)
        assert len(restored.events) == len(small_session.events)
        assert len(restored.markets) == len(small_session.markets)
        assert restored.truth.keys() == small_session.truth.keys()

    def test_is_tagged_synthetic(self, small_session):
        assert small_session.synthetic is True
        assert "WARNING" in small_session.meta


class TestEngine:
    @pytest.fixture(scope="class")
    def result(self, tmp_path_factory):
        from pmbot.config import Settings

        tmp = tmp_path_factory.mktemp("bt")
        settings = Settings(
            database_url=f"sqlite:///{tmp}/bt.db", log_dir=tmp, model_dir=tmp,
            ml_enabled=False, enabled_strategies=STRATEGIES,
            market_anchor_weight=1.0, adaptive_anchor=False,
        )
        session = generate_synthetic_session(SyntheticConfig(
            assets=("BTC", "ETH"), windows=8, seed=11, market_efficiency=0.0,
            exchange_noise_bps=0.3,
        ))
        engine = BacktestEngine(
            settings, session, BacktestConfig(decision_interval=1.0, label="test", seed=11)
        )
        return engine.run()

    def test_produces_a_manifest_for_reproducibility(self, result):
        manifest = result.manifest
        for key in ("run_id", "seed", "code_commit", "config_hash", "config",
                    "session", "dataset"):
            assert key in manifest
        assert manifest["synthetic"] is True

    def test_harvests_a_labelled_dataset(self, result):
        labelled = result.dataset.labelled
        assert len(labelled) > 100
        assert all(s.label in (0, 1) for s in labelled.samples)

    def test_no_sample_is_taken_after_its_window_closed(self, result):
        for sample in result.dataset.samples:
            assert sample.timestamp < sample.window_end

    def test_every_trade_reconciles_exactly(self, result):
        """P&L must equal payoff - cost - fees, to the cent."""
        for trade in result.trades:
            payoff = trade.size if trade.won else 0.0
            expected = payoff - trade.size * trade.entry_price - trade.fees
            assert trade.pnl == pytest.approx(expected, abs=1e-9)

    def test_report_total_matches_the_trades(self, result):
        assert result.report.total_pnl == pytest.approx(
            sum(t.pnl for t in result.trades), abs=1e-9
        )

    def test_trades_never_exceed_the_configured_cap(self, result):
        for trade in result.trades:
            assert trade.size * trade.entry_price <= 20.0 + 1e-6

    def test_entry_prices_are_inside_the_unit_interval(self, result):
        for trade in result.trades:
            assert 0.0 < trade.entry_price < 1.0

    def test_diagnostics_explain_the_rejections(self, result):
        assert result.diagnostics["evaluations"] > 0
        assert isinstance(result.diagnostics["top_blockers"], list)

    def test_calibration_by_horizon_is_reported(self, result):
        horizons = result.calibration_by_horizon()
        assert horizons
        for row in horizons.values():
            assert row["n"] >= 20
            assert "ece_floor" in row

    def test_result_saves(self, result, tmp_path):
        path = result.save(tmp_path)
        assert path.exists()

    def test_empty_session_is_rejected(self, tmp_path):
        from pmbot.config import Settings

        settings = Settings(
            database_url=f"sqlite:///{tmp_path}/x.db", log_dir=tmp_path,
            model_dir=tmp_path,
        )
        with pytest.raises(ValueError, match="no events"):
            BacktestEngine(settings, ReplaySession([], [], {})).run()


class TestNegativeControl:
    def test_an_efficient_market_produces_almost_no_trades(self, tmp_path):
        """If the bot trades heavily against a perfectly-priced market, the edge
        calculation is wrong.  This is the single most important test here."""
        from pmbot.config import Settings

        settings = Settings(
            database_url=f"sqlite:///{tmp_path}/bt.db", log_dir=tmp_path,
            model_dir=tmp_path, ml_enabled=False, enabled_strategies=STRATEGIES,
        )
        session = generate_synthetic_session(SyntheticConfig(
            assets=("BTC", "ETH"), windows=8, seed=5, market_efficiency=1.0,
        ))
        result = BacktestEngine(
            settings, session, BacktestConfig(decision_interval=1.0, seed=5)
        ).run()
        evaluations = result.diagnostics["evaluations"]
        assert result.diagnostics["tradable"] <= max(evaluations * 0.005, 5)


class TestMetrics:
    def test_drawdown(self):
        max_dd, pct = drawdown_series([100, 120, 90, 110, 80])
        assert max_dd == pytest.approx(40)
        assert pct == pytest.approx(40 / 120)

    def test_drawdown_of_a_rising_curve_is_zero(self):
        assert drawdown_series([1, 2, 3])[0] == 0

    def test_streaks(self):
        losing, winning = streaks([True, False, False, False, True, True])
        assert losing == 3
        assert winning == 2

    def test_empty_report(self):
        report = evaluate_trades([])
        assert report.trades == 0
        assert report.total_pnl == 0.0

    def test_report_groups_by_dimension(self):
        trades = [
            TradeRecord(f"m{i}", "BTC" if i % 2 else "ETH", "UP", 0, i * 300,
                        0.5, 40, 0.35, 1.0 if i % 3 else -1.0, i % 3 != 0,
                        0.6, 0.55, 0.03, 0.7, "momentum", "TRENDING", "maker")
            for i in range(12)
        ]
        report = evaluate_trades(trades, 1000.0)
        assert set(report.by_asset) == {"BTC", "ETH"}
        assert report.by_strategy["momentum"]["trades"] == 12
        assert report.by_regime["TRENDING"]["trades"] == 12

    def test_maker_share_measured(self):
        trades = [
            TradeRecord("m", "BTC", "UP", 0, 300, 0.5, 40, 0.0, 1.0, True,
                        0.6, 0.55, 0.03, 0.7, "s", "R", style)
            for style in ("maker", "maker", "taker", "taker")
        ]
        assert evaluate_trades(trades).maker_share == pytest.approx(0.5)


class TestMonteCarlo:
    @pytest.fixture
    def trades(self):
        import numpy as np

        rng = np.random.default_rng(3)
        rows = []
        for i in range(150):
            probability = rng.uniform(0.40, 0.70)
            won = bool(rng.uniform() < probability + 0.01)
            entry = probability - 0.025
            fee = 0.07 * entry * (1 - entry) * 40
            pnl = (40 if won else 0) - 40 * entry - fee
            rows.append(TradeRecord(
                f"m{i}", "BTC", "UP", i * 300.0, i * 300.0 + 300, entry, 40.0,
                fee, pnl, won, probability, probability - 0.02, 0.025, 0.7,
                "ensemble", "TRENDING", "maker",
            ))
        return rows

    def test_bootstrap_preserves_the_sample_size(self):
        import numpy as np

        indices = stationary_bootstrap_indices(50, 5.0, np.random.default_rng(0))
        assert len(indices) == 50
        assert indices.min() >= 0 and indices.max() < 50

    def test_bootstrap_produces_a_distribution(self, trades):
        result = bootstrap_trades(trades, 1000.0, MonteCarloConfig(n_paths=300, seed=1))
        assert result.n_paths == 300
        assert result.pnl.p05 < result.pnl.median < result.pnl.p95
        assert 0.0 <= result.probability_profitable <= 1.0

    def test_drawdown_is_path_dependent(self, trades):
        result = bootstrap_trades(trades, 1000.0, MonteCarloConfig(n_paths=300, seed=1))
        assert result.max_drawdown.p95 > result.max_drawdown.p05

    def test_empty_trades_handled(self):
        result = bootstrap_trades([], 1000.0)
        assert result.n_paths == 0

    def test_slippage_stress_reduces_pnl(self, trades):
        baseline = apply_stress(trades, StressScenario("base"), 1000.0)
        worse = apply_stress(
            trades, StressScenario("slip", extra_slippage=0.02), 1000.0
        )
        assert worse.report.total_pnl < baseline.report.total_pnl

    def test_overconfidence_stress_redraws_outcomes(self, trades):
        stressed = apply_stress(
            trades, StressScenario("over", probability_shift=0.05), 1000.0, seed=1
        )
        assert stressed.report.win_rate < evaluate_trades(trades).win_rate + 0.01

    def test_execution_failures_drop_trades(self, trades):
        stressed = apply_stress(
            trades, StressScenario("fail", execution_failure_rate=0.5), 1000.0, seed=1
        )
        assert stressed.trades_kept < len(trades)

    def test_fee_multiplier_applies(self, trades):
        cheap = apply_stress(trades, StressScenario("a", fee_multiplier=1.0), 1000.0)
        dear = apply_stress(trades, StressScenario("b", fee_multiplier=3.0), 1000.0)
        assert dear.report.total_fees > cheap.report.total_fees

    def test_full_robustness_report(self, trades):
        report = run_robustness(trades, 1000.0, MonteCarloConfig(n_paths=200, seed=2))
        assert len(report.stress) >= 8
        assert 0.0 <= report.scenarios_profitable <= 1.0
        assert "scenario" in report.table()


class TestWalkForwardStability:
    """A verdict that cannot tell "unprofitable" from "untested" is a trap.

    The honest failure mode of a walk-forward on five-minute markets is too
    few trades, not instability, and the two call for opposite reactions:
    collect more data versus stop trading the model.
    """

    @staticmethod
    def _slice(index: int, trades: int, expectancy: float) -> SliceResult:
        report = PerformanceReport(trades=trades)
        report.expectancy_per_dollar = expectancy
        return SliceResult(
            index=index, start=float(index), end=float(index) + 1.0,
            n_train_samples=0, n_train_windows=0, model_kind=None,
            calibrated=False, report=report, trades=[], calibration=None,
        )

    def _result(self, spec: list[tuple[int, float]]) -> WalkForwardResult:
        return WalkForwardResult(
            slices=[self._slice(i, n, e) for i, (n, e) in enumerate(spec)],
            combined=PerformanceReport(), combined_calibration=None,
        )

    def test_too_few_traded_slices_is_undecided_not_unstable(self):
        result = self._result([(0, 0.0), (16, -0.05), (2, 0.01), (0, 0.0)])
        assert result.stability == "insufficient evidence"
        assert not result.is_stable
        assert "2 of 4" not in result.stability_detail()
        assert "1 of 4 slice(s) reached 5 trades" in result.stability_detail()

    def test_majority_positive_is_stable(self):
        result = self._result([(10, 0.02), (10, 0.03), (10, -0.01)])
        assert result.stability == "stable"
        assert result.is_stable
        assert "2 of 3 scored slice(s) had positive" in result.stability_detail()

    def test_majority_negative_is_unstable(self):
        result = self._result([(10, -0.02), (10, 0.03), (10, -0.01)])
        assert result.stability == "unstable"
        assert not result.is_stable

    def test_thin_slices_do_not_count_toward_the_verdict(self):
        """Four slices, but only three traded enough to be scored."""
        result = self._result([(4, 5.0), (10, 0.02), (10, 0.02), (10, 0.02)])
        assert len(result.scored_slices) == 3
        assert result.stability == "stable"

    def test_verdict_is_serialised(self, tmp_path):
        result = self._result([(0, 0.0)])
        import json
        payload = json.loads(result.save(tmp_path / "wf.json").read_text())
        assert payload["stability"] == "insufficient evidence"
        assert payload["is_stable"] is False
        assert payload["stability_detail"]


class TestSeedSweep:
    """Pooling several worlds, because one world's twenty trades prove nothing."""

    @staticmethod
    def _trade(index: int, pnl: float, entry: float = 0.50) -> TradeRecord:
        return TradeRecord(
            market_id=f"m{index}", asset="BTC", outcome="UP",
            opened_at=1.7e9 + index * 300, closed_at=1.7e9 + index * 300 + 300,
            entry_price=entry, size=40.0, fees=0.5, pnl=pnl, won=pnl > 0,
            model_probability=entry + 0.03, market_probability=entry,
            edge=0.03, confidence=0.7, strategy="s", regime="TRENDING",
            execution_style="maker",
        )

    def _run(self, pnls: list[float]) -> WalkForwardResult:
        trades = [self._trade(i, pnl) for i, pnl in enumerate(pnls)]
        report = evaluate_trades(trades, 1000.0)
        slice_result = SliceResult(
            index=0, start=0.0, end=1.0, n_train_samples=0, n_train_windows=0,
            model_kind="logistic", calibrated=True, report=report,
            trades=trades, calibration=None,
        )
        return WalkForwardResult(
            slices=[slice_result], combined=report, combined_calibration=None,
        )

    def _sweep(self) -> SeedSweepResult:
        return SeedSweepResult(runs=[
            (1, self._run([-8.0, -8.0, 4.0])),      # loses
            (2, self._run([20.0, 4.0, 4.0])),       # wins
            (3, self._run([-8.0, 4.0, 4.0])),       # loses
        ])

    def test_pooling_spans_every_seed(self):
        sweep = self._sweep()
        assert len(sweep.pooled_trades) == 9
        assert sweep.pooled.trades == 9
        assert sweep.pooled.total_pnl == pytest.approx(16.0)

    def test_one_lucky_seed_does_not_hide_the_rest(self):
        sweep = self._sweep()
        assert sweep.seeds_profitable == 1
        assert "1/3" in sweep.summary()
        best = max(r.combined.total_pnl for _, r in sweep.runs)
        assert best > sweep.pooled.total_pnl / 3.0

    def test_summary_reports_the_spread(self):
        summary = self._sweep().summary()
        assert "worst -12.00" in summary
        assert "best +28.00" in summary
        assert "median +0.00" in summary

    def test_path_dependent_fields_are_left_out_of_the_pooled_block(self):
        """Concatenating independent worlds is not a path, so no drawdown."""
        summary = self._sweep().summary()
        assert "drawdown" not in summary.lower()
        assert "streak" not in summary.lower()
        assert "sharpe" not in summary.lower()

    def test_table_has_one_row_per_seed(self):
        table = self._sweep().table()
        body = [ln for ln in table.splitlines() if ln and not ln.startswith("-")]
        assert len(body) == 4                      # header + three seeds
        assert body[0].split()[0] == "seed"

    def test_serialisation_keeps_per_seed_detail(self, tmp_path):
        import json
        payload = json.loads(self._sweep().save(tmp_path / "s.json").read_text())
        assert payload["seeds"] == [1, 2, 3]
        assert payload["seeds_profitable"] == 1
        assert len(payload["per_seed"]) == 3
        assert payload["pooled"]["trades"] == 9

    def test_an_empty_sweep_does_not_explode(self):
        sweep = SeedSweepResult(runs=[])
        assert sweep.pooled.trades == 0
        assert sweep.seeds_profitable == 0
        assert "seeds                 0" in sweep.summary()
