"""Performance and robustness metrics.

Two families, reported separately because they answer different questions:

* **P&L metrics** (expectancy, profit factor, drawdown, Sharpe/Sortino-like
  ratios) -- did this make money, and how painfully?
* **Probability metrics** (Brier score and skill, log loss, calibration error,
  reliability curve) -- was the *model* any good, independently of sizing and
  execution luck?

The second family matters more on a five-minute binary market.  A hundred trades
is far too few to say anything about P&L, but a hundred *probability forecasts*
is enough to start saying something about calibration -- and a well-calibrated
model with a genuine edge will produce the P&L eventually.

Sharpe-like numbers are labelled "per-trade" rather than annualised.  Annualising
a ratio from a few hundred five-minute bets produces impressive nonsense.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np


@dataclass
class TradeRecord:
    market_id: str
    asset: str
    outcome: str
    opened_at: float
    closed_at: float
    entry_price: float
    size: float
    fees: float
    pnl: float
    won: bool
    model_probability: float
    market_probability: float
    edge: float
    confidence: float
    strategy: str
    regime: str
    execution_style: str = ""

    @property
    def notional(self) -> float:
        return self.size * self.entry_price

    @property
    def return_on_stake(self) -> float:
        return self.pnl / self.notional if self.notional > 0 else 0.0


@dataclass
class PerformanceReport:
    trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    total_pnl: float = 0.0
    total_fees: float = 0.0
    total_notional: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    expectancy: float = 0.0
    expectancy_per_dollar: float = 0.0
    profit_factor: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    sharpe_per_trade: float = 0.0
    sortino_per_trade: float = 0.0
    longest_losing_streak: int = 0
    longest_winning_streak: int = 0
    trades_per_hour: float = 0.0
    hours: float = 0.0
    avg_edge: float = 0.0
    realised_vs_expected_edge: float = 0.0
    maker_share: float = 0.0
    # probability quality
    brier: float = float("nan")
    brier_baseline: float = float("nan")
    brier_skill: float = float("nan")
    log_loss: float = float("nan")
    ece: float = float("nan")
    market_brier: float = float("nan")
    brier_vs_market: float = float("nan")
    equity_curve: list[float] = field(default_factory=list)
    by_asset: dict[str, dict] = field(default_factory=dict)
    by_strategy: dict[str, dict] = field(default_factory=dict)
    by_regime: dict[str, dict] = field(default_factory=dict)

    def as_dict(self) -> dict:
        out = {
            k: v for k, v in self.__dict__.items()
            if k not in ("equity_curve",)
        }
        out["equity_curve_points"] = len(self.equity_curve)
        return out

    def summary(self) -> str:
        def fmt(value: float, digits: int = 4) -> str:
            return "n/a" if value != value else f"{value:.{digits}f}"

        return "\n".join([
            f"trades                {self.trades}",
            f"win rate              {self.win_rate:.2%} ({self.wins}W/{self.losses}L)",
            f"total P&L             {self.total_pnl:+.2f}",
            f"total fees            {self.total_fees:.2f}",
            f"expectancy/trade      {self.expectancy:+.4f}",
            f"expectancy/$ staked   {self.expectancy_per_dollar:+.4f}",
            f"profit factor         {fmt(self.profit_factor, 3)}",
            f"max drawdown          {self.max_drawdown:.2f} ({self.max_drawdown_pct:.2%})",
            f"Sharpe (per trade)    {fmt(self.sharpe_per_trade, 3)}",
            f"Sortino (per trade)   {fmt(self.sortino_per_trade, 3)}",
            f"longest losing streak {self.longest_losing_streak}",
            f"trades/hour           {self.trades_per_hour:.2f}",
            f"avg edge at entry     {self.avg_edge:+.4f}",
            f"realised - expected   {self.realised_vs_expected_edge:+.4f}",
            f"maker fill share      {self.maker_share:.2%}",
            f"Brier                 {fmt(self.brier)}  (baseline {fmt(self.brier_baseline)})",
            f"Brier skill           {fmt(self.brier_skill)}",
            f"calibration error     {fmt(self.ece)}",
            f"Brier vs market       {fmt(self.brier_vs_market)}",
        ])


def drawdown_series(equity: Sequence[float]) -> tuple[float, float]:
    """``(max drawdown in currency, max drawdown as a fraction of peak)``."""
    if not equity:
        return 0.0, 0.0
    peak = equity[0]
    max_dd = 0.0
    max_dd_pct = 0.0
    for value in equity:
        peak = max(peak, value)
        dd = peak - value
        max_dd = max(max_dd, dd)
        if peak > 0:
            max_dd_pct = max(max_dd_pct, dd / peak)
    return max_dd, max_dd_pct


def streaks(wins: Sequence[bool]) -> tuple[int, int]:
    longest_loss = current_loss = 0
    longest_win = current_win = 0
    for won in wins:
        if won:
            current_win += 1
            current_loss = 0
        else:
            current_loss += 1
            current_win = 0
        longest_win = max(longest_win, current_win)
        longest_loss = max(longest_loss, current_loss)
    return longest_loss, longest_win


def evaluate_trades(
    trades: Sequence[TradeRecord], starting_equity: float = 0.0
) -> PerformanceReport:
    report = PerformanceReport()
    if not trades:
        return report

    ordered = sorted(trades, key=lambda t: t.closed_at)
    pnls = np.array([t.pnl for t in ordered], dtype=float)
    wins_mask = pnls > 0

    report.trades = len(ordered)
    report.wins = int(wins_mask.sum())
    report.losses = report.trades - report.wins
    report.win_rate = report.wins / report.trades
    report.total_pnl = float(pnls.sum())
    report.total_fees = float(sum(t.fees for t in ordered))
    report.total_notional = float(sum(t.notional for t in ordered))
    report.avg_win = float(pnls[wins_mask].mean()) if report.wins else 0.0
    report.avg_loss = float(-pnls[~wins_mask].mean()) if report.losses else 0.0
    report.expectancy = float(pnls.mean())
    report.expectancy_per_dollar = (
        report.total_pnl / report.total_notional if report.total_notional > 0 else 0.0
    )
    gross_win = float(pnls[wins_mask].sum())
    gross_loss = float(-pnls[~wins_mask].sum())
    report.profit_factor = (
        gross_win / gross_loss if gross_loss > 0
        else (float("inf") if gross_win > 0 else 0.0)
    )

    equity = starting_equity + np.cumsum(pnls)
    report.equity_curve = equity.tolist()
    report.max_drawdown, report.max_drawdown_pct = drawdown_series(
        [starting_equity, *equity.tolist()]
    )

    # Per-trade risk-adjusted ratios, deliberately not annualised.
    #
    # These are computed on P&L scaled by the *average* stake, not by each
    # trade's own stake.  Return-on-own-stake is degenerate for binaries: every
    # loss is almost exactly -100% of that trade's stake, so the downside
    # dispersion collapses and Sortino explodes into a meaningless number.
    # Scaling by a common denominator keeps the size and price variation that
    # the ratio is supposed to measure.
    mean_notional = report.total_notional / report.trades if report.trades else 1.0
    scale = mean_notional if mean_notional > 1e-9 else 1.0
    returns = pnls / scale
    std = returns.std(ddof=1) if len(returns) > 1 else 0.0
    report.sharpe_per_trade = float(returns.mean() / std) if std > 1e-12 else 0.0
    downside = returns[returns < 0]
    downside_std = downside.std(ddof=1) if len(downside) > 1 else 0.0
    report.sortino_per_trade = (
        float(returns.mean() / downside_std) if downside_std > 1e-12 else 0.0
    )

    report.longest_losing_streak, report.longest_winning_streak = streaks(
        [bool(w) for w in wins_mask]
    )

    span = ordered[-1].closed_at - ordered[0].opened_at
    report.hours = max(span / 3600.0, 1e-9)
    report.trades_per_hour = report.trades / report.hours

    report.avg_edge = float(np.mean([t.edge for t in ordered]))
    report.realised_vs_expected_edge = report.expectancy_per_dollar * float(
        np.mean([t.entry_price for t in ordered])
    ) - report.avg_edge
    maker = sum(1 for t in ordered if "maker" in (t.execution_style or ""))
    report.maker_share = maker / report.trades

    # Probability quality, computed on the traded side.
    from ..probability.calibration import brier_score, evaluate

    probabilities = np.array([t.model_probability for t in ordered])
    outcomes = np.array([1 if t.won else 0 for t in ordered])
    calibration = evaluate(probabilities, outcomes)
    report.brier = calibration.brier
    report.brier_baseline = calibration.brier_baseline
    report.brier_skill = calibration.brier_skill
    report.log_loss = calibration.log_loss
    report.ece = calibration.ece

    market_probabilities = np.array([t.market_probability for t in ordered])
    if np.isfinite(market_probabilities).all():
        report.market_brier = brier_score(market_probabilities, outcomes)
        report.brier_vs_market = report.market_brier - report.brier

    report.by_asset = _group(ordered, lambda t: t.asset)
    report.by_strategy = _group(ordered, lambda t: t.strategy)
    report.by_regime = _group(ordered, lambda t: t.regime)
    return report


def _group(trades: Sequence[TradeRecord], key) -> dict[str, dict]:
    buckets: dict[str, list[TradeRecord]] = {}
    for trade in trades:
        buckets.setdefault(key(trade), []).append(trade)
    out: dict[str, dict] = {}
    for name, rows in buckets.items():
        pnls = np.array([t.pnl for t in rows])
        wins = int((pnls > 0).sum())
        equity = np.cumsum(pnls)
        max_dd, _ = drawdown_series([0.0, *equity.tolist()])
        out[name] = {
            "trades": len(rows),
            "wins": wins,
            "win_rate": wins / len(rows),
            "pnl": float(pnls.sum()),
            "expectancy": float(pnls.mean()),
            "avg_edge": float(np.mean([t.edge for t in rows])),
            "max_drawdown": max_dd,
        }
    return out


def format_report(report: PerformanceReport, title: str = "Performance") -> str:
    lines = [f"=== {title} ===", report.summary()]
    for label, table in (
        ("By asset", report.by_asset),
        ("By strategy", report.by_strategy),
        ("By regime", report.by_regime),
    ):
        if not table:
            continue
        lines.append(f"\n{label}:")
        lines.append(
            f"  {'name':<20} {'n':>5} {'win%':>7} {'pnl':>10} "
            f"{'exp':>9} {'edge':>8} {'maxDD':>8}"
        )
        for name, row in sorted(table.items(), key=lambda kv: -kv[1]["pnl"]):
            lines.append(
                f"  {name:<20} {row['trades']:>5} {row['win_rate']:>6.1%} "
                f"{row['pnl']:>+10.2f} {row['expectancy']:>+9.4f} "
                f"{row['avg_edge']:>+8.4f} {row['max_drawdown']:>8.2f}"
            )
    return "\n".join(lines)
