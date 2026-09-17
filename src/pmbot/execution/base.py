"""Execution venue interface and duplicate-order protection.

Both the paper and live venues implement the same contract, so the strategy and
risk layers cannot tell them apart -- which is the only way paper results mean
anything.

:class:`OrderGuard` is the last line of defence against the class of bug that
actually costs money in production: the same order sent twice because a retry
raced a slow acknowledgement.  Every request carries an idempotency key and a
semantic fingerprint; the guard rejects a repeat of either within a time window.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass

from ..core.types import Fill, OrderRequest, OrderResult
from ..logging_setup import get_logger


@dataclass
class ExecutionStats:
    submitted: int = 0
    filled: int = 0
    partially_filled: int = 0
    rejected: int = 0
    cancelled: int = 0
    duplicates_blocked: int = 0
    errors: int = 0
    total_fees: float = 0.0
    total_notional: float = 0.0
    total_slippage: float = 0.0
    maker_fills: int = 0
    taker_fills: int = 0

    @property
    def fill_rate(self) -> float:
        return self.filled / self.submitted if self.submitted else 0.0

    @property
    def avg_slippage(self) -> float:
        total = self.filled + self.partially_filled
        return self.total_slippage / total if total else 0.0

    def as_dict(self) -> dict:
        return {
            "submitted": self.submitted, "filled": self.filled,
            "partial": self.partially_filled, "rejected": self.rejected,
            "cancelled": self.cancelled, "duplicates_blocked": self.duplicates_blocked,
            "errors": self.errors, "fill_rate": round(self.fill_rate, 4),
            "total_fees": round(self.total_fees, 4),
            "total_notional": round(self.total_notional, 2),
            "avg_slippage": round(self.avg_slippage, 5),
            "maker_fills": self.maker_fills, "taker_fills": self.taker_fills,
        }


class OrderGuard:
    """Blocks duplicate and near-duplicate submissions."""

    def __init__(self, window_seconds: float = 30.0, max_entries: int = 2000):
        self.window = window_seconds
        self._keys: dict[str, float] = {}
        self._fingerprints: dict[str, float] = {}
        self._order: deque[tuple[str, str]] = deque(maxlen=max_entries)
        self.log = get_logger("pmbot.execution.guard")

    @staticmethod
    def fingerprint(request: OrderRequest) -> str:
        """Semantic identity: same token, side, price bucket and size bucket."""
        return (
            f"{request.token_id}|{request.side.value}|"
            f"{round(request.price, 4)}|{round(request.size, 2)}"
        )

    def check(self, request: OrderRequest, now: float | None = None) -> str | None:
        """``None`` when the order may proceed, else the rejection reason."""
        now = time.time() if now is None else now
        self._expire(now)

        key = request.idempotency_key()
        if key in self._keys:
            return "duplicate idempotency key"
        fingerprint = self.fingerprint(request)
        seen_at = self._fingerprints.get(fingerprint)
        if seen_at is not None:
            return f"identical order sent {now - seen_at:.1f}s ago"
        return None

    def register(self, request: OrderRequest, now: float | None = None) -> None:
        now = time.time() if now is None else now
        key = request.idempotency_key()
        fingerprint = self.fingerprint(request)
        self._keys[key] = now
        self._fingerprints[fingerprint] = now
        self._order.append((key, fingerprint))

    def release(self, request: OrderRequest) -> None:
        """Forget a fingerprint after a cancel, so a genuine re-quote is allowed."""
        self._fingerprints.pop(self.fingerprint(request), None)

    def _expire(self, now: float) -> None:
        cutoff = now - self.window
        for store in (self._keys, self._fingerprints):
            for key in [k for k, ts in store.items() if ts < cutoff]:
                del store[key]


class ExecutionVenue(ABC):
    """Where orders go."""

    name = "abstract"
    is_live = False

    def __init__(self):
        self.stats = ExecutionStats()
        self.guard = OrderGuard()
        self.log = get_logger(f"pmbot.execution.{self.name}")

    @abstractmethod
    async def submit(self, request: OrderRequest) -> OrderResult: ...

    @abstractmethod
    async def cancel(self, order_id: str) -> bool: ...

    async def cancel_all(self) -> int:
        return 0

    async def poll(self, now: float | None = None) -> list[OrderResult]:
        """Progress resting orders.  Returns results that changed state."""
        return []

    def open_orders(self) -> list[OrderResult]:
        return []

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    # ------------------------------------------------------------- utilities
    def _validate(self, request: OrderRequest, tick_size: float, min_size: float) -> str | None:
        """Pre-flight checks shared by every venue."""
        if request.size <= 0:
            return f"invalid size {request.size}"
        if request.size < min_size - 1e-9:
            return f"size {request.size} below venue minimum {min_size}"
        if not 0.0 < request.price < 1.0:
            return f"price {request.price} outside (0, 1)"
        if tick_size > 0:
            ticks = request.price / tick_size
            if abs(ticks - round(ticks)) > 1e-6:
                return f"price {request.price} not a multiple of tick {tick_size}"
        if not request.token_id:
            return "missing token id"
        return None

    def record_fill(self, fill: Fill, slippage: float = 0.0) -> None:
        self.stats.total_fees += fill.fee
        self.stats.total_notional += fill.size * fill.price
        self.stats.total_slippage += slippage
        if fill.is_maker:
            self.stats.maker_fills += 1
        else:
            self.stats.taker_fills += 1


def round_to_tick(price: float, tick_size: float, side_up: bool = True) -> float:
    """Snap a price onto the venue's tick grid.

    Rounds *against* us (a buy rounds up) so a rounded order is never
    accidentally more aggressive than intended.
    """
    if tick_size <= 0:
        return price
    ticks = price / tick_size
    import math

    snapped = (math.ceil(ticks) if side_up else math.floor(ticks)) * tick_size
    # Keep strictly inside (0, 1) and on grid.
    snapped = min(max(snapped, tick_size), 1.0 - tick_size)
    return round(snapped, 6)
