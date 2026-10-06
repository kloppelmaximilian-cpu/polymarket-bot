"""The digital-option pricer: the mathematical core."""

from __future__ import annotations

import math

import pytest

from pmbot.probability.analytic import (
    FairValueInputs,
    basis_sigma_from_bps,
    fair_value,
    implied_log_moneyness,
    implied_strike,
    implied_volatility,
    norm_cdf,
    norm_pdf,
    norm_ppf,
    probability_up,
)

SEC_PER_YEAR = 365 * 24 * 3600


def sigma_for(annual: float) -> float:
    return annual / math.sqrt(SEC_PER_YEAR)


class TestNormalFunctions:
    def test_cdf_known_values(self):
        assert norm_cdf(0.0) == pytest.approx(0.5)
        assert norm_cdf(1.0) == pytest.approx(0.8413447, abs=1e-6)
        assert norm_cdf(-1.96) == pytest.approx(0.0249979, abs=1e-6)

    def test_cdf_monotone_and_bounded(self):
        previous = 0.0
        for z in [x / 10 for x in range(-50, 51)]:
            value = norm_cdf(z)
            assert 0.0 <= value <= 1.0
            assert value >= previous
            previous = value

    def test_ppf_inverts_cdf(self):
        for p in (0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999):
            assert norm_cdf(norm_ppf(p)) == pytest.approx(p, abs=1e-8)

    def test_pdf_integrates_to_one(self):
        step = 0.001
        total = sum(norm_pdf(-8 + i * step) * step for i in range(int(16 / step)))
        assert total == pytest.approx(1.0, abs=1e-4)


class TestFairValue:
    def test_at_the_money_is_a_coin_flip(self):
        result = fair_value(FairValueInputs(
            spot=100.0, strike=100.0, seconds_remaining=150,
            sigma_per_sec=sigma_for(0.5),
        ))
        assert result.probability_up == pytest.approx(0.5)

    def test_above_strike_favours_up(self):
        result = fair_value(FairValueInputs(
            spot=100.1, strike=100.0, seconds_remaining=150,
            sigma_per_sec=sigma_for(0.5),
        ))
        assert result.probability_up > 0.5

    def test_probability_rises_as_time_runs_out_when_in_the_money(self):
        probabilities = [
            probability_up(100.05, 100.0, tau, sigma_for(0.5))
            for tau in (280, 200, 120, 60, 20)
        ]
        assert probabilities == sorted(probabilities)

    def test_probability_symmetric_in_moneyness(self):
        sigma = sigma_for(0.5)
        up = probability_up(100.0 * 1.0005, 100.0, 120, sigma)
        down = probability_up(100.0 / 1.0005, 100.0, 120, sigma)
        assert up + down == pytest.approx(1.0, abs=1e-9)

    def test_higher_volatility_pulls_toward_a_half(self):
        low = probability_up(100.05, 100.0, 120, sigma_for(0.3))
        high = probability_up(100.05, 100.0, 120, sigma_for(1.5))
        assert abs(low - 0.5) > abs(high - 0.5)

    def test_ties_resolve_up_at_expiry(self):
        result = fair_value(FairValueInputs(
            spot=100.0, strike=100.0, seconds_remaining=0.0,
            sigma_per_sec=sigma_for(0.5), sigma_basis=0.0,
        ))
        assert result.probability_up == 1.0

    def test_expired_below_strike_is_certain_down(self):
        result = fair_value(FairValueInputs(
            spot=99.9, strike=100.0, seconds_remaining=0.0,
            sigma_per_sec=sigma_for(0.5), sigma_basis=0.0,
        ))
        assert result.probability_up == 0.0

    def test_basis_uncertainty_prevents_overconfidence_near_expiry(self):
        """The key protection: with seconds left and a proxy price feed, the
        model must not claim near-certainty."""
        # 5bps above the strike with 2 seconds left: the diffusive move left is
        # only ~1.3bps, so without a basis term the model is nearly certain.
        without = probability_up(100.05, 100.0, 2.0, sigma_for(0.5), sigma_basis=0.0)
        with_basis = probability_up(
            100.05, 100.0, 2.0, sigma_for(0.5),
            sigma_basis=basis_sigma_from_bps(2.0),
        )
        assert without > 0.99
        assert with_basis < without
        # Two independent oracle snapshots at 2bps each swamp a 5bps edge.
        assert with_basis < 0.96

    def test_basis_share_grows_as_time_shrinks(self):
        basis = basis_sigma_from_bps(2.0)
        shares = [
            fair_value(FairValueInputs(
                spot=100.0, strike=100.0, seconds_remaining=tau,
                sigma_per_sec=sigma_for(0.5), sigma_basis=basis,
            )).basis_share
            for tau in (300, 150, 60, 10)
        ]
        assert shares == sorted(shares)

    def test_drift_is_capped(self):
        sigma = sigma_for(0.5)
        huge_drift = fair_value(FairValueInputs(
            spot=100.0, strike=100.0, seconds_remaining=150,
            sigma_per_sec=sigma, drift_per_sec=1.0, max_drift_sd_fraction=0.35,
        ))
        # 0.35 sigma of tilt is about 0.637 in probability, not 1.0.
        assert huge_drift.probability_up < 0.65
        assert huge_drift.drift_applied == pytest.approx(
            0.35 * huge_drift.sigma_total
        )

    def test_rejects_non_positive_prices(self):
        with pytest.raises(ValueError):
            fair_value(FairValueInputs(0.0, 100.0, 60, sigma_for(0.5)))
        with pytest.raises(ValueError):
            fair_value(FairValueInputs(100.0, -1.0, 60, sigma_for(0.5)))

    def test_sensitivity_is_largest_at_the_money(self):
        sigma = sigma_for(0.5)
        atm = fair_value(FairValueInputs(100.0, 100.0, 120, sigma)).sensitivity
        otm = fair_value(FairValueInputs(100.5, 100.0, 120, sigma)).sensitivity
        assert atm > otm


class TestInversion:
    def test_implied_log_moneyness_round_trip(self):
        sigma = sigma_for(0.5)
        for probability in (0.2, 0.4, 0.5, 0.65, 0.85):
            x = implied_log_moneyness(probability, 150, sigma)
            back = norm_cdf(x / (sigma * math.sqrt(150)))
            assert back == pytest.approx(probability, abs=1e-8)

    def test_implied_strike_round_trip(self):
        sigma = sigma_for(0.5)
        strike = implied_strike(0.62, 100.0, 150, sigma)
        assert probability_up(100.0, strike, 150, sigma) == pytest.approx(0.62, abs=1e-8)

    def test_implied_volatility_round_trip(self):
        sigma = sigma_for(0.5)
        probability = probability_up(100.05, 100.0, 150, sigma)
        recovered = implied_volatility(probability, 100.05, 100.0, 150)
        assert recovered == pytest.approx(sigma, rel=1e-6)

    def test_implied_volatility_none_when_unattainable(self):
        # Spot above strike but the market says DOWN: no positive vol explains it.
        assert implied_volatility(0.30, 100.5, 100.0, 150) is None

    def test_implied_volatility_none_at_expiry(self):
        assert implied_volatility(0.6, 100.5, 100.0, 0.0) is None

    def test_basis_sigma_scales_with_snapshots(self):
        single = basis_sigma_from_bps(2.0, n_snapshots=1)
        double = basis_sigma_from_bps(2.0, n_snapshots=2)
        assert double == pytest.approx(single * math.sqrt(2))
