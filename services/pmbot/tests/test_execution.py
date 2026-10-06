"""Execution: the paper venue, duplicate protection and the executor."""

from __future__ import annotations

import uuid

import pytest

from pmbot.core.types import (
    BookSnapshot,
    Decision,
    OrderKind,
    OrderRequest,
    OrderState,
    Outcome,
    PriceLevel,
    Side,
)
from pmbot.execution.base import OrderGuard, round_to_tick
from pmbot.execution.executor import Executor
from pmbot.execution.paper import PaperVenue
from pmbot.orderbook.book import OrderBookManager
from pmbot.polymarket.fees import FeeSchedule
from tests.conftest import make_market

START = 1_760_000_000.0


def books_with(bids, asks, token="m1-UP", now=START) -> OrderBookManager:
    manager = OrderBookManager()
    manager.apply_book_event(
        BookSnapshot(
            token_id=token,
            bids=[PriceLevel(p, s) for p, s in bids],
            asks=[PriceLevel(p, s) for p, s in asks],
            timestamp=now,
        ),
        now=now,
    )
    return manager


def request(price=0.52, size=30, kind=OrderKind.FAK, post_only=False,
            token="m1-UP", client_id=None) -> OrderRequest:
    return OrderRequest(
        market_id="m1", condition_id="0xm1", token_id=token, asset="BTC",
        outcome=Outcome.UP, side=Side.BUY, price=price, size=size, kind=kind,
        post_only=post_only, client_id=client_id or uuid.uuid4().hex,
    )


def venue(manager, clock, **kwargs) -> PaperVenue:
    defaults = dict(latency_ms=0.0, seed=7, default_fee=FeeSchedule(),
                    simulate_latency_sleep=False)
    defaults.update(kwargs)
    return PaperVenue(manager, clock=clock, **defaults)


class TestTickRounding:
    def test_buy_rounds_up_against_us(self):
        assert round_to_tick(0.5049, 0.01, side_up=True) == pytest.approx(0.51)

    def test_sell_rounds_down_against_us(self):
        assert round_to_tick(0.5051, 0.01, side_up=False) == pytest.approx(0.50)

    def test_stays_strictly_inside_the_unit_interval(self):
        assert 0 < round_to_tick(0.0, 0.01) < 1
        assert 0 < round_to_tick(1.0, 0.01) < 1


class TestOrderGuard:
    def test_identical_order_blocked(self):
        guard = OrderGuard(window_seconds=30)
        order = request(client_id="fixed")
        assert guard.check(order, now=1000.0) is None
        guard.register(order, now=1000.0)
        assert guard.check(order, now=1001.0) is not None

    def test_same_shape_different_client_id_still_blocked(self):
        """A retry with a new id is still a duplicate in substance."""
        guard = OrderGuard(window_seconds=30)
        first = request(client_id="a")
        guard.register(first, now=1000.0)
        assert guard.check(request(client_id="b"), now=1001.0) is not None

    def test_expires_after_the_window(self):
        guard = OrderGuard(window_seconds=30)
        guard.register(request(client_id="a"), now=1000.0)
        assert guard.check(request(client_id="b"), now=1040.0) is None

    def test_release_allows_a_requote(self):
        guard = OrderGuard(window_seconds=30)
        order = request(client_id="a")
        guard.register(order, now=1000.0)
        guard.release(order)
        assert guard.check(request(client_id="b"), now=1001.0) is None

    def test_different_price_is_not_a_duplicate(self):
        guard = OrderGuard()
        guard.register(request(price=0.52, client_id="a"), now=1000.0)
        assert guard.check(request(price=0.53, client_id="b"), now=1001.0) is None


class TestPaperVenue:
    async def test_taker_walks_the_book(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20), (0.53, 50)])
        market_venue = venue(manager, clock)
        result = await market_venue.submit(request(price=0.53, size=30))
        assert result.state is OrderState.FILLED
        assert result.filled_size == 30
        assert result.avg_price == pytest.approx((20 * 0.52 + 10 * 0.53) / 30)

    async def test_taker_fee_matches_the_schedule(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market_venue = venue(manager, clock)
        result = await market_venue.submit(request(price=0.52, size=100))
        assert result.fees == pytest.approx(FeeSchedule().total(0.52, 100))

    async def test_fok_rejects_when_it_cannot_fill_in_full(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        result = await venue(manager, clock).submit(
            request(price=0.52, size=100, kind=OrderKind.FOK)
        )
        assert result.state is OrderState.REJECTED
        assert "FOK" in result.error

    async def test_fak_fills_what_it_can(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        result = await venue(manager, clock).submit(
            request(price=0.52, size=100, kind=OrderKind.FAK)
        )
        assert result.filled_size == 20

    async def test_limit_price_is_respected(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 5), (0.90, 1000)])
        result = await venue(manager, clock).submit(
            request(price=0.53, size=100, kind=OrderKind.FAK)
        )
        assert result.filled_size == 5           # never pays 0.90

    async def test_post_only_rests_inside_the_spread(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock)
        result = await market_venue.submit(
            request(price=0.51, size=50, kind=OrderKind.GTC, post_only=True)
        )
        assert result.state is OrderState.OPEN
        assert len(market_venue.open_orders()) == 1

    async def test_post_only_rejected_when_it_would_cross(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        result = await venue(manager, clock).submit(
            request(price=0.53, size=50, kind=OrderKind.GTC, post_only=True)
        )
        assert result.state is OrderState.REJECTED
        assert "cross" in result.error

    async def test_maker_fills_only_from_prints_through_the_price(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock, maker_fill_ratio=1.0,
                             queue_model="optimistic")
        result = await market_venue.submit(
            request(price=0.51, size=50, kind=OrderKind.GTC, post_only=True)
        )
        clock.advance(1)
        manager.record_trade("m1-UP", 0.55, 100, Side.BUY, clock.time())
        await market_venue.poll()
        assert result.filled_size == 0           # printed above our bid
        clock.advance(1)
        manager.record_trade("m1-UP", 0.51, 20, Side.SELL, clock.time())
        await market_venue.poll()
        assert result.filled_size == pytest.approx(20)

    async def test_maker_pays_no_fee(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock, maker_fill_ratio=1.0,
                             queue_model="optimistic")
        result = await market_venue.submit(
            request(price=0.51, size=20, kind=OrderKind.GTC, post_only=True)
        )
        clock.advance(1)
        manager.record_trade("m1-UP", 0.50, 50, Side.SELL, clock.time())
        await market_venue.poll()
        assert result.filled_size > 0
        assert result.fees == 0.0

    async def test_queue_model_makes_fills_partial(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock, maker_fill_ratio=0.5,
                             queue_model="realistic")
        result = await market_venue.submit(
            request(price=0.51, size=100, kind=OrderKind.GTC, post_only=True)
        )
        clock.advance(1)
        manager.record_trade("m1-UP", 0.51, 40, Side.SELL, clock.time())
        await market_venue.poll()
        assert 0 <= result.filled_size < 40

    async def test_resting_order_expires(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock, order_timeout=10.0)
        result = await market_venue.submit(
            request(price=0.51, size=50, kind=OrderKind.GTC, post_only=True)
        )
        clock.advance(20)
        await market_venue.poll()
        assert result.state is OrderState.EXPIRED
        assert market_venue.open_orders() == []

    async def test_cancel(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock)
        result = await market_venue.submit(
            request(price=0.51, size=50, kind=OrderKind.GTC, post_only=True)
        )
        assert await market_venue.cancel(result.order_id) is True
        assert result.state is OrderState.CANCELLED
        assert await market_venue.cancel("nonexistent") is False

    async def test_duplicate_rejected(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market_venue = venue(manager, clock)
        order = request(price=0.52, size=10, client_id="same")
        await market_venue.submit(order)
        second = await market_venue.submit(order)
        assert second.state is OrderState.REJECTED
        assert "duplicate" in second.error
        assert market_venue.stats.duplicates_blocked == 1

    async def test_no_book_means_rejection_not_a_free_fill(self, clock):
        market_venue = venue(OrderBookManager(), clock)
        result = await market_venue.submit(request())
        assert result.state is OrderState.REJECTED

    async def test_invalid_price_rejected(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        result = await venue(manager, clock).submit(request(price=1.5))
        assert result.state is OrderState.REJECTED

    async def test_off_tick_price_rejected(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        result = await venue(manager, clock).submit(request(price=0.5237))
        assert result.state is OrderState.REJECTED
        assert "tick" in result.error

    async def test_cancel_all(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 20)])
        market_venue = venue(manager, clock)
        for price in (0.49, 0.48):
            await market_venue.submit(
                request(price=price, size=10, kind=OrderKind.GTC, post_only=True)
            )
        assert await market_venue.cancel_all() == 2
        assert market_venue.open_orders() == []


class TestExecutor:
    def _opportunity(self, market, model_probability=0.62, entry=0.52, shares=30.0):
        from pmbot.core.types import MarketProbability, Opportunity, Prediction, Regime

        prediction = Prediction(
            market_id=market.market_id, asset=market.asset, timestamp=START,
            probability_up=model_probability, probability_down=1 - model_probability,
            confidence=0.8, uncertainty=0.02, regime=Regime.TRENDING,
        )
        return Opportunity(
            market=market, outcome=Outcome.UP, side=Side.BUY, prediction=prediction,
            market_probability=MarketProbability(0.52, 0.48, 0.52, 0.48, 0.0),
            entry_price=entry, model_probability=model_probability,
            gross_edge=model_probability - entry, fee_cost=0.017, slippage_cost=0.0,
            net_edge=model_probability - entry - 0.017,
            expected_value_per_share=0.08, size_shares=shares,
            notional=shares * entry, expected_value=2.0, decision=Decision.TRADE,
            score=0.01, confidence=0.8, regime=Regime.TRENDING,
        )

    async def test_taker_style_crosses_immediately(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(venue(manager, clock), manager, clock, style="taker")
        outcome = await executor.execute(self._opportunity(market))
        assert outcome.style == "taker"
        assert outcome.filled_size > 0

    async def test_maker_style_rests_when_it_pays_better(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker_then_taker",
            maker_wait_seconds=20.0, min_seconds_remaining=20.0,
        )
        outcome = await executor.execute(self._opportunity(market))
        assert outcome.style == "maker"
        assert executor.working_count == 1

    async def test_maker_notional_matches_what_risk_approved(self, clock):
        """Resting at a better price must buy more shares for the same dollars,
        not the same shares for more dollars."""
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker",
            maker_wait_seconds=20.0,
        )
        opportunity = self._opportunity(market, shares=30.0, entry=0.52)
        await executor.execute(opportunity)
        working = next(iter(executor.working.values()))
        notional = working.request.size * working.request.price
        assert notional <= opportunity.notional * 1.05

    async def test_taker_used_when_there_is_no_time_to_work_an_order(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START - 285)     # 15s left
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker_then_taker",
            maker_wait_seconds=20.0, min_seconds_remaining=10.0,
        )
        outcome = await executor.execute(self._opportunity(market))
        assert outcome.style == "taker"

    async def test_resting_order_cancelled_when_the_edge_disappears(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker",
            maker_wait_seconds=60.0, min_seconds_remaining=10.0,
        )
        await executor.execute(self._opportunity(market))
        assert executor.working_count == 1
        clock.advance(5)
        finished = await executor.step(revalidate=lambda o: -0.01, now=clock.time())
        assert executor.working_count == 0
        assert finished and "edge disappeared" in finished[0].note

    async def test_resting_order_cancelled_as_the_window_closes(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker",
            maker_wait_seconds=600.0, min_seconds_remaining=30.0,
        )
        await executor.execute(self._opportunity(market))
        clock.advance(280)
        finished = await executor.step(revalidate=lambda o: 0.05, now=clock.time())
        assert executor.working_count == 0
        assert "window closing" in finished[0].note

    async def test_escalation_to_taker_after_the_deadline(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker",
            maker_wait_seconds=10.0, min_seconds_remaining=20.0,
        )
        await executor.execute(self._opportunity(market))
        clock.advance(11)
        finished = await executor.step(revalidate=lambda o: 0.05, now=clock.time())
        assert finished
        assert finished[0].style == "maker_then_taker"
        assert finished[0].filled_size > 0

    async def test_zero_size_is_abandoned(self, clock):
        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        executor = Executor(venue(manager, clock), manager, clock)
        outcome = await executor.execute(self._opportunity(market, shares=0.0))
        assert outcome.filled_size == 0
        assert "no size" in outcome.note

    async def test_reservations_are_released_on_every_exit(self, clock):
        from pmbot.risk.engine import RiskEngine, RiskLimits

        manager = books_with([(0.50, 100)], [(0.52, 100)])
        market = make_market(window_start=START)
        risk = RiskEngine(RiskLimits(), 1000.0, clock=clock)
        executor = Executor(
            venue(manager, clock), manager, clock, style="maker",
            maker_wait_seconds=60.0, min_seconds_remaining=10.0, risk=risk,
        )
        await executor.execute(self._opportunity(market))
        assert len(risk.reservations) == 1
        clock.advance(5)
        await executor.step(revalidate=lambda o: -1.0, now=clock.time())
        assert len(risk.reservations) == 0
