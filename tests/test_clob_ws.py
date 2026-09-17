"""Polymarket market-channel websocket handling."""

from __future__ import annotations

import pytest

from pmbot.core.types import FeedStatus, Side
from pmbot.orderbook.book import OrderBookManager
from pmbot.polymarket.clob_ws import PolymarketMarketFeed


@pytest.fixture
def feed():
    return PolymarketMarketFeed(OrderBookManager())


class TestDocumentedEvents:
    def test_book_snapshot(self, feed):
        feed._handle({
            "event_type": "book", "asset_id": "TOK", "market": "0xC",
            "bids": [{"price": ".48", "size": "30"}],
            "asks": [{"price": ".52", "size": "25"}],
            "timestamp": "1789620000000", "hash": "0x1",
        })
        book = feed.books.snapshot("TOK")
        assert book.best_bid == 0.48
        assert book.best_ask == 0.52

    def test_price_change_list_form(self, feed):
        feed._handle({
            "event_type": "book", "asset_id": "TOK",
            "bids": [{"price": "0.48", "size": "30"}],
            "asks": [{"price": "0.52", "size": "25"}],
            "timestamp": "1789620000000",
        })
        feed._handle({
            "event_type": "price_change", "market": "0xC",
            "price_changes": [{
                "asset_id": "TOK", "price": "0.5", "size": "200", "side": "BUY",
                "best_bid": "0.5", "best_ask": "0.52",
            }],
            "timestamp": "1789620001000",
        })
        assert feed.books.snapshot("TOK").best_bid == 0.5
        assert feed.books.get("TOK").best_bid_hint == 0.5

    def test_zero_size_removes_the_level(self, feed):
        feed._handle({
            "event_type": "book", "asset_id": "TOK",
            "bids": [{"price": "0.48", "size": "30"}, {"price": "0.50", "size": "5"}],
            "asks": [{"price": "0.52", "size": "25"}],
            "timestamp": "1",
        })
        feed._handle({
            "event_type": "price_change",
            "price_changes": [{"asset_id": "TOK", "price": "0.5", "size": "0",
                               "side": "BUY"}],
        })
        assert feed.books.snapshot("TOK").best_bid == 0.48

    def test_last_trade_price(self, feed):
        feed._handle({
            "event_type": "last_trade_price", "asset_id": "TOK", "price": "0.51",
            "size": "10", "side": "BUY", "fee_rate_bps": "0",
            "timestamp": "1789620002000",
        })
        trades = feed.books.recent_trades("TOK", 1e9, now=1789620002.0)
        assert len(trades) == 1
        assert trades[0].price == 0.51
        assert trades[0].side is Side.BUY

    def test_tick_size_change_is_honoured(self, feed):
        """Quoting against a stale tick size gets orders rejected."""
        feed._handle({
            "event_type": "tick_size_change", "asset_id": "TOK",
            "old_tick_size": "0.01", "new_tick_size": "0.001",
        })
        assert feed.books.get("TOK").tick_size == 0.001

    def test_best_bid_ask_hints(self, feed):
        feed._handle({
            "event_type": "best_bid_ask", "asset_id": "TOK",
            "best_bid": "0.49", "best_ask": "0.51", "spread": "0.02",
        })
        book = feed.books.get("TOK")
        assert book.best_bid_hint == 0.49
        assert book.best_ask_hint == 0.51

    def test_market_resolved_recorded(self, feed):
        feed._handle({
            "event_type": "market_resolved", "market": "0xCOND",
            "winning_asset_id": "TOK", "winning_outcome": "Up",
        })
        assert feed.resolved["0xCOND"] == "TOK"

    def test_new_market_does_not_raise(self, feed):
        feed._handle({
            "event_type": "new_market", "question": "BTC Up or Down",
            "assets_ids": ["A", "B"], "outcomes": ["Up", "Down"],
        })


class TestRobustness:
    @pytest.mark.parametrize(
        "message",
        [
            {}, {"event_type": "unknown_kind"},
            {"event_type": "book"},
            {"event_type": "book", "asset_id": "T", "bids": "garbage", "asks": None},
            {"event_type": "price_change", "price_changes": "not a list"},
            {"event_type": "price_change", "price_changes": [{}]},
            {"event_type": "price_change", "price_changes": [
                {"asset_id": "T", "price": "x", "size": "y", "side": "BUY"}]},
            {"event_type": "last_trade_price"},
            {"event_type": "last_trade_price", "asset_id": "T", "price": "bad"},
            {"event_type": "tick_size_change", "asset_id": "T"},
            {"event_type": "market_resolved"},
        ],
    )
    def test_malformed_messages_never_raise(self, feed, message):
        feed._handle(message)

    def test_unknown_side_ignored(self, feed):
        feed._handle({
            "event_type": "book", "asset_id": "T",
            "bids": [{"price": "0.4", "size": "1"}],
            "asks": [{"price": "0.6", "size": "1"}], "timestamp": "1",
        })
        before = feed.books.snapshot("T").sequence
        feed._handle({
            "event_type": "price_change",
            "price_changes": [{"asset_id": "T", "price": "0.5", "size": "1",
                               "side": "SIDEWAYS"}],
        })
        assert feed.books.snapshot("T").sequence == before

    def test_callback_receives_every_event(self):
        seen = []
        feed = PolymarketMarketFeed(
            OrderBookManager(), on_event=lambda kind, msg: seen.append(kind)
        )
        feed._handle({"event_type": "book", "asset_id": "T", "bids": [], "asks": [],
                      "timestamp": "1"})
        feed._handle({"event_type": "market_resolved", "market": "0x",
                      "winning_asset_id": "T"})
        assert seen == ["book", "market_resolved"]

    def test_handler_error_is_counted_not_raised(self, feed, monkeypatch):
        def boom(_message):
            raise RuntimeError("kaboom")

        monkeypatch.setattr(feed, "_on_book", boom)
        feed._handle({"event_type": "book", "asset_id": "T"})
        assert feed._parse_errors == 1


class TestSubscriptions:
    async def test_set_tokens_queues_add_and_remove(self, feed):
        await feed.set_tokens({"A", "B"})
        operation, tokens = feed._pending_ops.get_nowait()
        assert operation == "subscribe"
        assert tokens == ["A", "B"]

        await feed.set_tokens({"B", "C"})
        first = feed._pending_ops.get_nowait()
        second = feed._pending_ops.get_nowait()
        operations = {first[0]: first[1], second[0]: second[1]}
        assert operations["subscribe"] == ["C"]
        assert operations["unsubscribe"] == ["A"]

    async def test_unsubscribed_books_are_dropped(self, feed):
        feed.books.apply_price_change("A", "BUY", 0.5, 1)
        feed.books.ensure("A")
        await feed.set_tokens({"A"})
        await feed.set_tokens(set())
        assert feed.books.get("A") is None


class TestHealth:
    def test_stale_then_offline(self, feed):
        feed.health.status = FeedStatus.ONLINE
        feed.health.last_message_at = 1000.0
        assert feed.update_health(now=1001.0).status is FeedStatus.ONLINE
        assert feed.update_health(now=1010.0).status is FeedStatus.DEGRADED
        assert feed.update_health(now=1100.0).status is FeedStatus.OFFLINE

    def test_message_rate_tracked(self, feed):
        for _ in range(10):
            feed._note_message()
        assert feed.health.messages == 10
        assert feed.health.messages_per_sec >= 0
