"""Risk engine: limits, kill switches, accounting, sizing."""

from __future__ import annotations

import pytest

from pmbot.core.clock import SimulatedClock
from pmbot.core.types import Fill, Outcome, Side
from pmbot.polymarket.fees import FeeSchedule
from pmbot.risk.engine import RiskEngine, RiskLimits
from pmbot.risk.sizing import (
    SizingInputs,
    kelly_fraction,
    max_shares_for_slippage,
    size_position,
)
from tests.conftest import make_book, make_market

START = 1_760_000_000.0


def engine(**limit_overrides) -> RiskEngine:
    limits = RiskLimits(**limit_overrides) if limit_overrides else RiskLimits()
    return RiskEngine(limits, 1000.0, clock=SimulatedClock(START))


def fill(token_id: str, price: float, size: float, fee: float = 0.0) -> Fill:
    return Fill("o", "c", token_id, Side.BUY, price, size, fee, START)


class TestAccounting:
    def test_starts_flat(self):
        risk = engine()
        state = risk.state()
        assert state.bankroll == 1000.0
        assert state.equity == 1000.0
        assert state.open_exposure == 0.0
        assert state.open_positions == 0

    def test_opening_a_position_moves_exposure_not_bankroll(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 40, 0.35)])
        assert risk.open_exposure == pytest.approx(20.0)
        assert risk.bankroll == pytest.approx(1000.0)
        assert risk.available == pytest.approx(980.0)

    def test_winning_settlement_pays_one_per_share(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 40, 0.35)])
        position = risk.settle_position("m1:UP", Outcome.UP)
        # 40 shares pay $40; cost was $20 plus $0.35 of fees.
        assert position.realized_pnl == pytest.approx(40 - 20 - 0.35)
        assert risk.bankroll == pytest.approx(1000 + 19.65)
        assert risk.consecutive_losses == 0

    def test_losing_settlement_costs_the_stake_plus_fees(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 40, 0.35)])
        position = risk.settle_position("m1:UP", Outcome.DOWN)
        assert position.realized_pnl == pytest.approx(-20.35)
        assert risk.consecutive_losses == 1

    def test_pnl_identity_holds_over_many_trades(self):
        risk = engine(max_positions_per_market=1, max_simultaneous_positions=50)
        total = 0.0
        for i in range(20):
            market = make_market(f"m{i}", window_start=START + i * 300)
            risk.open_position(market, Outcome.UP, [fill(f"m{i}-UP", 0.45, 30, 0.2)])
            won = i % 3 == 0
            position = risk.settle_position(
                f"m{i}:UP", Outcome.UP if won else Outcome.DOWN
            )
            expected = (30 if won else 0) - 30 * 0.45 - 0.2
            assert position.realized_pnl == pytest.approx(expected)
            total += expected
        assert risk.realized_pnl == pytest.approx(total)
        assert risk.bankroll == pytest.approx(1000 + total)

    def test_early_close_at_a_price(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 40, 0.35)])
        position = risk.close_position_at_price("m1:UP", 0.60, fee=0.1)
        assert position.realized_pnl == pytest.approx(40 * 0.60 - 0.1 - 20 - 0.35)

    def test_unrealized_uses_marks_and_assumes_flat_without_them(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 40, 0.0)])
        assert risk.unrealized_pnl({}) == pytest.approx(0.0)
        assert risk.unrealized_pnl({"m1-UP": 0.60}) == pytest.approx(4.0)

    def test_adding_to_a_position_averages_the_price(self):
        risk = engine()
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.50, 20, 0.1)])
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.60, 20, 0.1)])
        position = risk.positions["m1:UP"]
        assert position.size == pytest.approx(40)
        assert position.avg_price == pytest.approx(0.55)
        assert position.fees_paid == pytest.approx(0.2)


class TestLimits:
    def test_per_trade_notional_cap(self):
        risk = engine(max_stake_per_trade=25.0)
        check = risk.check_trade(make_market(), Outcome.UP, 30.0)
        assert not check
        assert check.limit == "max_stake_per_trade"

    def test_bankroll_fraction_cap(self):
        risk = engine(max_stake_per_trade=1000.0, max_stake_fraction=0.02)
        check = risk.check_trade(make_market(), Outcome.UP, 50.0)
        assert not check
        assert check.limit == "max_stake_fraction"

    def test_one_position_per_market(self):
        risk = engine(max_positions_per_market=1)
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.5, 20)])
        assert not risk.check_trade(market, Outcome.DOWN, 10.0)

    def test_positions_per_asset(self):
        risk = engine(max_positions_per_asset=1)
        risk.open_position(
            make_market("m1", "BTC"), Outcome.UP, [fill("m1-UP", 0.5, 20)]
        )
        check = risk.check_trade(make_market("m2", "BTC"), Outcome.UP, 10.0)
        assert not check
        assert check.limit == "max_positions_per_asset"
        assert risk.check_trade(make_market("m3", "ETH"), Outcome.UP, 10.0)

    def test_portfolio_exposure_cap(self):
        risk = engine(max_portfolio_exposure=30.0, max_positions_per_asset=10,
                      max_simultaneous_positions=10)
        risk.open_position(
            make_market("m1", "BTC"), Outcome.UP, [fill("m1-UP", 0.5, 40)]
        )
        check = risk.check_trade(make_market("m2", "ETH"), Outcome.UP, 20.0)
        assert not check
        assert check.limit == "max_portfolio_exposure"

    def test_correlated_exposure_cap_treats_crypto_as_one_bucket(self):
        risk = engine(max_correlated_exposure=30.0, max_asset_exposure=1000.0,
                      max_portfolio_exposure=1000.0, max_positions_per_asset=10,
                      max_simultaneous_positions=10)
        risk.open_position(
            make_market("m1", "BTC"), Outcome.UP, [fill("m1-UP", 0.5, 40)]
        )
        check = risk.check_trade(make_market("m2", "ETH"), Outcome.UP, 20.0)
        assert check.limit == "max_correlated_exposure"

    def test_simultaneous_position_cap(self):
        risk = engine(max_simultaneous_positions=2, max_positions_per_asset=5)
        for i in range(2):
            risk.open_position(
                make_market(f"m{i}", "BTC"), Outcome.UP, [fill(f"m{i}-UP", 0.5, 10)]
            )
        assert not risk.check_trade(make_market("m9", "BTC"), Outcome.UP, 5.0)


class TestReservations:
    def test_resting_order_blocks_a_second_order_on_the_same_market(self):
        """The bug this exists to prevent: while a maker order rests there is no
        position, so without reservations the next cycle would order again."""
        risk = engine(max_positions_per_market=1)
        market = make_market()
        assert risk.check_trade(market, Outcome.UP, 20.0)
        risk.reserve("order-1", market.market_id, market.asset, Outcome.UP, 20.0)
        check = risk.check_trade(market, Outcome.UP, 20.0)
        assert not check
        assert check.limit == "max_positions_per_market"

    def test_reservations_count_toward_exposure(self):
        risk = engine()
        risk.reserve("o1", "m1", "BTC", Outcome.UP, 20.0)
        assert risk.open_exposure == pytest.approx(20.0)
        assert risk.available == pytest.approx(980.0)
        assert risk.position_exposure == 0.0

    def test_release_frees_the_slot(self):
        risk = engine(max_positions_per_market=1)
        market = make_market()
        risk.reserve("o1", market.market_id, market.asset, Outcome.UP, 20.0)
        risk.release("o1")
        assert risk.check_trade(market, Outcome.UP, 20.0)

    def test_stale_reservations_are_reaped(self):
        risk = engine()
        risk.reserve("o1", "m1", "BTC", Outcome.UP, 20.0)
        risk.clock.advance(500)
        assert risk.release_stale_reservations(max_age=120.0) == 1
        assert risk.open_exposure == 0.0

    def test_has_commitment(self):
        risk = engine()
        risk.reserve("o1", "m1", "BTC", Outcome.UP, 20.0)
        assert risk.has_commitment("m1") is True
        assert risk.has_commitment("m1", Outcome.DOWN) is False
        assert risk.has_commitment("m2") is False


class TestKillSwitches:
    def test_daily_loss_limit_latches_a_pause(self):
        risk = engine(max_daily_loss=50.0, max_consecutive_losses=99)
        for i in range(3):
            market = make_market(f"m{i}")
            risk.open_position(market, Outcome.UP, [fill(f"m{i}-UP", 0.5, 40, 0.35)])
            risk.settle_position(f"m{i}:UP", Outcome.DOWN)
        assert risk.is_paused()
        assert "daily loss" in risk.state().pause_reason

    def test_consecutive_loss_limit(self):
        risk = engine(max_consecutive_losses=2, max_daily_loss=1e9,
                      max_session_loss=1e9, max_drawdown=1.0)
        for i in range(2):
            market = make_market(f"m{i}")
            risk.open_position(market, Outcome.UP, [fill(f"m{i}-UP", 0.5, 10, 0.0)])
            risk.settle_position(f"m{i}:UP", Outcome.DOWN)
        assert risk.is_paused()
        assert "consecutive" in risk.state().pause_reason

    def test_a_win_resets_the_streak(self):
        risk = engine(max_consecutive_losses=3)
        for i, won in enumerate([False, False, True, False]):
            market = make_market(f"m{i}")
            risk.open_position(market, Outcome.UP, [fill(f"m{i}-UP", 0.5, 10)])
            risk.settle_position(f"m{i}:UP", Outcome.UP if won else Outcome.DOWN)
        assert risk.consecutive_losses == 1
        assert not risk.is_paused()

    def test_drawdown_limit(self):
        risk = engine(max_drawdown=0.05, max_daily_loss=1e9, max_session_loss=1e9,
                      max_consecutive_losses=99)
        market = make_market()
        risk.open_position(market, Outcome.UP, [fill("m1-UP", 0.9, 100, 0.0)])
        risk.settle_position("m1:UP", Outcome.DOWN)
        assert risk.is_paused()
        assert "drawdown" in risk.state().pause_reason

    def test_pause_expires_after_the_cooldown(self):
        risk = engine(pause_seconds=300.0)
        risk.pause("test")
        assert risk.is_paused()
        risk.clock.advance(301)
        assert not risk.is_paused()

    def test_manual_resume(self):
        risk = engine()
        risk.pause("test")
        risk.resume("operator")
        assert not risk.is_paused()

    def test_paused_engine_blocks_every_trade(self):
        risk = engine()
        risk.pause("test")
        check = risk.check_trade(make_market(), Outcome.UP, 1.0)
        assert not check
        assert check.limit == "pause"

    def test_events_recorded(self):
        risk = engine()
        risk.pause("test reason")
        assert any(e.kind == "trading_pause" for e in risk.events)


class TestSizing:
    def test_kelly_formula(self):
        # f* = (q - p)/(1 - p)
        assert kelly_fraction(0.60, 0.50) == pytest.approx(0.20)
        assert kelly_fraction(0.50, 0.50) == pytest.approx(0.0)
        assert kelly_fraction(0.40, 0.50) < 0

    def test_no_edge_no_size(self):
        result = size_position(SizingInputs(
            model_probability=0.50, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.0, bankroll=1000.0, available=1000.0,
        ))
        assert result.shares == 0
        assert "no edge" in result.binding_constraint

    def test_fee_alone_kills_a_two_point_edge(self):
        """At 50 cents the taker fee is 1.75 points, so 2 points of raw edge is
        not a tradable edge."""
        schedule = FeeSchedule()
        result = size_position(SizingInputs(
            model_probability=0.52, entry_price=0.50,
            fee_per_share=schedule.per_share(0.50), slippage=0.0,
            uncertainty=0.01, bankroll=1000.0, available=1000.0,
        ))
        assert result.shares == 0

    def test_uncertainty_shrinks_the_edge(self):
        base = dict(
            model_probability=0.60, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, bankroll=1000.0, available=1000.0,
            max_stake_fraction=1.0, max_stake_absolute=1e9,
        )
        confident = size_position(SizingInputs(uncertainty=0.01, **base))
        unsure = size_position(SizingInputs(uncertainty=0.06, **base))
        assert confident.shares > unsure.shares

    def test_large_uncertainty_blocks_the_trade(self):
        result = size_position(SizingInputs(
            model_probability=0.60, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.15, bankroll=1000.0, available=1000.0,
        ))
        assert result.shares == 0

    def test_caps_bind_in_order(self):
        result = size_position(SizingInputs(
            model_probability=0.90, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=1000.0, available=1000.0,
            max_stake_fraction=0.02, max_stake_absolute=25.0,
        ))
        assert result.notional <= 20.0 + 1e-9
        assert result.binding_constraint == "max_stake_fraction"

    def test_absolute_cap_can_bind(self):
        result = size_position(SizingInputs(
            model_probability=0.90, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=100_000.0, available=100_000.0,
            max_stake_fraction=0.02, max_stake_absolute=25.0,
        ))
        assert result.notional <= 25.0 + 1e-9
        assert result.binding_constraint == "max_stake_per_trade"

    def test_available_capital_can_bind(self):
        result = size_position(SizingInputs(
            model_probability=0.90, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=1000.0, available=6.0,
            max_stake_fraction=1.0, max_stake_absolute=1e9,
        ))
        assert result.binding_constraint == "available_capital"
        assert result.notional <= 6.0 + 1e-9

    def test_book_depth_can_bind(self):
        result = size_position(SizingInputs(
            model_probability=0.90, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=1000.0, available=1000.0,
            max_stake_fraction=1.0, max_stake_absolute=1e9,
            max_shares_from_book=12.0,
        ))
        assert result.shares == pytest.approx(12.0)
        assert result.binding_constraint == "book_depth"

    def test_venue_minimum_size_respected(self):
        result = size_position(SizingInputs(
            model_probability=0.60, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=1000.0, available=1000.0,
            max_stake_fraction=0.002, max_stake_absolute=1e9, min_shares=5.0,
        ))
        assert result.shares == 0 or result.shares >= 5.0

    def test_size_never_exceeds_the_cap_across_a_sweep(self):
        for probability in [0.55, 0.65, 0.75, 0.9, 0.99]:
            for price in [0.1, 0.3, 0.5, 0.7, 0.9]:
                result = size_position(SizingInputs(
                    model_probability=probability, entry_price=price,
                    fee_per_share=FeeSchedule().per_share(price), slippage=0.0,
                    uncertainty=0.02, bankroll=1000.0, available=1000.0,
                    max_stake_fraction=0.02, max_stake_absolute=25.0,
                ))
                assert result.notional <= 20.0 + 1e-6, (probability, price)

    def test_no_martingale_size_is_independent_of_history(self):
        """Size depends on edge and bankroll only -- never on recent results."""
        inputs = SizingInputs(
            model_probability=0.60, entry_price=0.50, fee_per_share=0.0175,
            slippage=0.0, uncertainty=0.01, bankroll=1000.0, available=1000.0,
        )
        first = size_position(inputs)
        second = size_position(inputs)
        assert first.shares == second.shares


class TestSlippageBoundedSizing:
    def test_bisection_finds_the_depth_limit(self):
        book = make_book("t", bid=0.49, ask=0.50, ask_size=20, depth=3)
        # Levels: 20@0.50, 40@0.51, 60@0.52
        within_one_cent = max_shares_for_slippage(
            lambda shares: book.walk(Side.BUY, shares), 0.01, 0.50
        )
        assert 20 <= within_one_cent <= 120

    def test_zero_budget_means_zero_size(self):
        book = make_book("t")
        assert max_shares_for_slippage(
            lambda shares: book.walk(Side.BUY, shares), 0.0, 0.51
        ) == 0.0

    def test_deep_book_allows_the_full_request(self):
        book = make_book("t", bid=0.49, ask=0.50, ask_size=10_000, depth=1)
        result = max_shares_for_slippage(
            lambda shares: book.walk(Side.BUY, shares), 0.01, 0.50,
            upper_bound=500.0,
        )
        assert result == pytest.approx(500.0, rel=0.01)
