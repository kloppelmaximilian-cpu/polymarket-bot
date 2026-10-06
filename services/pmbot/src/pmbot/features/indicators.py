"""Causal technical indicators.

Every function here consumes a series ordered oldest -> newest and returns the
value **as of the last element only**.  Nothing peeks forward, which is what
makes the same code safe to use in both live trading and the backtester.

They are deliberately plain-Python/NumPy rather than a TA library: the series
are short (hundreds of points), the call sites are hot, and an extra dependency
whose windowing conventions we would have to audit buys nothing here.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def _arr(values: Sequence[float]) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    return a[np.isfinite(a)]


def sma(values: Sequence[float], period: int) -> float | None:
    a = _arr(values)
    if len(a) < period or period <= 0:
        return None
    return float(a[-period:].mean())


def ema(values: Sequence[float], period: int) -> float | None:
    a = _arr(values)
    if len(a) == 0 or period <= 0:
        return None
    alpha = 2.0 / (period + 1.0)
    out = a[0]
    for value in a[1:]:
        out = alpha * value + (1 - alpha) * out
    return float(out)


def ema_series(values: Sequence[float], period: int) -> np.ndarray:
    a = _arr(values)
    if len(a) == 0:
        return a
    alpha = 2.0 / (period + 1.0)
    out = np.empty_like(a)
    out[0] = a[0]
    for i in range(1, len(a)):
        out[i] = alpha * a[i] + (1 - alpha) * out[i - 1]
    return out


def rsi(values: Sequence[float], period: int = 14) -> float | None:
    """Wilder's RSI in [0, 100]; 50 means no directional pressure."""
    a = _arr(values)
    if len(a) < period + 1:
        return None
    deltas = np.diff(a)
    gains = np.clip(deltas, 0, None)
    losses = -np.clip(deltas, None, 0)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss <= 1e-12:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return float(100.0 - 100.0 / (1.0 + rs))


def macd(
    values: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[float, float, float] | None:
    """Returns ``(macd_line, signal_line, histogram)``."""
    a = _arr(values)
    if len(a) < slow + signal:
        return None
    fast_line = ema_series(a, fast)
    slow_line = ema_series(a, slow)
    macd_line = fast_line - slow_line
    signal_line = ema_series(macd_line, signal)
    return float(macd_line[-1]), float(signal_line[-1]), float(macd_line[-1] - signal_line[-1])


def bollinger_position(values: Sequence[float], period: int = 20, k: float = 2.0) -> float | None:
    """Where the last price sits in its band: -1 = lower, 0 = mid, +1 = upper."""
    a = _arr(values)
    if len(a) < period:
        return None
    window = a[-period:]
    mean = window.mean()
    std = window.std(ddof=0)
    if std <= 1e-12:
        return 0.0
    return float((a[-1] - mean) / (k * std))


def rate_of_change(values: Sequence[float], period: int) -> float | None:
    a = _arr(values)
    if len(a) <= period or a[-period - 1] == 0:
        return None
    return float(a[-1] / a[-period - 1] - 1.0)


def stochastic(values: Sequence[float], period: int = 14) -> float | None:
    """%K in [0, 100] over the recent range."""
    a = _arr(values)
    if len(a) < period:
        return None
    window = a[-period:]
    low, high = window.min(), window.max()
    if high - low <= 1e-12:
        return 50.0
    return float((a[-1] - low) / (high - low) * 100.0)


def atr_proxy(values: Sequence[float], period: int = 14) -> float | None:
    """Mean absolute change -- an ATR stand-in for a pure mid-price series."""
    a = _arr(values)
    if len(a) < period + 1:
        return None
    return float(np.abs(np.diff(a[-(period + 1):])).mean())


def adx_proxy(values: Sequence[float], period: int = 14) -> float | None:
    """Trend strength in [0, 100] from the net move over total travel.

    A true ADX needs OHLC bars; on a tick mid-series the efficiency ratio
    captures the same "is this trending or chopping" question.
    """
    a = _arr(values)
    if len(a) < period + 1:
        return None
    window = a[-(period + 1):]
    net = abs(window[-1] - window[0])
    travel = float(np.abs(np.diff(window)).sum())
    if travel <= 1e-12:
        return 0.0
    return float(net / travel * 100.0)


def vwap(prices: Sequence[float], sizes: Sequence[float]) -> float | None:
    p = np.asarray(prices, dtype=float)
    s = np.asarray(sizes, dtype=float)
    if len(p) == 0 or len(p) != len(s):
        return None
    total = s.sum()
    if total <= 0:
        return float(p.mean())
    return float((p * s).sum() / total)


def zscore(values: Sequence[float], lookback: int | None = None) -> float | None:
    a = _arr(values)
    if lookback:
        a = a[-lookback:]
    if len(a) < 3:
        return None
    std = a.std(ddof=1)
    if std <= 1e-12:
        return 0.0
    return float((a[-1] - a.mean()) / std)


def linear_slope(timestamps: Sequence[float], values: Sequence[float]) -> float | None:
    """Least-squares slope in units of value per second."""
    t = np.asarray(timestamps, dtype=float)
    v = np.asarray(values, dtype=float)
    if len(t) < 3 or len(t) != len(v):
        return None
    t = t - t[0]
    var = ((t - t.mean()) ** 2).sum()
    if var <= 1e-12:
        return 0.0
    return float(((t - t.mean()) * (v - v.mean())).sum() / var)


def efficiency_ratio(values: Sequence[float]) -> float | None:
    """Kaufman efficiency ratio in [0, 1]: 1 = pure trend, 0 = pure noise."""
    a = _arr(values)
    if len(a) < 3:
        return None
    travel = float(np.abs(np.diff(a)).sum())
    if travel <= 1e-12:
        return 0.0
    return float(abs(a[-1] - a[0]) / travel)


def lagged_correlation(
    a: Sequence[float], b: Sequence[float], max_lag: int = 5
) -> tuple[int, float]:
    """Lag (in samples) at which ``a`` best predicts ``b``, plus that correlation.

    A positive lag means ``a`` leads ``b`` -- the cross-exchange price-leadership
    signal.  Returns ``(0, 0.0)`` when the series are too short or degenerate.
    """
    x = np.asarray(a, dtype=float)
    y = np.asarray(b, dtype=float)
    n = min(len(x), len(y))
    if n < max_lag * 2 + 4:
        return 0, 0.0
    x, y = x[-n:], y[-n:]
    dx, dy = np.diff(x), np.diff(y)
    if dx.std() <= 1e-15 or dy.std() <= 1e-15:
        return 0, 0.0

    best_lag, best_corr = 0, 0.0
    for lag in range(-max_lag, max_lag + 1):
        if lag > 0:
            u, v = dx[:-lag], dy[lag:]
        elif lag < 0:
            u, v = dx[-lag:], dy[:lag]
        else:
            u, v = dx, dy
        if len(u) < 4 or u.std() <= 1e-15 or v.std() <= 1e-15:
            continue
        corr = float(np.corrcoef(u, v)[0, 1])
        if math.isfinite(corr) and abs(corr) > abs(best_corr):
            best_lag, best_corr = lag, corr
    return best_lag, best_corr


def resample_last(
    series: Sequence[tuple[float, float]], start: float, end: float, step: float
) -> tuple[np.ndarray, np.ndarray]:
    """Last-observation-carried-forward resampling onto a regular grid.

    Only observations with ``timestamp <= grid_point`` are used, so the result
    is strictly causal and safe for feature construction in a backtest.
    """
    if not series or step <= 0 or end <= start:
        return np.array([]), np.array([])
    grid = np.arange(start, end + 1e-9, step)
    out = np.full(len(grid), np.nan)
    idx = 0
    last = np.nan
    ordered = sorted(series, key=lambda r: r[0])
    for i, point in enumerate(grid):
        while idx < len(ordered) and ordered[idx][0] <= point:
            last = ordered[idx][1]
            idx += 1
        out[i] = last
    mask = np.isfinite(out)
    return grid[mask], out[mask]
