"""Monte Carlo robustness testing.

A backtest produces one number from one path.  These tests ask the question that
actually matters before risking money: *how much of that number was luck, and
how much survives when the world is slightly worse than the backtest assumed?*

Two complementary families:

**Resampling** (the same trades, a different order or sample)
  A stationary bootstrap over the realised trades gives the sampling
  distribution of P&L, drawdown and win rate.  Drawdown in particular is
  extremely path-dependent: the same trade set can produce a 5% or a 25% peak
  drawdown depending only on the order in which the losses fall.

**Stress perturbation** (the same decisions, a worse world)
  Each trade is re-priced under adverse assumptions -- more slippage, a wider
  spread, higher latency, a systematically over-confident model, random
  execution failures.  These act on the *economics* of already-taken trades,
  so they answer "what if execution and the model were worse than measured?"
  without re-running the whole replay.

The headline output is the fraction of scenarios that remain profitable.  A
strategy whose edge survives only the exact assumptions of its own backtest is
not a strategy.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from ..polymarket.fees import FeeSchedule
from .metrics import PerformanceReport, TradeRecord, drawdown_series, evaluate_trades


@dataclass
class MonteCarloConfig:
    n_paths: int = 2000
    block_size: int = 5              # stationary-bootstrap mean block length
    seed: int = 42
    confidence: float = 0.90


@dataclass
class Distribution:
    mean: float
    median: float
    std: float
    p05: float
    p25: float
    p75: float
    p95: float
    worst: float
    best: float

    @classmethod
    def of(cls, values: Sequence[float]) -> Distribution:
        a = np.asarray(list(values), dtype=float)
        if a.size == 0:
            return cls(*([float("nan")] * 9))
        return cls(
            mean=float(a.mean()), median=float(np.median(a)), std=float(a.std()),
            p05=float(np.percentile(a, 5)), p25=float(np.percentile(a, 25)),
            p75=float(np.percentile(a, 75)), p95=float(np.percentile(a, 95)),
            worst=float(a.min()), best=float(a.max()),
        )

    def as_dict(self) -> dict:
        return {
            "mean": self.mean, "median": self.median, "std": self.std,
            "p05": self.p05, "p25": self.p25, "p75": self.p75, "p95": self.p95,
            "worst": self.worst, "best": self.best,
        }


@dataclass
class BootstrapResult:
    n_paths: int
    pnl: Distribution
    max_drawdown: Distribution
    win_rate: Distribution
    longest_losing_streak: Distribution
    probability_profitable: float
    probability_ruin: float
    ruin_threshold: float

    def summary(self) -> str:
        return "\n".join([
            f"paths                 {self.n_paths}",
            f"P&L      median {self.pnl.median:+.2f}   "
            f"[p05 {self.pnl.p05:+.2f}, p95 {self.pnl.p95:+.2f}]   worst {self.pnl.worst:+.2f}",
            f"max DD   median {self.max_drawdown.median:.2f}   "
            f"[p05 {self.max_drawdown.p05:.2f}, p95 {self.max_drawdown.p95:.2f}]   "
            f"worst {self.max_drawdown.worst:.2f}",
            f"win rate median {self.win_rate.median:.2%}   "
            f"[p05 {self.win_rate.p05:.2%}, p95 {self.win_rate.p95:.2%}]",
            f"longest losing streak median {self.longest_losing_streak.median:.0f}   "
            f"p95 {self.longest_losing_streak.p95:.0f}",
            f"P(profitable)         {self.probability_profitable:.1%}",
            f"P(drawdown > {self.ruin_threshold:.0%} of bankroll) {self.probability_ruin:.1%}",
        ])


def stationary_bootstrap_indices(
    n: int, block_size: float, rng: np.random.Generator
) -> np.ndarray:
    """Politis-Romano stationary bootstrap: geometric blocks, wrapping around.

    Preserves short-range dependence (losing streaks are not destroyed) while
    still resampling, which an i.i.d. bootstrap would not do.
    """
    if n == 0:
        return np.array([], dtype=int)
    p = 1.0 / max(block_size, 1.0)
    out = np.empty(n, dtype=int)
    index = int(rng.integers(0, n))
    for i in range(n):
        out[i] = index
        if rng.random() < p:
            index = int(rng.integers(0, n))
        else:
            index = (index + 1) % n
    return out


def bootstrap_trades(
    trades: Sequence[TradeRecord],
    starting_equity: float,
    config: MonteCarloConfig | None = None,
    ruin_threshold: float = 0.25,
) -> BootstrapResult:
    cfg = config or MonteCarloConfig()
    rng = np.random.default_rng(cfg.seed)
    if not trades:
        nan = Distribution.of([])
        return BootstrapResult(0, nan, nan, nan, nan, 0.0, 0.0, ruin_threshold)

    pnls = np.array([t.pnl for t in trades], dtype=float)
    wins = np.array([1 if t.won else 0 for t in trades], dtype=int)

    pnl_paths: list[float] = []
    dd_paths: list[float] = []
    win_paths: list[float] = []
    streak_paths: list[float] = []
    ruined = 0

    for _ in range(cfg.n_paths):
        idx = stationary_bootstrap_indices(len(pnls), cfg.block_size, rng)
        path = pnls[idx]
        equity = starting_equity + np.cumsum(path)
        max_dd, max_dd_pct = drawdown_series([starting_equity, *equity.tolist()])
        pnl_paths.append(float(path.sum()))
        dd_paths.append(max_dd)
        win_paths.append(float(wins[idx].mean()))

        longest = current = 0
        for won in wins[idx]:
            current = 0 if won else current + 1
            longest = max(longest, current)
        streak_paths.append(float(longest))
        if max_dd_pct >= ruin_threshold:
            ruined += 1

    return BootstrapResult(
        n_paths=cfg.n_paths,
        pnl=Distribution.of(pnl_paths),
        max_drawdown=Distribution.of(dd_paths),
        win_rate=Distribution.of(win_paths),
        longest_losing_streak=Distribution.of(streak_paths),
        probability_profitable=float(np.mean([p > 0 for p in pnl_paths])),
        probability_ruin=ruined / cfg.n_paths,
        ruin_threshold=ruin_threshold,
    )


@dataclass
class StressScenario:
    name: str
    extra_slippage: float = 0.0          # added to every entry price
    spread_widening: float = 0.0         # additional half-spread paid
    fee_multiplier: float = 1.0
    probability_shift: float = 0.0       # model over-confidence, in probability
    execution_failure_rate: float = 0.0  # fraction of trades that never fill
    latency_edge_decay: float = 0.0      # fraction of edge lost to being late
    description: str = ""


DEFAULT_SCENARIOS: tuple[StressScenario, ...] = (
    StressScenario("baseline", description="as measured"),
    StressScenario("slippage +1 tick", extra_slippage=0.01,
                   description="every fill one cent worse"),
    StressScenario("slippage +2 ticks", extra_slippage=0.02,
                   description="every fill two cents worse"),
    StressScenario("spread doubles", spread_widening=0.005,
                   description="half a cent of extra spread crossed"),
    StressScenario("fees +50%", fee_multiplier=1.5,
                   description="fee schedule raised"),
    StressScenario("model 2pp overconfident", probability_shift=0.02,
                   description="true probability 2 points worse than predicted"),
    StressScenario("model 5pp overconfident", probability_shift=0.05,
                   description="true probability 5 points worse than predicted"),
    StressScenario("10% orders fail", execution_failure_rate=0.10,
                   description="fills lost to rejects/timeouts"),
    StressScenario("latency eats 30% of edge", latency_edge_decay=0.30,
                   description="slower than the backtest assumed"),
    StressScenario(
        "combined adverse", extra_slippage=0.01, spread_widening=0.005,
        fee_multiplier=1.2, probability_shift=0.02, execution_failure_rate=0.05,
        latency_edge_decay=0.20,
        description="everything mildly worse at once",
    ),
)


@dataclass
class StressResult:
    scenario: StressScenario
    report: PerformanceReport
    trades_kept: int

    def row(self) -> dict:
        return {
            "scenario": self.scenario.name,
            "trades": self.report.trades,
            "win_rate": self.report.win_rate,
            "pnl": self.report.total_pnl,
            "expectancy_per_dollar": self.report.expectancy_per_dollar,
            "max_drawdown": self.report.max_drawdown,
            "profitable": self.report.total_pnl > 0,
        }


def apply_stress(
    trades: Sequence[TradeRecord],
    scenario: StressScenario,
    starting_equity: float,
    seed: int = 42,
    fee_rate: float = 0.07,
) -> StressResult:
    """Re-price the realised trades under adverse assumptions.

    The *decisions* are held fixed and only the economics change, so this
    isolates execution and model-quality risk from signal risk.  Outcomes are
    re-drawn when the scenario shifts the model's probability, because an
    over-confident model does not just earn less on the same wins -- it wins
    less often.
    """
    rng = np.random.default_rng(seed)
    schedule = FeeSchedule(taker_rate=fee_rate * scenario.fee_multiplier)
    stressed: list[TradeRecord] = []

    for trade in trades:
        if scenario.execution_failure_rate > 0 and rng.random() < scenario.execution_failure_rate:
            continue

        entry = min(
            trade.entry_price + scenario.extra_slippage + scenario.spread_widening,
            0.9999,
        )
        fee = schedule.total(entry, trade.size)

        true_probability = trade.model_probability
        if scenario.probability_shift > 0:
            # Shift toward 0.5: the model was over-confident in its direction.
            true_probability = max(
                0.0, trade.model_probability - scenario.probability_shift
            )
            won = bool(rng.random() < true_probability)
        else:
            won = trade.won

        if scenario.latency_edge_decay > 0:
            # Being late means part of the move has already happened, so the
            # price we get is worse by that fraction of the original edge.
            entry = min(entry + scenario.latency_edge_decay * max(trade.edge, 0.0), 0.9999)
            fee = schedule.total(entry, trade.size)

        payoff = trade.size if won else 0.0
        pnl = payoff - trade.size * entry - fee
        stressed.append(TradeRecord(
            market_id=trade.market_id, asset=trade.asset, outcome=trade.outcome,
            opened_at=trade.opened_at, closed_at=trade.closed_at,
            entry_price=entry, size=trade.size, fees=fee, pnl=pnl, won=won,
            model_probability=trade.model_probability,
            market_probability=trade.market_probability,
            edge=trade.edge * (1.0 - scenario.latency_edge_decay)
            - scenario.extra_slippage - scenario.spread_widening,
            confidence=trade.confidence, strategy=trade.strategy,
            regime=trade.regime, execution_style=trade.execution_style,
        ))

    return StressResult(
        scenario=scenario,
        report=evaluate_trades(stressed, starting_equity),
        trades_kept=len(stressed),
    )


@dataclass
class RobustnessReport:
    bootstrap: BootstrapResult
    stress: list[StressResult] = field(default_factory=list)

    @property
    def scenarios_profitable(self) -> float:
        if not self.stress:
            return 0.0
        return sum(1 for s in self.stress if s.report.total_pnl > 0) / len(self.stress)

    def table(self) -> str:
        headers = ["scenario", "trades", "win%", "pnl", "exp/$", "maxDD", "ok"]
        rows = []
        for result in self.stress:
            row = result.row()
            rows.append([
                row["scenario"][:28], str(row["trades"]), f"{row['win_rate']:.1%}",
                f"{row['pnl']:+.2f}", f"{row['expectancy_per_dollar']:+.5f}",
                f"{row['max_drawdown']:.2f}", "yes" if row["profitable"] else "NO",
            ])
        widths = [
            max(len(h), *(len(r[i]) for r in rows)) if rows else len(h)
            for i, h in enumerate(headers)
        ]
        header_line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
        separator = "  ".join("-" * w for w in widths)
        body = "\n".join("  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in rows)
        return f"{header_line}\n{separator}\n{body}"

    def as_dict(self) -> dict:
        return {
            "bootstrap": {
                "n_paths": self.bootstrap.n_paths,
                "pnl": self.bootstrap.pnl.as_dict(),
                "max_drawdown": self.bootstrap.max_drawdown.as_dict(),
                "win_rate": self.bootstrap.win_rate.as_dict(),
                "longest_losing_streak": self.bootstrap.longest_losing_streak.as_dict(),
                "probability_profitable": self.bootstrap.probability_profitable,
                "probability_ruin": self.bootstrap.probability_ruin,
            },
            "stress": [s.row() for s in self.stress],
            "scenarios_profitable": self.scenarios_profitable,
        }


def run_robustness(
    trades: Sequence[TradeRecord],
    starting_equity: float,
    config: MonteCarloConfig | None = None,
    scenarios: Sequence[StressScenario] | None = None,
    fee_rate: float = 0.07,
) -> RobustnessReport:
    cfg = config or MonteCarloConfig()
    bootstrap = bootstrap_trades(trades, starting_equity, cfg)
    stress = [
        apply_stress(trades, scenario, starting_equity, cfg.seed, fee_rate)
        for scenario in (scenarios or DEFAULT_SCENARIOS)
    ]
    return RobustnessReport(bootstrap=bootstrap, stress=stress)
