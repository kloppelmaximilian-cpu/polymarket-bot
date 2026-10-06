"""Execution strategy: how an accepted opportunity becomes fills.

The economics on these markets strongly favour *resting* rather than crossing.
With a one-tick spread and the crypto taker rate of 0.07, buying at the ask at
0.52 against a model probability of 0.56 nets

    0.56 - 0.52 - 0.07*0.52*0.48  =  +0.0225

while resting at the bid of 0.51 as a maker nets

    0.56 - 0.51 - 0             =  +0.0500

-- more than double, because the passive order skips both the spread and the
fee (only takers are charged).  So the default style is **maker first, taker
escalation**:

1. Rest a post-only bid at (or one tick inside) the touch.
2. While it rests, keep re-checking that the edge still exists; the reference
   price moves and a stale resting order is how a maker gets adversely selected.
3. If it has not filled by ``maker_wait_seconds``, and the edge still clears the
   *taker* threshold, cross for the remainder.  Otherwise cancel.

The trade-off is explicit: passive orders capture more edge per fill but fill
less often and are adversely selected, so the escalation deadline is short and
the edge is re-validated on every step.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from ..core.clock import Clock, default_clock
from ..core.types import (
    Opportunity,
    OrderKind,
    OrderRequest,
    OrderResult,
    OrderState,
    Side,
)
from ..logging_setup import get_logger
from ..orderbook.book import OrderBookManager
from ..polymarket.fees import FeeSchedule
from .base import ExecutionVenue, round_to_tick


class WorkingState(str, Enum):
    RESTING = "RESTING"
    ESCALATING = "ESCALATING"
    DONE = "DONE"
    ABANDONED = "ABANDONED"


@dataclass
class WorkingOrder:
    """A maker order being worked toward completion."""

    opportunity: Opportunity
    request: OrderRequest
    result: OrderResult
    placed_at: float
    deadline: float
    state: WorkingState = WorkingState.RESTING
    escalated: bool = False
    fills_seen: float = 0.0
    abandon_reason: str = ""
    history: list[str] = field(default_factory=list)

    @property
    def order_id(self) -> str:
        return self.result.order_id or ""

    @property
    def remaining(self) -> float:
        return max(0.0, self.request.size - self.result.filled_size)


@dataclass
class ExecutionOutcome:
    opportunity: Opportunity
    result: OrderResult | None
    filled_size: float
    avg_price: float
    fees: float
    style: str
    note: str = ""

    @property
    def is_filled(self) -> bool:
        return self.filled_size > 0


class Executor:
    def __init__(
        self,
        venue: ExecutionVenue,
        books: OrderBookManager,
        clock: Clock | None = None,
        style: str = "maker_then_taker",
        maker_wait_seconds: float = 20.0,
        min_seconds_remaining: float = 20.0,
        max_retries: int = 2,
        maker_improve_ticks: int = 0,
        risk: Any = None,
    ):
        self.venue = venue
        self.books = books
        self.clock = clock or default_clock()
        #: optional RiskEngine; used to reserve capital while an order rests so
        #: the next cycle cannot place a second order on the same market.
        self.risk = risk
        self.style = style
        self.maker_wait = maker_wait_seconds
        self.min_seconds_remaining = min_seconds_remaining
        self.max_retries = max_retries
        self.maker_improve_ticks = maker_improve_ticks
        self.log = get_logger("pmbot.executor")
        self.working: dict[str, WorkingOrder] = {}
        self.completed: list[ExecutionOutcome] = []

    # ------------------------------------------------------------------ entry
    async def execute(self, opportunity: Opportunity) -> ExecutionOutcome:
        """Start working an opportunity.  Returns immediately for maker orders."""
        market = opportunity.market
        now = self.clock.time()
        token_id = market.token_id(opportunity.outcome)

        if opportunity.size_shares <= 0:
            return self._abandon(opportunity, "no size")

        book = self.books.snapshot(token_id, now)
        if book is None or book.best_ask is None:
            return self._abandon(opportunity, "no book at execution time")

        tau = market.seconds_remaining(now)
        schedule = FeeSchedule(
            taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
        )

        use_maker = self._should_rest(opportunity, book, tau, schedule)
        if use_maker:
            return await self._place_maker(opportunity, book, schedule, now)
        return await self._place_taker(opportunity, book, now)

    def _should_rest(self, opportunity, book, tau: float, schedule: FeeSchedule) -> bool:
        if self.style == "taker":
            return False
        if self.style == "maker":
            return True
        # maker_then_taker: only rest if there is time to work the order and
        # the passive price offers a materially better edge.
        if tau < self.maker_wait + self.min_seconds_remaining:
            return False
        if book.best_bid is None:
            return False
        maker_price = self._maker_price(book)
        if maker_price is None:
            return False
        maker_edge = opportunity.model_probability - maker_price
        taker_edge = opportunity.net_edge
        return maker_edge > taker_edge * 1.15

    def _maker_price(self, book) -> float | None:
        """Where to rest: join the touch, or improve it if that stays passive."""
        if book.best_bid is None or book.best_ask is None:
            return None
        tick = book.tick_size or 0.01
        price = book.best_bid + self.maker_improve_ticks * tick
        if price >= book.best_ask - 1e-9:
            price = book.best_bid          # improving would cross: just join
        return round_to_tick(price, tick, side_up=False)

    async def _place_maker(self, opportunity, book, schedule, now) -> ExecutionOutcome:
        market = opportunity.market
        price = self._maker_price(book)
        if price is None:
            return await self._place_taker(opportunity, book, now)

        # Re-size at the passive price so the *notional* stays exactly what
        # risk approved.  A lower price buys slightly more shares for the same
        # dollars; sizing by share count instead would silently over-commit.
        if price <= 0:
            return await self._place_taker(opportunity, book, now)
        shares = min(opportunity.notional / price, opportunity.size_shares * 1.25)
        shares = max(shares, market.min_order_size)
        # Never exceed what risk approved, even after the minimum-size floor.
        if shares * price > opportunity.notional * 1.05:
            shares = opportunity.notional / price

        request = OrderRequest(
            market_id=market.market_id, condition_id=market.condition_id,
            token_id=market.token_id(opportunity.outcome), asset=market.asset,
            outcome=opportunity.outcome, side=Side.BUY, price=price, size=shares,
            kind=OrderKind.GTC, post_only=True,
            opportunity_id=opportunity.opportunity_id,
        )
        result = await self.venue.submit(request)

        if result.state in (OrderState.REJECTED, OrderState.EXPIRED):
            self.log.info(
                "maker placement rejected, falling back to taker",
                extra={"error": result.error, "market": market.market_id},
            )
            return await self._place_taker(opportunity, book, now)

        working = WorkingOrder(
            opportunity=opportunity, request=request, result=result,
            placed_at=now, deadline=now + self.maker_wait,
        )
        working.history.append(f"resting {shares:.2f}@{price:.4f}")
        key = working.order_id or request.client_id
        self.working[key] = working
        if self.risk is not None:
            self.risk.reserve(
                key, market.market_id, market.asset, opportunity.outcome,
                shares * price,
            )
        self.log.info(
            "resting maker order",
            extra={
                "market": market.market_id, "asset": market.asset,
                "outcome": opportunity.outcome.value, "price": price,
                "size": round(shares, 2), "deadline_in": round(self.maker_wait, 1),
            },
        )
        return ExecutionOutcome(
            opportunity=opportunity, result=result,
            filled_size=result.filled_size, avg_price=result.avg_price,
            fees=result.fees, style="maker", note="resting",
        )

    async def _place_taker(self, opportunity, book, now, size: float | None = None) -> ExecutionOutcome:
        market = opportunity.market
        shares = size if size is not None else opportunity.size_shares
        if shares < market.min_order_size:
            return self._abandon(opportunity, f"remaining {shares:.2f} below minimum")

        tick = book.tick_size or market.tick_size
        # Limit price protects against the book moving between decision and
        # arrival; FAK takes what is there and cancels the rest.
        limit = round_to_tick(
            min(opportunity.entry_price + 0.01, 1.0 - tick), tick, side_up=True
        )
        request = OrderRequest(
            market_id=market.market_id, condition_id=market.condition_id,
            token_id=market.token_id(opportunity.outcome), asset=market.asset,
            outcome=opportunity.outcome, side=Side.BUY, price=limit, size=shares,
            kind=OrderKind.FAK, post_only=False,
            opportunity_id=opportunity.opportunity_id,
        )
        result = await self.venue.submit(request)
        outcome = ExecutionOutcome(
            opportunity=opportunity, result=result,
            filled_size=result.filled_size, avg_price=result.avg_price,
            fees=result.fees, style="taker",
            note=result.error or result.state.value,
        )
        self.completed.append(outcome)
        self.log.info(
            "taker order complete",
            extra={
                "market": market.market_id, "state": result.state.value,
                "filled": round(result.filled_size, 2),
                "avg_price": round(result.avg_price, 4), "fees": round(result.fees, 4),
            },
        )
        return outcome

    def _abandon(self, opportunity, reason: str) -> ExecutionOutcome:
        outcome = ExecutionOutcome(
            opportunity=opportunity, result=None, filled_size=0.0, avg_price=0.0,
            fees=0.0, style="none", note=reason,
        )
        self.completed.append(outcome)
        return outcome

    # ------------------------------------------------------------------ step
    async def step(
        self, revalidate=None, now: float | None = None
    ) -> list[ExecutionOutcome]:
        """Progress every working order.  Called once per main-loop cycle.

        ``revalidate(opportunity) -> float | None`` returns the *current* net
        taker edge for the opportunity, or ``None`` if it is no longer valid.
        A resting order whose edge has gone is cancelled immediately: that is
        precisely the order that is about to be adversely selected.
        """
        now = self.clock.time() if now is None else now
        await self.venue.poll(now)
        finished: list[ExecutionOutcome] = []

        for key in list(self.working):
            working = self.working.get(key)
            if working is None:
                continue
            opportunity = working.opportunity
            market = opportunity.market
            result = working.result

            if result.filled_size > working.fills_seen:
                working.history.append(
                    f"filled {result.filled_size - working.fills_seen:.2f}"
                )
                working.fills_seen = result.filled_size

            if result.state is OrderState.FILLED:
                working.state = WorkingState.DONE
                finished.append(self._finish(key, working, "maker", "filled"))
                continue

            tau = market.seconds_remaining(now)
            if tau <= self.min_seconds_remaining:
                await self.venue.cancel(working.order_id)
                finished.append(self._finish(key, working, "maker", "window closing"))
                continue

            current_edge = None
            if revalidate is not None:
                current_edge = revalidate(opportunity)
            if revalidate is not None and (current_edge is None or current_edge <= 0):
                await self.venue.cancel(working.order_id)
                finished.append(
                    self._finish(key, working, "maker", "edge disappeared while resting")
                )
                continue

            if now >= working.deadline and not working.escalated:
                working.escalated = True
                remaining = working.remaining
                await self.venue.cancel(working.order_id)
                if remaining < market.min_order_size:
                    finished.append(
                        self._finish(key, working, "maker", "deadline, remainder too small")
                    )
                    continue
                if revalidate is not None and (current_edge is None or current_edge <= 0):
                    finished.append(
                        self._finish(key, working, "maker", "deadline, taker edge gone")
                    )
                    continue
                book = self.books.snapshot(
                    market.token_id(opportunity.outcome), now
                )
                if book is None or book.best_ask is None:
                    finished.append(
                        self._finish(key, working, "maker", "deadline, no book")
                    )
                    continue
                self.working.pop(key, None)
                if self.risk is not None:
                    self.risk.release(key)
                escalated = await self._place_taker(opportunity, book, now, remaining)
                # Merge the maker fills into the reported outcome.
                merged = ExecutionOutcome(
                    opportunity=opportunity,
                    result=escalated.result,
                    filled_size=working.result.filled_size + escalated.filled_size,
                    avg_price=_blend_price(
                        working.result.filled_size, working.result.avg_price,
                        escalated.filled_size, escalated.avg_price,
                    ),
                    fees=working.result.fees + escalated.fees,
                    style="maker_then_taker",
                    note=f"escalated after {self.maker_wait:.0f}s; {escalated.note}",
                )
                finished.append(merged)
                continue

        return finished

    def _finish(self, key: str, working: WorkingOrder, style: str, note: str) -> ExecutionOutcome:
        self.working.pop(key, None)
        if self.risk is not None:
            self.risk.release(key)
        outcome = ExecutionOutcome(
            opportunity=working.opportunity, result=working.result,
            filled_size=working.result.filled_size,
            avg_price=working.result.avg_price, fees=working.result.fees,
            style=style, note=note,
        )
        self.completed.append(outcome)
        if working.result.filled_size <= 0:
            self.log.info(
                "maker order closed unfilled",
                extra={"market": working.opportunity.market.market_id, "note": note},
            )
        return outcome

    async def cancel_all(self) -> int:
        count = await self.venue.cancel_all()
        if self.risk is not None:
            for key in list(self.working):
                self.risk.release(key)
        self.working.clear()
        return count

    @property
    def working_count(self) -> int:
        return len(self.working)


def _blend_price(size_a: float, price_a: float, size_b: float, price_b: float) -> float:
    total = size_a + size_b
    if total <= 0:
        return 0.0
    return (size_a * price_a + size_b * price_b) / total
