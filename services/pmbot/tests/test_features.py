"""Feature engine: correctness, causality, and graceful degradation."""

from __future__ import annotations

import math

import pytest

from pmbot.exchanges.base import make_tick
from pmbot.exchanges.composite import CompositePriceEngine
from pmbot.features.engine import FEATURE_NAMES, FeatureEngine
from pmbot.features.indicators import (
    adx_proxy,
    bollinger_position,
    efficiency_ratio,
    ema,
    lagged_correlation,
    linear_slope,
    macd,
    rate_of_change,
    resample_last,
    rsi,
    sma,
    stochastic,
    vwap,
    zscore,
)
from pmbot.orderbook.book import OrderBookManager
from pmbot.probability.analytic import basis_sigma_from_bps
from tests.conftest import make_book, make_market

WINDOW_START = 1_760_000_400.0     # a 300-second grid boundary


def build(assets=("BTC",), sigma_basis=0.0):
    composite = CompositePriceEngine(
        list(assets), stale_seconds=3.0, min_sources=2, window_seconds=300
    )
    books = OrderBookManager(stale_seconds=5.0)
    engine = FeatureEngine(composite, books, sigma_basis=sigma_basis)
    return composite, books, engine


def prime_prices(composite, asset="BTC", start=None, n=400, drift=0.0, base=100_000.0,
                 exchanges=("binance", "coinbase", "kraken")):
    """Feed a price path ending at ``WINDOW_START + 150``."""
    start = (WINDOW_START - 250) if start is None else start
    for i in range(n):
        ts = start + i
        price = base * (1.0 + drift * i)
        for exchange in exchanges:
            tick = make_tick(exchange, asset, "X", price, size=0.1)
            tick.received_at = ts
            tick.timestamp = ts
            composite.on_tick(tick)
        composite.compute(asset, ts)


class TestIndicators:
    def test_sma_and_ema(self):
        values = list(range(1, 21))
        assert sma(values, 5) == pytest.approx(18.0)
        assert ema(values, 5) is not None
        assert sma(values, 100) is None

    def test_rsi_bounds(self):
        rising = list(range(1, 40))
        falling = list(range(40, 1, -1))
        assert rsi(rising) == pytest.approx(100.0)
        assert rsi(falling) == pytest.approx(0.0, abs=1e-6)
        assert rsi([1, 2]) is None

    def test_macd_returns_three_values(self):
        values = [100 + math.sin(i / 5) for i in range(100)]
        line, signal, histogram = macd(values)
        assert histogram == pytest.approx(line - signal)

    def test_bollinger_position_sign(self):
        values = [100.0] * 19 + [110.0]
        assert bollinger_position(values, 20) > 0
        values = [100.0] * 19 + [90.0]
        assert bollinger_position(values, 20) < 0

    def test_bollinger_flat_series_is_zero(self):
        assert bollinger_position([100.0] * 30, 20) == 0.0

    def test_stochastic_extremes(self):
        assert stochastic(list(range(1, 30))) == pytest.approx(100.0)
        assert stochastic(list(range(30, 1, -1))) == pytest.approx(0.0)

    def test_efficiency_ratio_distinguishes_trend_from_chop(self):
        trend = list(range(50))
        chop = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1] * 5
        assert efficiency_ratio(trend) == pytest.approx(1.0)
        assert efficiency_ratio(chop) < 0.1

    def test_adx_proxy_range(self):
        assert 0 <= adx_proxy(list(range(50)), 30) <= 100

    def test_linear_slope(self):
        assert linear_slope(list(range(10)), [2 * x + 1 for x in range(10)]) == pytest.approx(2.0)

    def test_roc(self):
        assert rate_of_change([100, 101, 102, 103, 104, 105, 110], 6) == pytest.approx(0.10)

    def test_vwap_weights_by_size(self):
        assert vwap([1.0, 2.0], [1.0, 3.0]) == pytest.approx(1.75)
        assert vwap([1.0, 2.0], [0.0, 0.0]) == pytest.approx(1.5)

    def test_zscore(self):
        assert zscore([1, 1, 1]) == 0.0
        assert zscore([1, 2, 3, 10]) > 1

    def test_lagged_correlation_finds_the_leader(self):
        import numpy as np

        rng = np.random.default_rng(0)
        leader = np.cumsum(rng.normal(size=300))
        follower = np.roll(leader, 3) + rng.normal(scale=0.01, size=300)
        lag, correlation = lagged_correlation(leader, follower, max_lag=6)
        assert lag == 3
        assert correlation > 0.9

    def test_lagged_correlation_handles_short_series(self):
        assert lagged_correlation([1, 2], [1, 2]) == (0, 0.0)

    def test_resample_last_is_causal(self):
        """A grid point must only ever see observations at or before it."""
        grid, values = resample_last([(0, 1.0), (1.5, 2.0), (4.0, 3.0)], 0, 5, 1.0)
        assert list(values) == [1.0, 1.0, 2.0, 2.0, 3.0, 3.0]

    def test_all_indicators_return_none_on_empty_input(self):
        for fn in (sma, ema):
            assert fn([], 5) is None
        assert rsi([]) is None
        assert macd([]) is None
        assert efficiency_ratio([]) is None


class TestFeatureEngine:
    def test_produces_a_rich_vector_with_good_data(self):
        composite, books, engine = build()
        prime_prices(composite, drift=1e-7)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(make_book("m1-UP", 0.50, 0.51, timestamp=now), now=now)
        books.apply_book_event(make_book("m1-DOWN", 0.49, 0.50, timestamp=now), now=now)

        result = engine.compute(market, now)
        assert result is not None
        assert result.features["data_quality"] > 0.5
        assert "analytic_up" in result.features
        assert "dist_sigma" in result.features
        assert "pm_spread" in result.features
        assert result.context.strike > 0
        # A good chunk of the declared feature set should be present.
        present = sum(1 for name in FEATURE_NAMES if name in result.features)
        assert present > len(FEATURE_NAMES) * 0.6

    def test_missing_features_are_absent_not_zero(self):
        """A model must be able to tell 'unknown' from 'observed zero'."""
        composite, books, engine = build()
        market = make_market(window_start=WINDOW_START)
        result = engine.compute(market, WINDOW_START + 150)
        assert "pm_mid" not in result.features
        assert "ret_30s_bps" not in result.features
        assert result.context.data_quality < 0.5
        assert result.context.issues

    def test_no_composite_price_is_reported(self):
        composite, books, engine = build()
        market = make_market(window_start=WINDOW_START)
        result = engine.compute(market, WINDOW_START + 10)
        assert any("composite" in issue for issue in result.context.issues)

    def test_unknown_strike_is_flagged(self):
        composite, books, engine = build()
        # Prices only from *after* the boundary, so the strike is unknowable.
        prime_prices(composite, start=WINDOW_START + 60, n=60)
        market = make_market(window_start=WINDOW_START)
        result = engine.compute(market, WINDOW_START + 150)
        assert any("strike" in issue for issue in result.context.issues)

    def test_stale_book_is_flagged(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(
            make_book("m1-UP", 0.50, 0.51, timestamp=now - 60), now=now - 60
        )
        result = engine.compute(market, now)
        assert any("stale" in issue for issue in result.context.issues)
        assert result.features["data_quality"] < 1.0

    def test_crossed_book_gives_no_market_probability(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(
            make_book("m1-UP", 0.55, 0.50, timestamp=now), now=now
        )
        result = engine.compute(market, now)
        assert result.context.market_probability is None
        assert any("crossed" in issue for issue in result.context.issues)

    def test_devig_normalises_both_sides(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        # UP mid 0.55, DOWN mid 0.50 -> total 1.05, so 5 points of vig.
        books.apply_book_event(make_book("m1-UP", 0.54, 0.56, timestamp=now), now=now)
        books.apply_book_event(make_book("m1-DOWN", 0.49, 0.51, timestamp=now), now=now)
        result = engine.compute(market, now)
        probability = result.context.market_probability
        assert probability.source == "devigged"
        assert probability.vig == pytest.approx(0.05, abs=1e-9)
        assert probability.implied_up + probability.implied_down == pytest.approx(1.0)
        assert probability.implied_up == pytest.approx(0.55 / 1.05)

    def test_single_sided_market_probability(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(make_book("m1-UP", 0.54, 0.56, timestamp=now), now=now)
        result = engine.compute(market, now)
        assert result.context.market_probability.source == "up_only"

    def test_time_features_count_down(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        early = engine.compute(market, WINDOW_START + 30).features
        late = engine.compute(market, WINDOW_START + 270).features
        assert early["t_remaining"] > late["t_remaining"]
        assert early["t_fraction"] < late["t_fraction"]

    def test_basis_share_rises_near_expiry(self):
        composite, books, engine = build(sigma_basis=basis_sigma_from_bps(2.0))
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        early = engine.compute(market, WINDOW_START + 30).features
        late = engine.compute(market, WINDOW_START + 295).features
        assert late["basis_share"] > early["basis_share"]

    def test_noise_diagnostics_exposed(self):
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        features = engine.compute(market, WINDOW_START + 150).features
        assert "vol_noise_bps" in features
        assert "vol_noise_share" in features
        assert 0.0 <= features["vol_noise_share"] <= 1.0

    def test_all_values_are_finite(self):
        composite, books, engine = build()
        prime_prices(composite, drift=1e-6)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(make_book("m1-UP", 0.50, 0.51, timestamp=now), now=now)
        books.apply_book_event(make_book("m1-DOWN", 0.49, 0.50, timestamp=now), now=now)
        for value in engine.compute(market, now).features.values():
            assert math.isfinite(value)

    def test_state_is_pruned(self):
        composite, books, engine = build()
        prime_prices(composite)
        now = WINDOW_START + 150
        for i in range(3):
            market = make_market(f"m{i}", window_start=WINDOW_START)
            books.apply_book_event(
                make_book(f"m{i}-UP", 0.5, 0.51, timestamp=now), now=now
            )
            engine.compute(market, now)
        assert len(engine.states) == 3
        engine.prune({"m0"})
        assert set(engine.states) == {"m0"}


class TestCausality:
    def test_features_never_use_future_observations(self):
        """Computing at t, then feeding later data, must not change the value
        computed at t."""
        composite, books, engine = build()
        prime_prices(composite)
        market = make_market(window_start=WINDOW_START)
        now = WINDOW_START + 150
        books.apply_book_event(make_book("m1-UP", 0.50, 0.51, timestamp=now), now=now)
        first = dict(engine.compute(market, now).features)

        # Now push a dramatic move *after* `now` and recompute at `now`.
        for i in range(30):
            ts = now + 1 + i
            for exchange in ("binance", "coinbase", "kraken"):
                tick = make_tick(exchange, "BTC", "X", 200_000.0)
                tick.received_at = ts
                tick.timestamp = ts
                composite.on_tick(tick)
            composite.compute("BTC", ts)

        second = engine.compute(market, now).features
        for key in ("dist_bps", "ret_30s_bps", "ret_60s_bps"):
            if key in first and key in second:
                assert first[key] == pytest.approx(second[key], abs=1e-6), key
