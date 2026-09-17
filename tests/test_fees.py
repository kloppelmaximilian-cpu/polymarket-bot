"""The fee model -- fee = shares * rate * p * (1-p), takers only."""

from __future__ import annotations

import pytest

from pmbot.polymarket.fees import (
    DEFAULT_CRYPTO_TAKER_RATE,
    FeeSchedule,
    breakeven_probability,
    net_edge,
)


def test_fee_formula_matches_published_schedule():
    schedule = FeeSchedule(taker_rate=0.07)
    # The documented headline: $1.75 per 100 shares at 50 cents.
    assert schedule.total(0.50, 100) == pytest.approx(1.75)
    # And the p(1-p) shape: 0.07 * 0.25 * 0.1875/0.25 at p=0.25.
    assert schedule.per_share(0.25) == pytest.approx(0.07 * 0.25 * 0.75)


def test_fee_peaks_at_the_middle_and_vanishes_at_the_ends():
    schedule = FeeSchedule()
    assert schedule.per_share(0.50) > schedule.per_share(0.25)
    assert schedule.per_share(0.50) > schedule.per_share(0.75)
    assert schedule.per_share(0.01) < 0.001
    assert schedule.per_share(0.99) < 0.001


def test_fee_symmetric_about_one_half():
    schedule = FeeSchedule()
    assert schedule.per_share(0.3) == pytest.approx(schedule.per_share(0.7))


def test_makers_pay_nothing():
    schedule = FeeSchedule(taker_rate=0.07, taker_only=True)
    assert schedule.per_share(0.5, is_maker=True) == 0.0
    assert schedule.total(0.5, 1000, is_maker=True) == 0.0


def test_disabled_schedule_charges_nothing():
    assert FeeSchedule(enabled=False).per_share(0.5) == 0.0


def test_parses_modern_fee_schedule_field():
    raw = {
        "feesEnabled": True,
        "feeType": "crypto_fees_v2",
        "feeSchedule": {"exponent": 1, "rate": 0.07, "takerOnly": True, "rebateRate": 0.2},
        "takerBaseFee": 1000,
        "makerBaseFee": 1000,
    }
    schedule = FeeSchedule.from_market_dict(raw)
    assert schedule.taker_rate == pytest.approx(0.07)
    assert schedule.maker_rate == 0.0
    assert schedule.fee_type == "crypto_fees_v2"


def test_legacy_bps_fields_ignored_when_schedule_present():
    """takerBaseFee=1000 would mean 10% -- it must not be used when a
    feeSchedule exists, which is the trap the research phase flagged."""
    raw = {
        "feeSchedule": {"rate": 0.07, "takerOnly": True},
        "takerBaseFee": 1000,
    }
    assert FeeSchedule.from_market_dict(raw).taker_rate == pytest.approx(0.07)


def test_legacy_bps_used_only_as_fallback():
    schedule = FeeSchedule.from_market_dict({"takerBaseFee": 50, "makerBaseFee": 0})
    assert schedule.taker_rate == pytest.approx(0.005)


def test_malformed_fee_fields_fall_back_to_default():
    schedule = FeeSchedule.from_market_dict({"feeSchedule": {"rate": "nonsense"}})
    assert schedule.taker_rate == pytest.approx(DEFAULT_CRYPTO_TAKER_RATE)


def test_breakeven_probability_includes_the_fee():
    schedule = FeeSchedule()
    assert breakeven_probability(0.50, schedule) == pytest.approx(0.5175)


def test_net_edge_subtracts_fee_and_slippage():
    schedule = FeeSchedule()
    edge = net_edge(0.60, 0.50, schedule, slippage=0.005)
    # 0.60 - 0.50 - 0.005 - fee(0.505)
    assert edge == pytest.approx(0.60 - 0.50 - 0.005 - schedule.per_share(0.505))
    assert edge < 0.10  # fees really do bite


def test_two_point_edge_is_not_enough_at_the_middle():
    """A 2pp raw edge at 50 cents does not survive the taker fee."""
    schedule = FeeSchedule()
    assert net_edge(0.52, 0.50, schedule) < 0.005
