"""Backtesting: replay, walk-forward validation and robustness testing."""

from .engine import BacktestConfig, BacktestEngine, BacktestResult
from .metrics import PerformanceReport, TradeRecord, evaluate_trades, format_report
from .montecarlo import MonteCarloConfig, RobustnessReport, run_robustness
from .replay import ReplaySession, SyntheticConfig, generate_synthetic_session
from .walkforward import WalkForwardResult, run_walkforward

__all__ = [
    "BacktestConfig", "BacktestEngine", "BacktestResult",
    "PerformanceReport", "TradeRecord", "evaluate_trades", "format_report",
    "MonteCarloConfig", "RobustnessReport", "run_robustness",
    "ReplaySession", "SyntheticConfig", "generate_synthetic_session",
    "WalkForwardResult", "run_walkforward",
]
