"""Time abstraction.

Everything that reads the wall clock goes through a ``Clock`` so backtests can
replay historical time deterministically and tests can control the clock.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime


class Clock:
    """Real time."""

    __slots__ = ()

    def time(self) -> float:
        return time.time()

    def monotonic(self) -> float:
        return time.monotonic()

    def utcnow(self) -> datetime:
        return datetime.now(UTC)

    def is_simulated(self) -> bool:
        return False


class SimulatedClock(Clock):
    """Deterministic clock used by the backtester and unit tests."""

    __slots__ = ("_now", "_start")

    def __init__(self, start: float = 0.0):
        self._now = float(start)
        self._start = float(start)

    def time(self) -> float:
        return self._now

    def monotonic(self) -> float:
        return self._now - self._start

    def utcnow(self) -> datetime:
        return datetime.fromtimestamp(self._now, tz=UTC)

    def set(self, t: float) -> None:
        if t < self._now:
            raise ValueError(f"simulated clock cannot go backwards: {t} < {self._now}")
        self._now = float(t)

    def advance(self, seconds: float) -> float:
        if seconds < 0:
            raise ValueError("cannot advance by a negative amount")
        self._now += seconds
        return self._now

    def is_simulated(self) -> bool:
        return True


_default = Clock()


def default_clock() -> Clock:
    return _default


def parse_iso8601(value: str) -> float:
    """Parse the ISO-8601 timestamps Gamma returns into epoch seconds (UTC)."""
    if not value:
        raise ValueError("empty timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def floor_to_window(epoch: float, window: int = 300) -> float:
    """Floor an epoch second to the start of its N-second UTC grid window."""
    return float(int(epoch) // window * window)
