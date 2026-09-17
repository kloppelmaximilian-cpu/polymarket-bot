"""Order-book state machine and derived microstructure quantities."""

from __future__ import annotations

import pytest

from pmbot.core.types import BookSnapshot, PriceLevel, Side
from pmbot.orderbook.book import LiveBook, OrderBookManager


def snapshot(bids, asks, ts=1000.0, token="TOK") -> BookSnapshot:
    return BookSnapshot(
        token_id=token,
        bids=[PriceLevel(p, s) for p, s in bids],
        asks=[PriceLevel(p, s) for p, s in asks],
        timestamp=ts,
    )


class TestSnapshotMaths:
    def test_touch_and_spread(self):
        book = snapshot([(0.50, 100), (0.49, 200)], [(0.52, 50), (0.53, 80)])
        assert book.best_bid == 0.50
        assert book.best_ask == 0.52
        assert book.mid == pytest.approx(0.51)
        assert book.spread == pytest.approx(0.02)

    def test_microprice_leans_toward_the_thin_side(self):
        thin_ask = snapshot([(0.50, 900)], [(0.52, 10)])
        assert thin_ask.microprice > thin_ask.mid
        thin_bid = snapshot([(0.50, 10)], [(0.52, 900)])
        assert thin_bid.microprice < thin_bid.mid

    def test_microprice_equals_mid_with_balanced_sizes(self):
        book = snapshot([(0.50, 100)], [(0.52, 100)])
        assert book.microprice == pytest.approx(book.mid)

    def test_depth_only_counts_levels_inside_the_band(self):
        book = snapshot([(0.50, 10), (0.49, 20), (0.30, 1000)], [(0.52, 5)])
        assert book.depth("bid", within=0.05) == pytest.approx(30)
        assert book.depth("bid", within=0.25) == pytest.approx(1030)

    def test_notional_depth_weights_by_price(self):
        book = snapshot([(0.50, 10)], [(0.52, 10)])
        assert book.notional_depth("bid", 0.05) == pytest.approx(5.0)
        assert book.notional_depth("ask", 0.05) == pytest.approx(5.2)

    def test_imbalance_range_and_sign(self):
        assert snapshot([(0.5, 100)], [(0.52, 100)]).imbalance() == pytest.approx(0.0)
        assert snapshot([(0.5, 300)], [(0.52, 100)]).imbalance() == pytest.approx(0.5)
        assert snapshot([(0.5, 100)], [(0.52, 300)]).imbalance() == pytest.approx(-0.5)
        assert snapshot([], []).imbalance() == 0.0

    def test_walk_computes_the_real_average_price(self):
        book = snapshot([], [(0.52, 20), (0.53, 50)])
        avg, filled = book.walk(Side.BUY, 30)
        assert filled == 30
        assert avg == pytest.approx((20 * 0.52 + 10 * 0.53) / 30)

    def test_walk_returns_partial_when_the_book_is_thin(self):
        book = snapshot([], [(0.52, 5)])
        avg, filled = book.walk(Side.BUY, 100)
        assert filled == 5
        assert avg == pytest.approx(0.52)

    def test_walk_on_empty_side(self):
        assert snapshot([], []).walk(Side.BUY, 10) is None
        assert snapshot([(0.5, 10)], []).walk(Side.BUY, 10) is None

    def test_slippage_is_never_negative(self):
        book = snapshot([(0.48, 100)], [(0.52, 20), (0.60, 500)])
        assert book.slippage(Side.BUY, 100) >= 0
        assert book.slippage(Side.SELL, 50) >= 0

    def test_sell_walks_the_bids(self):
        book = snapshot([(0.50, 10), (0.45, 100)], [])
        avg, filled = book.walk(Side.SELL, 60)
        assert filled == 60
        assert avg == pytest.approx((10 * 0.50 + 50 * 0.45) / 60)

    def test_crossed_and_empty_detection(self):
        assert snapshot([(0.55, 10)], [(0.50, 10)]).is_crossed() is True
        assert snapshot([(0.50, 10)], [(0.55, 10)]).is_crossed() is False
        assert snapshot([], []).is_empty() is True

    def test_missing_side_gives_no_mid(self):
        assert snapshot([(0.5, 10)], []).mid is None
        assert snapshot([], [(0.5, 10)]).spread is None


class TestLiveBook:
    def test_delta_before_snapshot_is_dropped(self):
        """Applying a delta to an empty book would fabricate a one-sided book."""
        book = LiveBook("TOK")
        assert book.apply_delta("BUY", 0.50, 100) is False
        assert book.snapshot().is_empty()

    def test_snapshot_then_deltas(self):
        book = LiveBook("TOK")
        book.apply_snapshot(
            [PriceLevel(0.50, 100)], [PriceLevel(0.52, 50)], now=1000.0
        )
        assert book.apply_delta("BUY", 0.51, 75, now=1001.0) is True
        assert book.snapshot().best_bid == 0.51
        assert book.apply_delta("BUY", 0.51, 0, now=1002.0) is True
        assert book.snapshot().best_bid == 0.50

    def test_out_of_range_prices_rejected(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.5, 10)], [PriceLevel(0.6, 10)], now=1.0)
        assert book.apply_delta("BUY", 0.0, 10) is False
        assert book.apply_delta("BUY", 1.0, 10) is False
        assert book.apply_delta("BUY", 1.5, 10) is False

    def test_snapshot_is_cached_until_the_book_changes(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.5, 10)], [PriceLevel(0.6, 10)], now=1.0)
        first = book.snapshot()
        assert book.snapshot() is first
        book.apply_delta("BUY", 0.55, 5, now=2.0)
        assert book.snapshot() is not first

    def test_staleness(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.5, 10)], [PriceLevel(0.6, 10)], now=1000.0)
        assert book.is_stale(5.0, now=1002.0) is False
        assert book.is_stale(5.0, now=1010.0) is True
        assert book.age(now=1010.0) == pytest.approx(10.0)

    def test_usability_requires_two_sides_and_freshness(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.5, 10)], [], now=1000.0)
        assert book.is_usable(5.0, now=1001.0) is False
        book.apply_snapshot([PriceLevel(0.5, 10)], [PriceLevel(0.6, 10)], now=1000.0)
        assert book.is_usable(5.0, now=1001.0) is True
        assert book.is_usable(5.0, now=1100.0) is False

    def test_crossed_book_is_not_usable(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.6, 10)], [PriceLevel(0.5, 10)], now=1000.0)
        assert book.is_usable(5.0, now=1001.0) is False

    def test_tick_size_update(self):
        book = LiveBook("TOK")
        book.apply_snapshot([PriceLevel(0.5, 10)], [PriceLevel(0.6, 10)], now=1.0)
        book.set_tick_size(0.001)
        assert book.snapshot().tick_size == 0.001


class TestManager:
    def test_tracks_multiple_tokens(self):
        manager = OrderBookManager()
        manager.apply_book_event(snapshot([(0.5, 10)], [(0.6, 10)], token="A"))
        manager.apply_book_event(snapshot([(0.3, 10)], [(0.4, 10)], token="B"))
        assert manager.snapshot("A").best_bid == 0.5
        assert manager.snapshot("B").best_bid == 0.3
        assert manager.snapshot("C") is None

    def test_counts_dropped_deltas(self):
        manager = OrderBookManager()
        manager.apply_price_change("A", "BUY", 0.5, 10)
        manager.apply_price_change("A", "BUY", 0.5, 10)
        assert manager.dropped_deltas == 2

    def test_counts_crossed_snapshots(self):
        manager = OrderBookManager()
        manager.apply_book_event(snapshot([(0.6, 10)], [(0.5, 10)], token="A"))
        assert manager.crossed_books == 1

    def test_trade_tape_is_bounded_and_time_filtered(self):
        manager = OrderBookManager()
        for i in range(500):
            manager.record_trade("A", 0.5, 1.0, Side.BUY, 1000.0 + i, keep=100)
        assert len(manager.trades["A"]) <= 100
        recent = manager.recent_trades("A", 10.0, now=1499.0)
        assert all(t.timestamp >= 1489.0 for t in recent)

    def test_prune_forgets_untracked_tokens(self):
        manager = OrderBookManager()
        for token in ("A", "B", "C"):
            manager.apply_book_event(snapshot([(0.5, 10)], [(0.6, 10)], token=token))
        assert manager.prune({"A"}) == 2
        assert set(manager.books) == {"A"}

    def test_health_summary(self):
        manager = OrderBookManager(stale_seconds=5.0)
        manager.apply_book_event(snapshot([(0.5, 10)], [(0.6, 10)], token="A"), now=1000.0)
        health = manager.health(now=1001.0)
        assert health["books"] == 1
        assert health["usable"] == 1
        stale = manager.health(now=1100.0)
        assert stale["fresh"] == 0
