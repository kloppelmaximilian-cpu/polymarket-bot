"""Live order-book state.

Polymarket sends a full ``book`` snapshot on subscribe and then incremental
``price_change`` deltas.  A delta with ``size == 0`` removes the level.  This
module keeps one :class:`LiveBook` per token, applies deltas, and produces
immutable :class:`BookSnapshot` views for the rest of the system.

Two correctness details that matter in production:

* **Snapshot ordering.**  A delta that arrives before the first snapshot is
  useless (we have no base state), so it is dropped rather than applied to an
  empty book -- applying it would fabricate a one-sided book.
* **Staleness.**  Every book knows when it was last touched; the trade gate
  refuses to act on a book that has gone quiet, because a stale book looks
  exactly like a free lunch.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..core.types import BookSnapshot, PriceLevel, PublicTrade, Side
from ..logging_setup import get_logger


@dataclass
class LiveBook:
    token_id: str
    bids: dict[float, float] = field(default_factory=dict)
    asks: dict[float, float] = field(default_factory=dict)
    tick_size: float = 0.01
    last_update: float = 0.0
    last_snapshot: float = 0.0
    exchange_timestamp: float = 0.0
    updates: int = 0
    has_snapshot: bool = False
    last_trade_price: float | None = None
    last_trade_side: Side | None = None
    last_trade_at: float = 0.0
    best_bid_hint: float | None = None
    best_ask_hint: float | None = None
    _cache: BookSnapshot | None = None
    _cache_version: int = -1

    def apply_snapshot(
        self,
        bids: list[PriceLevel],
        asks: list[PriceLevel],
        exchange_timestamp: float = 0.0,
        tick_size: float | None = None,
        now: float | None = None,
    ) -> None:
        now = time.time() if now is None else now
        self.bids = {lvl.price: lvl.size for lvl in bids if lvl.size > 0}
        self.asks = {lvl.price: lvl.size for lvl in asks if lvl.size > 0}
        if tick_size:
            self.tick_size = tick_size
        self.exchange_timestamp = exchange_timestamp
        self.last_update = now
        self.last_snapshot = now
        self.has_snapshot = True
        self.updates += 1
        self._cache = None

    def apply_delta(
        self, side: str, price: float, size: float, now: float | None = None
    ) -> bool:
        """Apply one level update.  Returns False when it had to be dropped."""
        if not self.has_snapshot:
            return False
        if not 0.0 < price < 1.0:
            return False
        book = self.bids if side.upper() in ("BUY", "BID") else self.asks
        if size <= 0:
            book.pop(price, None)
        else:
            book[price] = size
        self.last_update = time.time() if now is None else now
        self.updates += 1
        self._cache = None
        return True

    def note_trade(self, price: float, side: Side | None, now: float | None = None) -> None:
        self.last_trade_price = price
        self.last_trade_side = side
        self.last_trade_at = time.time() if now is None else now

    def set_tick_size(self, tick: float) -> None:
        if tick > 0:
            self.tick_size = tick
            self._cache = None

    def snapshot(self, now: float | None = None) -> BookSnapshot:
        if self._cache is not None and self._cache_version == self.updates:
            return self._cache
        bids = [PriceLevel(p, s) for p, s in sorted(self.bids.items(), reverse=True) if s > 0]
        asks = [PriceLevel(p, s) for p, s in sorted(self.asks.items()) if s > 0]
        snap = BookSnapshot(
            token_id=self.token_id,
            bids=bids,
            asks=asks,
            timestamp=self.last_update,
            sequence=self.updates,
            tick_size=self.tick_size,
        )
        self._cache = snap
        self._cache_version = self.updates
        return snap

    def age(self, now: float | None = None) -> float:
        now = time.time() if now is None else now
        return now - self.last_update if self.last_update else float("inf")

    def is_stale(self, max_age: float, now: float | None = None) -> bool:
        return self.age(now) > max_age

    def is_usable(self, max_age: float, now: float | None = None) -> bool:
        if not self.has_snapshot or self.is_stale(max_age, now):
            return False
        snap = self.snapshot(now)
        return (
            snap.best_bid is not None
            and snap.best_ask is not None
            and not snap.is_crossed()
        )


class OrderBookManager:
    """All live books, keyed by token id."""

    def __init__(self, stale_seconds: float = 5.0):
        self.books: dict[str, LiveBook] = {}
        self.stale_seconds = stale_seconds
        self.log = get_logger("pmbot.orderbook")
        self.trades: dict[str, list[PublicTrade]] = {}
        self.dropped_deltas = 0
        self.crossed_books = 0

    def ensure(self, token_id: str) -> LiveBook:
        book = self.books.get(token_id)
        if book is None:
            book = LiveBook(token_id=token_id)
            self.books[token_id] = book
        return book

    def get(self, token_id: str) -> LiveBook | None:
        return self.books.get(token_id)

    def snapshot(self, token_id: str, now: float | None = None) -> BookSnapshot | None:
        book = self.books.get(token_id)
        return book.snapshot(now) if book is not None else None

    def apply_book_event(self, snap: BookSnapshot, now: float | None = None) -> None:
        book = self.ensure(snap.token_id)
        book.apply_snapshot(
            snap.bids, snap.asks, snap.timestamp, snap.tick_size, now=now
        )
        if book.snapshot(now).is_crossed():
            self.crossed_books += 1
            self.log.warning(
                "crossed book after snapshot",
                extra={"token_id": snap.token_id[:16],
                       "bid": book.snapshot(now).best_bid,
                       "ask": book.snapshot(now).best_ask},
            )

    def apply_price_change(
        self, token_id: str, side: str, price: float, size: float,
        now: float | None = None,
    ) -> None:
        book = self.ensure(token_id)
        if not book.apply_delta(side, price, size, now=now):
            self.dropped_deltas += 1

    def record_trade(
        self, token_id: str, price: float, size: float, side: Side | None,
        timestamp: float, keep: int = 400,
    ) -> None:
        book = self.ensure(token_id)
        book.note_trade(price, side, now=timestamp)
        rows = self.trades.setdefault(token_id, [])
        rows.append(PublicTrade(token_id, price, size, side, timestamp))
        if len(rows) > keep:
            del rows[: len(rows) - keep]

    def recent_trades(
        self, token_id: str, seconds: float, now: float | None = None
    ) -> list[PublicTrade]:
        now = time.time() if now is None else now
        cutoff = now - seconds
        return [t for t in self.trades.get(token_id, []) if t.timestamp >= cutoff]

    def drop(self, token_ids: list[str]) -> None:
        for token_id in token_ids:
            self.books.pop(token_id, None)
            self.trades.pop(token_id, None)

    def prune(self, keep_tokens: set[str]) -> int:
        """Forget books for markets we no longer track (bounded memory)."""
        gone = [t for t in self.books if t not in keep_tokens]
        self.drop(gone)
        return len(gone)

    def health(self, now: float | None = None) -> dict[str, float]:
        now = time.time() if now is None else now
        total = len(self.books)
        fresh = sum(1 for b in self.books.values() if not b.is_stale(self.stale_seconds, now))
        usable = sum(1 for b in self.books.values() if b.is_usable(self.stale_seconds, now))
        return {
            "books": total,
            "fresh": fresh,
            "usable": usable,
            "dropped_deltas": self.dropped_deltas,
            "crossed": self.crossed_books,
        }
