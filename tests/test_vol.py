"""Volatility estimation, including the microstructure-noise correction."""

from __future__ import annotations

import math

import numpy as np
import pytest

from pmbot.probability.vol import MIN_VOL_PER_SEC, VolatilityEstimator

SEC_PER_YEAR = 365 * 24 * 3600


def simulate(annual_vol: float, noise_bps: float, n: int = 900, seed: int = 0):
    rng = np.random.default_rng(seed)
    sigma = annual_vol / math.sqrt(SEC_PER_YEAR)
    efficient = np.cumsum(rng.normal(0.0, sigma, n))
    observed = 100_000.0 * np.exp(efficient + rng.normal(0.0, noise_bps * 1e-4, n))
    return sigma, observed


def feed(prices, start: float = 1_760_000_000.0) -> VolatilityEstimator:
    estimator = VolatilityEstimator(halflife_seconds=45.0, lookback=900)
    for i, price in enumerate(prices):
        estimator.update(start + i, price)
    return estimator


class TestBasics:
    def test_empty_estimator_returns_floor(self):
        estimate = VolatilityEstimator().estimate()
        assert estimate.blended == MIN_VOL_PER_SEC
        assert estimate.is_reliable is False

    def test_rejects_invalid_prices(self):
        estimator = VolatilityEstimator()
        estimator.update(1000.0, 0.0)
        estimator.update(1001.0, -5.0)
        estimator.update(1002.0, float("nan"))
        assert estimator.n_samples == 0

    def test_constant_price_gives_near_zero_vol(self):
        estimator = feed([100.0] * 300)
        assert estimator.estimate().blended < 1e-6

    def test_large_gap_resets_rather_than_faking_a_huge_return(self):
        estimator = VolatilityEstimator(max_gap_seconds=10.0)
        for i in range(60):
            estimator.update(1000.0 + i, 100.0 + i * 0.001)
        before = estimator.n_samples
        estimator.update(2000.0, 200.0)      # a 100% "return" after a gap
        assert estimator.n_samples < before + 5
        assert estimator.estimate().blended < 1e-2


class TestNoiseCorrection:
    def test_noise_free_estimate_is_accurate(self):
        sigma, prices = simulate(0.5, noise_bps=0.0, seed=1)
        estimate = feed(prices).estimate()
        assert estimate.blended == pytest.approx(sigma, rel=0.2)

    def test_raw_estimate_is_badly_inflated_by_noise(self):
        sigma, prices = simulate(0.5, noise_bps=1.5, seed=1)
        estimate = feed(prices).estimate()
        # This is the failure mode the correction exists for.
        assert estimate.raw_realized > sigma * 2.0

    def test_corrected_estimate_survives_noise(self):
        sigma, prices = simulate(0.5, noise_bps=1.5, seed=1)
        estimate = feed(prices).estimate()
        assert estimate.blended == pytest.approx(sigma, rel=0.30)

    @pytest.mark.parametrize("noise", [0.0, 0.5, 1.0, 2.0, 3.0])
    def test_unbiased_across_noise_levels(self, noise):
        ratios = []
        for seed in range(12):
            sigma, prices = simulate(0.5, noise_bps=noise, seed=seed)
            ratios.append(feed(prices).estimate().blended / sigma)
        mean_ratio = float(np.mean(ratios))
        assert 0.85 < mean_ratio < 1.15, f"mean ratio {mean_ratio:.3f} at {noise}bps"

    def test_noise_level_is_recovered(self):
        _, prices = simulate(0.5, noise_bps=1.5, seed=3)
        estimate = feed(prices).estimate()
        assert estimate.noise_bps == pytest.approx(1.5, rel=0.35)

    def test_noise_share_reported(self):
        _, quiet = simulate(0.5, noise_bps=0.0, seed=4)
        _, noisy = simulate(0.5, noise_bps=3.0, seed=4)
        assert feed(quiet).estimate().noise_share < 0.15
        assert feed(noisy).estimate().noise_share > 0.7

    @pytest.mark.parametrize("annual", [0.25, 0.5, 1.0, 2.0])
    def test_scales_with_true_volatility(self, annual):
        ratios = []
        for seed in range(8):
            sigma, prices = simulate(annual, noise_bps=0.7, seed=seed)
            ratios.append(feed(prices).estimate().blended / sigma)
        assert 0.8 < float(np.mean(ratios)) < 1.2


class TestJumpDetection:
    def test_jump_inflates_the_realized_to_bipower_ratio(self):
        sigma, prices = simulate(0.5, noise_bps=0.3, seed=9)
        prices = prices.copy()
        prices[500:] *= 1.004                     # a clean 40bp jump
        estimate = feed(prices).estimate()
        assert estimate.jump_ratio > 1.05

    def test_no_jump_means_ratio_near_one(self):
        _, prices = simulate(0.5, noise_bps=0.3, seed=9)
        assert feed(prices).estimate().jump_ratio == pytest.approx(1.0, abs=0.35)


class TestWindowScaling:
    def test_per_window_is_sqrt_time_scaled(self):
        _, prices = simulate(0.5, noise_bps=0.5, seed=2)
        estimate = feed(prices).estimate()
        assert estimate.per_window == pytest.approx(
            estimate.blended * math.sqrt(300.0)
        )

    def test_reliability_requires_samples(self):
        _, prices = simulate(0.5, noise_bps=0.5, seed=2)
        assert feed(prices[:10]).estimate().is_reliable is False
        assert feed(prices).estimate().is_reliable is True
