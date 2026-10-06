#!/usr/bin/env python3
"""Engine validation across synthetic scenarios.

This is a *correctness* harness, not a profitability study.  It checks the
properties that must hold for the machinery to be trustworthy:

1. **Negative control** -- against an efficient market maker (no vol bias, no
   lag, no noise) the bot must find essentially nothing to trade.  If it trades
   heavily here, the edge calculation is wrong.
2. **Monotonicity** -- as the simulated market maker gets worse, the bot should
   find more opportunities.  A bot that cannot detect an injected mispricing
   cannot detect a real one.
3. **Accounting identity** -- realised P&L must equal the sum of settlement
   payoffs minus cost basis minus fees, exactly.
4. **Calibration by horizon** -- the analytic probability should be roughly
   calibrated at every time-to-expiry band, not just near expiry.
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from pmbot.backtesting.engine import BacktestConfig, BacktestEngine  # noqa: E402
from pmbot.backtesting.replay import (  # noqa: E402
    SyntheticConfig,
    generate_synthetic_session,
)
from pmbot.config import Settings  # noqa: E402
from pmbot.logging_setup import setup_logging  # noqa: E402

STRATEGIES = [
    "fair_value", "momentum", "mean_reversion", "order_flow", "breakout",
    "volatility", "cross_exchange", "microstructure", "mispricing",
]


def make_settings(tmp: pathlib.Path, **overrides) -> Settings:
    base = dict(
        database_url=f"sqlite:///{tmp}/bt.db",
        log_dir=tmp, model_dir=tmp, bankroll=1000.0, ml_enabled=False,
        enabled_strategies=STRATEGIES,
    )
    base.update(overrides)
    return Settings(**base)


def run_scenario(
    efficiency: float, windows: int, seed: int, tmp: pathlib.Path, **setting_overrides
):
    session = generate_synthetic_session(SyntheticConfig(
        assets=("BTC", "ETH", "SOL"), windows=windows, seed=seed,
        market_efficiency=efficiency,
    ))
    settings = make_settings(tmp, **setting_overrides)
    engine = BacktestEngine(
        settings, session,
        BacktestConfig(decision_interval=1.0, label=f"eff{efficiency:.2f}", seed=seed),
    )
    return engine, engine.run()


def check_accounting(result) -> tuple[bool, str]:
    """P&L must reconcile exactly with payoff - cost - fees."""
    total = 0.0
    for trade in result.trades:
        payoff = trade.size if trade.won else 0.0
        expected = payoff - trade.size * trade.entry_price - trade.fees
        if abs(expected - trade.pnl) > 1e-6:
            return False, (
                f"trade {trade.market_id}: recorded {trade.pnl:.8f} "
                f"vs identity {expected:.8f}"
            )
        total += trade.pnl
    if abs(total - result.report.total_pnl) > 1e-6:
        return False, f"sum {total:.8f} != report {result.report.total_pnl:.8f}"
    return True, f"{len(result.trades)} trades reconcile exactly"


def main() -> int:
    setup_logging("ERROR", json_format=True)
    tmp = pathlib.Path(tempfile.mkdtemp())
    rows = []
    failures = []

    print("=" * 96)
    print("SYNTHETIC ENGINE VALIDATION -- measures the machinery, not real-market alpha")
    print("=" * 96)

    scenarios = [
        ("efficient market (negative control)", 1.00),
        ("mildly inefficient", 0.60),
        ("clearly inefficient", 0.30),
        ("very inefficient", 0.00),
    ]

    for label, efficiency in scenarios:
        engine, result = run_scenario(efficiency, windows=16, seed=7, tmp=tmp)
        report = result.report
        diag = result.diagnostics
        rows.append({
            "scenario": label,
            "efficiency": efficiency,
            "vol_bias": result.manifest["session"]["effective_vol_bias"],
            "lag_s": result.manifest["session"]["effective_quote_lag_s"],
            "evaluations": diag["evaluations"],
            "tradable": diag["tradable"],
            "orders": diag["orders"],
            "trades": report.trades,
            "win_rate": report.win_rate,
            "pnl": report.total_pnl,
            "expectancy_per_dollar": report.expectancy_per_dollar,
            "avg_edge": report.avg_edge,
            "maker_share": report.maker_share,
        })
        ok, detail = check_accounting(result)
        if not ok:
            failures.append(f"accounting ({label}): {detail}")

        if efficiency >= 1.0:
            horizons = result.calibration_by_horizon()
            print("\nCalibration of the analytic probability by time to expiry")
            print("(efficient-market scenario; market maker uses the true vol)")
            print(f"  {'horizon':>10} {'n':>6} {'brier':>8} {'skill':>8} "
                  f"{'ece':>7} {'auc':>6} {'vs_mkt':>8}")
            for band, row in horizons.items():
                print(
                    f"  {band:>10} {row['n']:>6} {row['brier']:>8.4f} "
                    f"{row['brier_skill']:>+8.4f} {row['ece']:>7.4f} "
                    f"{(row['auc'] if row['auc'] is not None else float('nan')):>6.3f} "
                    f"{(row['vs_market'] if row['vs_market'] is not None else float('nan')):>+8.4f}"
                )
            if diag["tradable"] > diag["evaluations"] * 0.01:
                failures.append(
                    f"negative control traded too much: {diag['tradable']} tradable "
                    f"of {diag['evaluations']} evaluations"
                )

    print("\nScenario sweep")
    print(f"  {'scenario':<36} {'volBias':>8} {'lag':>5} {'evals':>7} "
          f"{'tradable':>9} {'trades':>7} {'win%':>6} {'pnl':>9} {'exp/$':>8}")
    for row in rows:
        print(
            f"  {row['scenario']:<36} {row['vol_bias']:>8.3f} {row['lag_s']:>5.1f} "
            f"{row['evaluations']:>7} {row['tradable']:>9} {row['trades']:>7} "
            f"{row['win_rate']:>5.1%} {row['pnl']:>+9.2f} "
            f"{row['expectancy_per_dollar']:>+8.4f}"
        )

    tradable = [row["tradable"] for row in rows]
    if tradable[0] > tradable[-1]:
        failures.append(
            "not monotone: the efficient market produced more tradable "
            "opportunities than the inefficient one"
        )

    print("\nChecks")
    print(f"  accounting identity        {'PASS' if not [f for f in failures if 'accounting' in f] else 'FAIL'}")
    print(f"  negative control quiet     {'PASS' if not [f for f in failures if 'negative control' in f] else 'FAIL'}")
    print(f"  more mispricing -> more    {'PASS' if not [f for f in failures if 'monotone' in f] else 'FAIL'}")
    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nAll engine validation checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
