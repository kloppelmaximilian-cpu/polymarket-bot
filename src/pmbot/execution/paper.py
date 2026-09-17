"""Paper execution with a realistic fill model.

Paper trading is only useful if it is *pessimistic in the right places*.  This
venue simulates:

* **Latency.**  The book we execute against is the book as it is after the
  configured round trip, not the one that triggered the decision.
* **Book walking.**  A taker order consumes real levels and pays the real
  average price, so slippage is whatever the book says it is.
* **Queue position for makers.**  A resting order is not filled just because
  the market touched its price.  It fills only when trades actually print at or
  through it, and then only for a share of that volume -- because there are
  other orders ahead of us that we cannot see.
* **Fees.**  Taker fees use the market's own schedule; makers pay zero.  The
  maker rebate is *not* credited, because it is a pro-rata share of a daily
  pool and counting on it would flatter the results.
* **Adverse selection.**  A maker order that is still resting when the
  reference price has moved against it is exactly the order that gets filled in
  reality.  The model reflects that by filling makers preferentially when the
  book has moved through them.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field

from ..core.clock import Clock, default_clock
from ..core.types import (
    Fill,
    OrderKind,
    OrderRequest,
    OrderResult,
    OrderState,
    Side,
)
from ..orderbook.book import OrderBookManager
from ..polymarket.fees import FeeSchedule
from .base import ExecutionVenue


@dataclass
class RestingOrder:
    request: OrderRequest
    result: OrderResult
    placed_at: float
    expires_at: float
    #: shares still to be filled at the moment the order started resting
    target_size: float = 0.0
    maker_filled: float = 0.0
    consumed_trade_ids: set[int] = field(default_factory=set)
    last_checked: float = 0.0

    @property
    def remaining(self) -> float:
        return max(0.0, self.target_size - self.maker_filled)


class PaperVenue(ExecutionVenue):
    name = "paper"
    is_live = False

    def __init__(
        self,
        books: OrderBookManager,
        clock: Clock | None = None,
        latency_ms: float = 250.0,
        maker_fill_ratio: float = 0.45,
        queue_model: str = "realistic",
        fee_schedules: dict[str, FeeSchedule] | None = None,
        default_fee: FeeSchedule | None = None,
        order_timeout: float = 30.0,
        seed: int | None = None,
        simulate_latency_sleep: bool = True,
    ):
        super().__init__()
        self.books = books
        self.clock = clock or default_clock()
        self.latency = latency_ms / 1000.0
        self.maker_fill_ratio = maker_fill_ratio
        self.queue_model = queue_model
        self.fee_schedules = fee_schedules or {}
        self.default_fee = default_fee or FeeSchedule()
        self.order_timeout = order_timeout
        self.rng = random.Random(seed)
        self.simulate_latency_sleep = simulate_latency_sleep
        self._resting: dict[str, RestingOrder] = {}
        self._counter = 0

    # ------------------------------------------------------------- plumbing
    def fee_for(self, token_id: str) -> FeeSchedule:
        return self.fee_schedules.get(token_id, self.default_fee)

    def set_fee_schedule(self, token_id: str, schedule: FeeSchedule) -> None:
        self.fee_schedules[token_id] = schedule

    def _next_order_id(self) -> str:
        self._counter += 1
        return f"paper-{self._counter:08d}"

    # -------------------------------------------------------------- submit
    async def submit(self, request: OrderRequest) -> OrderResult:
        now = self.clock.time()
        self.stats.submitted += 1

        duplicate = self.guard.check(request, now)
        if duplicate is not None:
            self.stats.duplicates_blocked += 1
            self.log.warning(
                "duplicate order blocked",
                extra={"reason": duplicate, "token_id": request.token_id[:16]},
            )
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=f"duplicate: {duplicate}", submitted_at=now, finalised_at=now,
            )

        book = self.books.snapshot(request.token_id, now)
        tick = book.tick_size if book is not None else 0.01
        invalid = self._validate(request, tick, min_size=0.0)
        if invalid is not None:
            self.stats.rejected += 1
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=invalid, submitted_at=now, finalised_at=now,
            )

        self.guard.register(request, now)

        # Simulate the round trip.  In a backtest the clock is advanced by the
        # replay loop instead of sleeping.
        if self.simulate_latency_sleep and not self.clock.is_simulated():
            await asyncio.sleep(self.latency)
        now = self.clock.time()
        book = self.books.snapshot(request.token_id, now)

        if book is None or book.is_empty():
            self.stats.rejected += 1
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error="no book at execution time", submitted_at=now, finalised_at=now,
            )

        order_id = self._next_order_id()
        result = OrderResult(request=request, state=OrderState.PENDING,
                             order_id=order_id, submitted_at=now)

        crossing = self._is_crossing(request, book)
        if request.kind in (OrderKind.FOK, OrderKind.FAK) or (
            crossing and not request.post_only
        ):
            return self._execute_taker(request, result, book, now)

        if request.post_only and crossing:
            self.stats.rejected += 1
            result.state = OrderState.REJECTED
            result.error = "post-only order would cross the book"
            result.finalised_at = now
            return result

        # Rest on the book.
        result.state = OrderState.OPEN
        expires = now + (request.expiration if request.expiration else self.order_timeout)
        self._resting[order_id] = RestingOrder(
            request=request, result=result, placed_at=now, expires_at=expires,
            target_size=request.size, last_checked=now,
        )
        return result

    @staticmethod
    def _is_crossing(request: OrderRequest, book) -> bool:
        if request.side is Side.BUY:
            return book.best_ask is not None and request.price >= book.best_ask - 1e-9
        return book.best_bid is not None and request.price <= book.best_bid + 1e-9

    def _execute_taker(self, request, result, book, now) -> OrderResult:
        """Walk the book, respecting the order's limit price."""
        levels = book.asks if request.side is Side.BUY else book.bids
        schedule = self.fee_for(request.token_id)
        remaining = request.size
        fills: list[Fill] = []
        touch = book.best_ask if request.side is Side.BUY else book.best_bid

        for level in levels:
            if remaining <= 1e-9:
                break
            if request.side is Side.BUY and level.price > request.price + 1e-9:
                break
            if request.side is Side.SELL and level.price < request.price - 1e-9:
                break
            take = min(remaining, level.size)
            if take <= 0:
                continue
            fee = schedule.total(level.price, take, is_maker=False)
            fills.append(Fill(
                order_id=result.order_id or "", client_id=request.client_id,
                token_id=request.token_id, side=request.side, price=level.price,
                size=take, fee=fee, timestamp=now, is_maker=False,
            ))
            remaining -= take

        filled = sum(f.size for f in fills)

        if request.kind is OrderKind.FOK and remaining > 1e-9:
            self.stats.rejected += 1
            result.state = OrderState.REJECTED
            result.error = "FOK order could not be filled in full"
            result.finalised_at = now
            return result

        if filled <= 0:
            self.stats.rejected += 1
            result.state = OrderState.REJECTED
            result.error = "no liquidity at or inside the limit price"
            result.finalised_at = now
            return result

        result.fills = fills
        result.filled_size = filled
        result.avg_price = sum(f.size * f.price for f in fills) / filled
        result.fees = sum(f.fee for f in fills)
        slippage = abs(result.avg_price - touch) if touch is not None else 0.0

        if remaining > 1e-9 and request.kind is OrderKind.GTC:
            result.state = OrderState.PARTIAL
            self.stats.partially_filled += 1
            expires = now + self.order_timeout
            leftover = OrderRequest(
                market_id=request.market_id, condition_id=request.condition_id,
                token_id=request.token_id, asset=request.asset, outcome=request.outcome,
                side=request.side, price=request.price, size=remaining,
                kind=request.kind, post_only=request.post_only,
                client_id=request.client_id + "-rest",
                opportunity_id=request.opportunity_id,
            )
            self._resting[result.order_id or ""] = RestingOrder(
                request=leftover, result=result, placed_at=now, expires_at=expires,
                target_size=remaining, last_checked=now,
            )
        else:
            result.state = OrderState.FILLED if remaining <= 1e-9 else OrderState.PARTIAL
            if result.state is OrderState.FILLED:
                self.stats.filled += 1
            else:
                self.stats.partially_filled += 1
            result.finalised_at = now

        for fill in fills:
            self.record_fill(fill, slippage)
        return result

    # ---------------------------------------------------------------- resting
    async def poll(self, now: float | None = None) -> list[OrderResult]:
        """Advance resting orders against observed trades and expiries."""
        now = self.clock.time() if now is None else now
        changed: list[OrderResult] = []

        for order_id in list(self._resting):
            resting = self._resting.get(order_id)
            if resting is None:
                continue
            result = resting.result

            filled_now = self._try_maker_fill(resting, now)
            if filled_now > 0:
                changed.append(result)

            if resting.remaining <= 1e-9:
                del self._resting[order_id]
                result.state = OrderState.FILLED
                result.finalised_at = now
                self.stats.filled += 1
                self.guard.release(resting.request)
                if result not in changed:
                    changed.append(result)
                continue

            if now >= resting.expires_at:
                del self._resting[order_id]
                if result.filled_size > 0:
                    result.state = OrderState.PARTIAL
                    self.stats.partially_filled += 1
                else:
                    result.state = OrderState.EXPIRED
                result.finalised_at = now
                self.guard.release(resting.request)
                if result not in changed:
                    changed.append(result)
        return changed

    def _try_maker_fill(self, resting: RestingOrder, now: float) -> float:
        """Fill a resting order from the trades that printed through it."""
        request, result = resting.request, resting.result
        remaining = resting.remaining
        if remaining <= 1e-9:
            return 0.0

        schedule = self.fee_for(request.token_id)
        trades = self.books.recent_trades(
            request.token_id, max(now - resting.last_checked, 1.0), now
        )
        resting.last_checked = now

        filled = 0.0
        for trade in trades:
            trade_id = id(trade)
            if trade_id in resting.consumed_trade_ids:
                continue
            resting.consumed_trade_ids.add(trade_id)
            if trade.timestamp < resting.placed_at:
                continue
            # A resting BUY is only filled by a print at or below its price.
            if request.side is Side.BUY and trade.price > request.price + 1e-9:
                continue
            if request.side is Side.SELL and trade.price < request.price - 1e-9:
                continue

            share = self.maker_fill_ratio
            if self.queue_model == "realistic":
                # Random queue position: sometimes we are behind everyone.
                share *= self.rng.uniform(0.3, 1.0)
            take = min(remaining - filled, trade.size * share)
            if take <= 1e-9:
                continue
            fee = schedule.total(request.price, take, is_maker=True)
            fill = Fill(
                order_id=result.order_id or "", client_id=request.client_id,
                token_id=request.token_id, side=request.side, price=request.price,
                size=take, fee=fee, timestamp=now, is_maker=True,
            )
            result.fills.append(fill)
            self.record_fill(fill, 0.0)
            filled += take
            if filled >= remaining - 1e-9:
                break

        if filled > 0:
            resting.maker_filled += filled
            total = sum(f.size for f in result.fills)
            result.filled_size = total
            result.avg_price = (
                sum(f.size * f.price for f in result.fills) / total if total > 0 else 0.0
            )
            result.fees = sum(f.fee for f in result.fills)
            if result.state is OrderState.OPEN:
                result.state = OrderState.PARTIAL
        return filled

    async def cancel(self, order_id: str) -> bool:
        resting = self._resting.pop(order_id, None)
        if resting is None:
            return False
        resting.result.state = (
            OrderState.PARTIAL if resting.result.filled_size > 0 else OrderState.CANCELLED
        )
        resting.result.finalised_at = self.clock.time()
        self.stats.cancelled += 1
        self.guard.release(resting.request)
        return True

    async def cancel_all(self) -> int:
        count = len(self._resting)
        for order_id in list(self._resting):
            await self.cancel(order_id)
        return count

    def open_orders(self) -> list[OrderResult]:
        return [r.result for r in self._resting.values()]
