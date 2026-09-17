"""Reference-exchange feeds and the composite price."""

from __future__ import annotations

import time

import pytest

from pmbot.core.types import FeedStatus
from pmbot.exchanges.base import make_tick
from pmbot.exchanges.composite import CompositePriceEngine
from pmbot.exchanges.venues import (
    BinanceFeed,
    BybitFeed,
    CoinbaseFeed,
    KrakenFeed,
    OKXFeed,
    build_feeds,
)


class TestVenueParsers:
    def test_binance_trade(self):
        feed = BinanceFeed(["BTC"])
        ticks = feed.parse({
            "stream": "btcusdt@trade",
            "data": {"e": "trade", "s": "BTCUSDT", "p": "100123.45", "q": "0.01",
                     "T": 1789620000000},
        })
        assert len(ticks) == 1
        assert ticks[0].price == 100123.45
        assert ticks[0].is_trade is True
        assert ticks[0].timestamp == 1789620000.0

    def test_binance_book_ticker(self):
        feed = BinanceFeed(["BTC"])
        ticks = feed.parse({
            "stream": "btcusdt@bookTicker",
            "data": {"u": 1, "s": "BTCUSDT", "b": "100120.0", "B": "1",
                     "a": "100121.0", "A": "2"},
        })
        assert ticks[0].price == pytest.approx(100120.5)
        assert ticks[0].is_trade is False

    def test_binance_streams_in_url(self):
        feed = BinanceFeed(["BTC", "ETH"])
        assert "btcusdt@trade" in feed.url
        assert "ethusdt@bookTicker" in feed.url
        assert feed.subscribe_messages() == []

    def test_coinbase_ticker(self):
        ticks = CoinbaseFeed(["BTC"]).parse({
            "type": "ticker", "product_id": "BTC-USD", "price": "100400.1",
            "best_bid": "100399", "best_ask": "100401", "last_size": "0.02",
            "time": "2026-09-17T04:00:00.000000Z",
        })
        assert ticks[0].price == 100400.1
        assert ticks[0].bid == 100399.0

    def test_coinbase_subscription_payload(self):
        messages = list(CoinbaseFeed(["BTC", "ETH"]).subscribe_messages())
        assert messages[0]["type"] == "subscribe"
        assert messages[0]["product_ids"] == ["BTC-USD", "ETH-USD"]

    def test_kraken_v2_ticker(self):
        ticks = KrakenFeed(["BTC"]).parse({
            "channel": "ticker", "type": "update",
            "data": [{"symbol": "BTC/USD", "bid": 100100.0, "ask": 100101.0,
                      "last": 100100.5}],
        })
        assert ticks[0].price == pytest.approx(100100.5)

    def test_kraken_maps_doge_to_xdg(self):
        feed = KrakenFeed(["DOGE"])
        assert feed.symbol_map["DOGE"] == "XDG/USD"
        assert feed.asset_for_symbol("XDG/USD") == "DOGE"

    def test_okx_trades_and_bbo(self):
        feed = OKXFeed(["BTC"])
        trades = feed.parse({
            "arg": {"channel": "trades", "instId": "BTC-USDT"},
            "data": [{"instId": "BTC-USDT", "px": "100200", "sz": "0.5",
                      "side": "buy", "ts": "1789620000000"}],
        })
        assert trades[0].price == 100200.0
        bbo = feed.parse({
            "arg": {"channel": "bbo-tbt", "instId": "BTC-USDT"},
            "data": [{"bids": [["100199", "1", "0", "1"]],
                      "asks": [["100201", "1", "0", "1"]], "ts": "1789620000000"}],
        })
        assert bbo[0].price == pytest.approx(100200.0)
        assert bbo[0].is_trade is False

    def test_okx_uses_text_ping(self):
        assert OKXFeed(["BTC"]).text_ping == "ping"

    def test_bybit_trade_and_ticker(self):
        feed = BybitFeed(["BTC"])
        trades = feed.parse({
            "topic": "publicTrade.BTCUSDT", "ts": 1789620000000,
            "data": [{"T": 1789620000000, "s": "BTCUSDT", "S": "Buy",
                      "v": "0.1", "p": "100300"}],
        })
        assert trades[0].price == 100300.0
        tickers = feed.parse({
            "topic": "tickers.BTCUSDT", "ts": 1789620000000,
            "data": {"symbol": "BTCUSDT", "bid1Price": "100299",
                     "ask1Price": "100301", "lastPrice": "100300"},
        })
        assert tickers[0].price == pytest.approx(100300.0)

    def test_bybit_uses_json_ping(self):
        assert BybitFeed(["BTC"]).json_ping == {"op": "ping"}

    @pytest.mark.parametrize(
        "feed_cls", [BinanceFeed, CoinbaseFeed, KrakenFeed, OKXFeed, BybitFeed]
    )
    @pytest.mark.parametrize(
        "message",
        [{}, {"topic": 123}, {"data": None}, {"channel": "heartbeat"},
         {"arg": {}}, {"stream": "x", "data": "not a dict"},
         {"type": "subscriptions"}, {"op": "pong"}],
    )
    def test_malformed_messages_never_raise(self, feed_cls, message):
        assert feed_cls(["BTC"]).parse(message) == []

    def test_unknown_asset_is_ignored(self):
        feed = BinanceFeed(["BTC"])
        assert feed.parse({
            "data": {"e": "trade", "s": "SHIBUSDT", "p": "1", "q": "1", "T": 1}
        }) == []


class TestValidation:
    def test_future_timestamp_rejected(self):
        feed = BinanceFeed(["BTC"])
        tick = make_tick("binance", "BTC", "BTCUSDT", 100.0, exchange_ts=time.time() + 600)
        assert feed._validate(tick) is False

    def test_ancient_timestamp_rejected(self):
        feed = BinanceFeed(["BTC"])
        tick = make_tick("binance", "BTC", "BTCUSDT", 100.0, exchange_ts=time.time() - 600)
        assert feed._validate(tick) is False

    def test_outlier_jump_rejected(self):
        feed = BinanceFeed(["BTC"])
        assert feed._validate(make_tick("binance", "BTC", "X", 100_000.0)) is True
        feed._last_prices["BTC"] = 100_000.0
        assert feed._validate(make_tick("binance", "BTC", "X", 50_000.0)) is False
        assert feed._validate(make_tick("binance", "BTC", "X", 100_500.0)) is True

    def test_non_positive_price_rejected(self):
        feed = BinanceFeed(["BTC"])
        assert feed._validate(make_tick("binance", "BTC", "X", 0.0)) is False


class TestHealth:
    def test_stale_feed_degrades_then_goes_offline(self):
        feed = BinanceFeed(["BTC"], stale_after=3.0)
        feed.health.status = FeedStatus.ONLINE
        feed.health.last_message_at = 1000.0
        assert feed.update_health(now=1001.0).status is FeedStatus.ONLINE
        assert feed.update_health(now=1005.0).status is FeedStatus.DEGRADED
        assert feed.update_health(now=1020.0).status is FeedStatus.OFFLINE
        assert feed.health.score == 0.0

    def test_score_decays_with_age(self):
        feed = BinanceFeed(["BTC"], stale_after=3.0)
        feed.health.status = FeedStatus.ONLINE
        feed.health.last_message_at = 1000.0
        fresh = feed.update_health(now=1000.1).score
        feed.health.status = FeedStatus.ONLINE
        older = feed.update_health(now=1004.0).score
        assert fresh > older


class TestBuildFeeds:
    def test_builds_known_feeds_only(self):
        feeds = build_feeds(["binance", "kraken", "nonsense"], ["BTC"])
        assert [f.name for f in feeds] == ["binance", "kraken"]

    def test_skips_feeds_with_no_supported_assets(self):
        assert build_feeds(["coinbase"], ["NOTACOIN"]) == []


class TestComposite:
    def _engine(self, **kwargs):
        defaults = dict(assets=["BTC"], stale_seconds=3.0, min_sources=2)
        defaults.update(kwargs)
        return CompositePriceEngine(**defaults)

    def test_combines_multiple_venues(self):
        engine = self._engine()
        now = 1000.0
        for exchange, price in [("binance", 100_000.0), ("coinbase", 100_010.0),
                                ("kraken", 100_005.0)]:
            tick = make_tick(exchange, "BTC", "X", price)
            tick.received_at = now
            engine.on_tick(tick)
        composite = engine.compute("BTC", now)
        assert composite.n_sources == 3
        assert 100_000 <= composite.price <= 100_010
        assert composite.is_healthy is True

    def test_rejects_a_single_bad_venue(self):
        engine = self._engine()
        now = 1000.0
        prices = {"binance": 100_000.0, "coinbase": 100_010.0, "kraken": 100_005.0,
                  "okx": 100_002.0, "bybit": 50_000.0}
        for exchange, price in prices.items():
            tick = make_tick(exchange, "BTC", "X", price)
            tick.received_at = now
            engine.on_tick(tick)
        composite = engine.compute("BTC", now)
        assert composite.n_sources == 4
        assert composite.price == pytest.approx(100_004, abs=10)
        assert "bybit" not in composite.contributors

    def test_stale_observations_excluded(self):
        engine = self._engine()
        old = make_tick("binance", "BTC", "X", 100_000.0)
        old.received_at = 1000.0
        engine.on_tick(old)
        fresh = make_tick("coinbase", "BTC", "X", 100_010.0)
        fresh.received_at = 1010.0
        engine.on_tick(fresh)
        composite = engine.compute("BTC", 1010.0)
        assert composite.n_sources == 1
        assert composite.is_healthy is False
        assert "need 2" in composite.reason

    def test_no_data_is_unhealthy_not_zero_price(self):
        composite = self._engine().compute("BTC", 1000.0)
        assert composite.is_healthy is False
        assert composite.n_sources == 0

    def test_divergence_flagged(self):
        engine = self._engine(divergence_bps=5.0)
        now = 1000.0
        for exchange, price in [("binance", 100_000.0), ("coinbase", 100_200.0),
                                ("kraken", 100_100.0)]:
            tick = make_tick(exchange, "BTC", "X", price)
            tick.received_at = now
            engine.on_tick(tick)
        composite = engine.compute("BTC", now)
        assert composite.is_healthy is False
        assert "divergence" in composite.reason

    def test_out_of_order_ticks_ignored(self):
        engine = self._engine()
        newer = make_tick("binance", "BTC", "X", 100_000.0)
        newer.received_at = 1010.0
        engine.on_tick(newer)
        older = make_tick("binance", "BTC", "X", 99_000.0)
        older.received_at = 1000.0
        engine.on_tick(older)
        assert engine.per_exchange_prices("BTC")["binance"] == 100_000.0

    def test_health_weighting_favours_healthy_venues(self):
        engine = self._engine(min_sources=1)
        engine.set_health("binance", 1.0)
        engine.set_health("coinbase", 0.05)
        now = 1000.0
        for exchange, price in [("binance", 100_000.0), ("coinbase", 101_000.0)]:
            tick = make_tick(exchange, "BTC", "X", price)
            tick.received_at = now
            engine.on_tick(tick)
        composite = engine.compute("BTC", now)
        assert composite.price < 100_200


class TestStrikeRegistry:
    def test_records_strike_at_window_boundary(self):
        engine = CompositePriceEngine(["BTC"], min_sources=1, window_seconds=300)
        boundary = 1_760_000_100.0                      # a multiple of 300
        assert boundary % 300 == 0
        tick = make_tick("binance", "BTC", "X", 100_000.0)
        tick.received_at = boundary + 0.4
        engine.on_tick(tick)
        engine.compute("BTC", boundary + 0.4)
        record = engine.strike_for("BTC", boundary)
        assert record.quality == "exact"
        assert record.price == 100_000.0
        assert record.is_usable

    def test_unknown_strike_reported_not_guessed(self):
        engine = CompositePriceEngine(["BTC"], min_sources=1)
        record = engine.strike_for("BTC", 1_760_000_100.0)
        assert record.quality == "unknown"
        assert record.is_usable is False

    def test_backfills_from_history_when_close_enough(self):
        engine = CompositePriceEngine(["BTC"], min_sources=1, window_seconds=300)
        boundary = 1_760_000_400.0
        for offset in (-4.0, -2.0):
            tick = make_tick("binance", "BTC", "X", 100_000.0 + offset)
            tick.received_at = boundary + offset
            engine.on_tick(tick)
            engine.compute("BTC", boundary + offset)
        record = engine.strike_for("BTC", boundary)
        assert record.quality in ("exact", "interpolated")
        assert record.is_usable

    def test_external_seed_accepted(self):
        engine = CompositePriceEngine(["BTC"])
        engine.seed_strike("BTC", 1_760_000_400.0, 99_999.0, quality="external")
        record = engine.strike_for("BTC", 1_760_000_400.0)
        assert record.price == 99_999.0

    def test_strike_memory_is_bounded(self):
        engine = CompositePriceEngine(["BTC"], min_sources=1, window_seconds=300)
        for i in range(120):
            boundary = 1_760_000_400.0 + i * 300
            tick = make_tick("binance", "BTC", "X", 100_000.0 + i)
            tick.received_at = boundary + 0.2
            engine.on_tick(tick)
            engine.compute("BTC", boundary + 0.2)
        assert len(engine.states["BTC"].strikes) <= 48


class TestTradeFlow:
    def test_signs_flow_by_side_of_mid(self):
        engine = CompositePriceEngine(["BTC"], min_sources=1)
        buy = make_tick("binance", "BTC", "X", 100_010.0, size=1.0,
                        bid=100_000.0, ask=100_005.0)
        buy.received_at = 1000.0
        engine.on_tick(buy)
        sell = make_tick("binance", "BTC", "X", 99_990.0, size=2.0,
                         bid=100_000.0, ask=100_005.0)
        sell.received_at = 1001.0
        engine.on_tick(sell)
        flow = engine.trade_flow("BTC", 10.0, now=1001.0)
        assert [row[1] for row in flow] == [1.0, -2.0]


class TestStrikeCaptureRegression:
    """A strike back-filled before the window opened must never survive.

    This was a real bug: the bot looks at a market before its window opens, the
    back-fill path cached a strike from up to five seconds early, and the exact
    snapshot taken at the boundary was then ignored.  The resulting ~2bps error
    in log-moneyness is a large fraction of a five-minute move and made the
    model lose to the market at every horizon.
    """

    def _engine(self):
        return CompositePriceEngine(
            ["BTC"], stale_seconds=3.0, min_sources=1, window_seconds=300
        )

    def _feed(self, engine, ts, price):
        tick = make_tick("binance", "BTC", "X", price)
        tick.received_at = ts
        tick.timestamp = ts
        engine.on_tick(tick)
        engine.compute("BTC", ts)

    def test_exact_snapshot_replaces_an_earlier_backfill(self):
        engine = self._engine()
        boundary = 1_760_000_400.0
        for offset in (-5.0, -3.0, -1.0):
            self._feed(engine, boundary + offset, 100_000.0 + offset)
        # Looking at the market before it opens must not pin a strike.
        early = engine.strike_for("BTC", boundary, now=boundary - 1.0)
        assert early.quality == "unknown"
        assert not early.is_usable

        self._feed(engine, boundary, 100_500.0)
        record = engine.strike_for("BTC", boundary, now=boundary)
        assert record.quality == "exact"
        assert record.price == pytest.approx(100_500.0)

    def test_a_future_window_has_no_strike(self):
        engine = self._engine()
        boundary = 1_760_000_400.0
        self._feed(engine, boundary - 2.0, 100_000.0)
        assert engine.strike_for("BTC", boundary, now=boundary - 2.0).quality == "unknown"

    def test_backfill_is_used_when_the_boundary_was_missed(self):
        engine = self._engine()
        boundary = 1_760_000_400.0
        self._feed(engine, boundary - 2.0, 100_000.0)
        record = engine.strike_for("BTC", boundary, now=boundary + 30.0)
        assert record.quality == "interpolated"
        assert record.is_usable

    def test_a_long_gap_leaves_the_strike_unknown(self):
        engine = self._engine()
        boundary = 1_760_000_400.0
        self._feed(engine, boundary - 60.0, 100_000.0)
        assert engine.strike_for("BTC", boundary, now=boundary + 30.0).quality == "unknown"

    def test_quality_ordering(self):
        from pmbot.exchanges.composite import StrikeRecord, _is_better_strike

        exact = StrikeRecord(100.0, 1.0, "exact", 100.0)
        interpolated = StrikeRecord(100.0, 1.0, "interpolated", 97.0)
        assert _is_better_strike(exact, interpolated)
        assert not _is_better_strike(interpolated, exact)
        closer = StrikeRecord(100.0, 1.0, "interpolated", 99.0)
        assert _is_better_strike(closer, interpolated)

    def test_external_seed_outranks_a_backfill(self):
        engine = self._engine()
        boundary = 1_760_000_400.0
        self._feed(engine, boundary - 4.0, 100_000.0)
        engine.strike_for("BTC", boundary, now=boundary + 10.0)   # caches interpolated
        engine.seed_strike("BTC", boundary, 100_777.0, quality="external")
        record = engine.strike_for("BTC", boundary, now=boundary + 10.0)
        assert record.price == pytest.approx(100_777.0)
