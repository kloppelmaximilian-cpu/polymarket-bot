#!/usr/bin/env python3
"""Cost sensitivity of a thin edge -- the table quoted in the README.

This does **not** measure the bot.  It measures what a fixed, known edge is
worth once the world gets worse than the backtest assumed, which is a question
about arithmetic and cost structure rather than about our model.  Feeding the
stress machinery a *stipulated* 2.5-point edge is the point: the engine's own
synthetic runs produce a handful of trades, far too few for the ten scenarios
to say anything, and a sample whose edge we chose isolates the cost sensitivity
from the noise in our own signal.

The trade sample is built to resemble what these markets actually hand you:
entry prices scattered across 0.40-0.70, outcomes drawn 1.5 points better than
the entry price implies, maker-side fills, and Polymarket's fee curve applied
at the schedule rate.

Run it with no arguments to reproduce the published numbers exactly::

    python scripts/robustness_demo.py

The conclusion it supports is the uncomfortable one: at this edge the strategy
survives an extra tick of slippage, 50% higher fees and a tenth of its orders
failing, but *not* two ticks of slippage and *not* a model that is two points
overconfident.  Calibration accuracy, not execution polish, is the binding
constraint.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pmbot.backtesting.metrics import TradeRecord  # noqa: E402
from pmbot.backtesting.montecarlo import (  # noqa: E402
    MonteCarloConfig,
    run_robustness,
)

# Published-table parameters.  Changing any of these changes the numbers in the
# README, so they are named rather than inlined.
N_TRADES = 240
SAMPLE_SEED = 3
BOOTSTRAP_SEED = 1
BOOTSTRAP_PATHS = 1500
EDGE = 0.025                 # entry this far below the model probability
OUTCOME_TILT = 0.015         # ... of which this much is real
STAKE_SHARES = 40.0
FEE_RATE = 0.07              # Polymarket's taker curve: rate * p * (1 - p)
BANKROLL = 1000.0
WINDOW_SECONDS = 300
PRICE_RANGE = (0.40, 0.70)


def build_sample(
    n_trades: int = N_TRADES, seed: int = SAMPLE_SEED
) -> list[TradeRecord]:
    """A trade set with a known, deliberately thin edge.

    ``model_probability`` is what we would have forecast, ``entry_price`` is
    :data:`EDGE` below it, and the outcome is drawn at the model probability
    plus :data:`OUTCOME_TILT` -- so most, but not all, of the claimed edge is
    real.  Fees follow the fee schedule rather than a flat rate, because the
    curve peaks at 50c and that is exactly where these markets trade.
    """
    rng = np.random.default_rng(seed)
    opened = 1.7e9
    trades: list[TradeRecord] = []
    for i in range(n_trades):
        probability = rng.uniform(*PRICE_RANGE)
        won = bool(rng.uniform() < probability + OUTCOME_TILT)
        entry = probability - EDGE
        fees = FEE_RATE * entry * (1.0 - entry) * STAKE_SHARES
        payoff = STAKE_SHARES if won else 0.0
        trades.append(TradeRecord(
            market_id=f"m{i}", asset="BTC", outcome="UP",
            opened_at=opened + i * WINDOW_SECONDS,
            closed_at=opened + i * WINDOW_SECONDS + WINDOW_SECONDS,
            entry_price=entry, size=STAKE_SHARES, fees=fees,
            pnl=payoff - STAKE_SHARES * entry - fees, won=won,
            model_probability=probability, market_probability=probability - 0.02,
            edge=EDGE, confidence=0.7, strategy="stipulated",
            regime="TRENDING", execution_style="maker",
        ))
    return trades


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trades", type=int, default=N_TRADES)
    parser.add_argument("--seed", type=int, default=SAMPLE_SEED)
    parser.add_argument("--paths", type=int, default=BOOTSTRAP_PATHS)
    args = parser.parse_args()

    trades = build_sample(args.trades, args.seed)
    report = run_robustness(
        trades, BANKROLL,
        MonteCarloConfig(n_paths=args.paths, seed=BOOTSTRAP_SEED),
        fee_rate=FEE_RATE,
    )

    print(__doc__.strip().splitlines()[0])
    print(
        f"\nsample: {len(trades)} trades, stipulated edge {EDGE:+.3f}, "
        f"of which {OUTCOME_TILT:+.3f} is real (seed {args.seed})"
    )
    print(f"\n=== BOOTSTRAP ({args.paths} stationary-bootstrap paths) ===")
    print(report.bootstrap.summary())
    print("\n=== STRESS SCENARIOS ===")
    print(report.table())
    print(f"\nscenarios profitable: {report.scenarios_profitable:.0%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
