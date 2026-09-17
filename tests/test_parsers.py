"""Polymarket payload parsing, against real observed shapes."""

from __future__ import annotations

import json

import pytest

from pmbot.core.types import Outcome
from pmbot.polymarket.parsers import (
    classify_outcome,
    detect_asset,
    detect_window_seconds,
    loads_maybe,
    parse_book,
    parse_market,
    parse_tokens,
    parse_window,
    slug_timestamp,
)

# A real Gamma event for a BTC 5-minute market (field names and the
# stringified-JSON quirks are exactly as the API returns them).
REAL_EVENT = json.loads("""
{
  "id": "473573",
  "ticker": "btc-updown-5m-1778584200",
  "slug": "btc-updown-5m-1778584200",
  "title": "Bitcoin Up or Down - May 12, 7:10AM-7:15AM ET",
  "resolutionSource": "https://data.chain.link/streams/btc-usd",
  "endDate": "2026-05-12T11:15:00Z",
  "active": true, "closed": false, "archived": false,
  "liquidity": 11045.0965, "volume": 147.934704,
  "enableOrderBook": true, "negRisk": false,
  "markets": [{
    "id": "2229686",
    "question": "Bitcoin Up or Down - May 12, 7:10AM-7:15AM ET",
    "conditionId": "0xa5c6d0c4cef71fe53c0235790b5568574343551fe67c62db39e9ebf3387b415a",
    "slug": "btc-updown-5m-1778584200",
    "resolutionSource": "https://data.chain.link/streams/btc-usd",
    "endDate": "2026-05-12T11:15:00Z",
    "outcomes": "[\\"Up\\", \\"Down\\"]",
    "outcomePrices": "[\\"0.515\\", \\"0.485\\"]",
    "active": true, "closed": false,
    "questionID": "0xdd168c6edb30b13aba5b7fa3090a84a2e30f6cda428de06bd5db6fcb68765850",
    "enableOrderBook": true,
    "orderPriceMinTickSize": 0.01,
    "orderMinSize": 5,
    "clobTokenIds": "[\\"48418917734180607831833027288777571190488909295977497623601373906809754084036\\", \\"14943202171143669362180565155331992758433128192256190594100236888666963607938\\"]",
    "makerBaseFee": 1000, "takerBaseFee": 1000,
    "acceptingOrders": true, "negRisk": false,
    "rewardsMinSize": 50, "rewardsMaxSpread": 4.5,
    "spread": 0.01, "lastTradePrice": 0.52, "bestBid": 0.51, "bestAsk": 0.52,
    "eventStartTime": "2026-05-12T11:10:00Z",
    "feesEnabled": true, "makerRebatesFeeShareBps": 10000,
    "feeType": "crypto_fees_v2",
    "feeSchedule": {"exponent": 1, "rate": 0.07, "takerOnly": true, "rebateRate": 0.2}
  }],
  "series": [{"id": "10684", "ticker": "btc-up-or-down-5m",
              "slug": "btc-up-or-down-5m", "recurrence": "5m"}],
  "seriesSlug": "btc-up-or-down-5m",
  "startTime": "2026-05-12T11:10:00Z"
}
""")


class TestHelpers:
    def test_loads_maybe_handles_both_forms(self):
        assert loads_maybe('["Up", "Down"]') == ["Up", "Down"]
        assert loads_maybe(["Up", "Down"]) == ["Up", "Down"]
        assert loads_maybe("not json") is None
        assert loads_maybe(None) is None
        assert loads_maybe("") is None

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("btc-up-or-down-5m", "BTC"),
            ("Bitcoin Up or Down", "BTC"),
            ("eth-updown-5m-123", "ETH"),
            ("Solana Up or Down", "SOL"),
            ("xrp-up-or-down-5m", "XRP"),
            ("dogecoin-updown", "DOGE"),
            ("hype-up-or-down-5m", "HYPE"),
            ("something-else", None),
        ],
    )
    def test_detect_asset(self, text, expected):
        assert detect_asset(text) == expected

    @pytest.mark.parametrize(
        "text,expected",
        [("5m", 300), ("btc-updown-5m-1", 300), ("15m", 900), ("1h", 3600),
         ("nothing", None)],
    )
    def test_detect_window_seconds(self, text, expected):
        assert detect_window_seconds(text) == expected

    def test_slug_timestamp(self):
        assert slug_timestamp("btc-updown-5m-1778584200") == 1778584200.0
        assert slug_timestamp("btc-updown-5m") is None
        assert slug_timestamp("x-1") is None            # out of the sanity band

    @pytest.mark.parametrize(
        "label,expected",
        [("Up", Outcome.UP), ("up", Outcome.UP), ("Yes", Outcome.UP),
         ("Down", Outcome.DOWN), ("No", Outcome.DOWN), ("Maybe", None)],
    )
    def test_classify_outcome(self, label, expected):
        assert classify_outcome(label) == expected


class TestRealMarket:
    def test_parses_completely(self):
        market, reason = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert reason == ""
        assert market is not None
        assert market.asset == "BTC"
        assert market.tick_size == 0.01
        assert market.min_order_size == 5.0
        assert market.neg_risk is False
        assert market.accepting_orders is True

    def test_window_is_exactly_five_minutes_utc(self):
        market, _ = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert market.window_end - market.window_start == 300.0
        # 2026-05-12T11:10:00Z
        assert market.window_start == 1778584200.0

    def test_title_timezone_is_ignored(self):
        """The title says 7:10AM ET; the machine fields say 11:10 UTC.  Trusting
        the title would put every window four hours out."""
        market, _ = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert market.window_start == 1778584200.0

    def test_fee_rate_from_schedule_not_legacy_bps(self):
        market, _ = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert market.taker_fee_rate == pytest.approx(0.07)
        assert market.fee_type == "crypto_fees_v2"

    def test_tokens_mapped_to_outcomes(self):
        market, _ = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert market.token_id(Outcome.UP).startswith("48418917")
        assert market.token_id(Outcome.DOWN).startswith("14943202")
        assert market.outcome_of(market.token_id(Outcome.DOWN)) is Outcome.DOWN

    def test_resolution_source_captured(self):
        market, _ = parse_market(REAL_EVENT["markets"][0], REAL_EVENT)
        assert "chain.link" in market.resolution_source


class TestRejections:
    def test_missing_condition_id(self):
        raw = dict(REAL_EVENT["markets"][0])
        del raw["conditionId"]
        market, reason = parse_market(raw, REAL_EVENT)
        assert market is None
        assert "conditionId" in reason

    def test_bad_outcomes(self):
        raw = dict(REAL_EVENT["markets"][0])
        raw["outcomes"] = '["Maybe", "Perhaps"]'
        market, reason = parse_market(raw, REAL_EVENT)
        assert market is None
        assert "outcomes" in reason

    def test_mismatched_token_count(self):
        raw = dict(REAL_EVENT["markets"][0])
        raw["clobTokenIds"] = '["1"]'
        assert parse_tokens(raw) is None

    def test_missing_window(self):
        raw = {"conditionId": "0x1", "outcomes": '["Up","Down"]',
               "clobTokenIds": '["1","2"]', "slug": "btc-updown"}
        market, reason = parse_market(raw, {})
        assert market is None
        assert "window" in reason

    def test_unknown_asset(self):
        raw = dict(REAL_EVENT["markets"][0])
        raw["slug"] = "mystery-updown-5m-1778584200"
        raw["question"] = "Mystery Up or Down"
        event = {k: v for k, v in REAL_EVENT.items() if k not in ("seriesSlug", "series", "slug", "title")}
        market, reason = parse_market(raw, event)
        assert market is None
        assert "asset" in reason

    def test_window_derived_from_slug_when_fields_missing(self):
        raw = {
            "conditionId": "0x1", "outcomes": '["Up","Down"]',
            "clobTokenIds": '["1","2"]', "slug": "btc-updown-5m-1778584200",
        }
        window = parse_window(raw, {})
        assert window == (1778584200.0, 1778584500.0)

    def test_clob_style_tokens_array(self):
        raw = {
            "conditionId": "0x1",
            "tokens": [{"token_id": "111", "outcome": "Up"},
                       {"token_id": "222", "outcome": "Down"}],
            "slug": "btc-updown-5m-1778584200",
        }
        tokens = parse_tokens(raw)
        assert tokens[Outcome.UP].token_id == "111"


class TestBookParsing:
    def test_normalises_side_ordering(self):
        """Polymarket sends bids ascending and asks descending; we need the
        touch at index 0 on both sides."""
        book = parse_book({
            "asset_id": "TOK",
            "bids": [{"price": "0.48", "size": "30"}, {"price": "0.50", "size": "10"}],
            "asks": [{"price": "0.55", "size": "25"}, {"price": "0.52", "size": "5"}],
            "timestamp": "1789620000000",
            "tick_size": "0.01",
        })
        assert book.best_bid == 0.50
        assert book.best_ask == 0.52
        assert [level.price for level in book.bids] == [0.50, 0.48]
        assert [level.price for level in book.asks] == [0.52, 0.55]

    def test_millisecond_timestamps_converted(self):
        book = parse_book({"asset_id": "T", "bids": [], "asks": [],
                           "timestamp": "1789620000000"})
        assert book.timestamp == 1789620000.0

    def test_second_timestamps_left_alone(self):
        book = parse_book({"asset_id": "T", "bids": [], "asks": [],
                           "timestamp": "1789620000"})
        assert book.timestamp == 1789620000.0

    def test_drops_impossible_levels(self):
        book = parse_book({
            "asset_id": "T",
            "bids": [{"price": "0", "size": "10"}, {"price": "1.5", "size": "10"},
                     {"price": "0.4", "size": "0"}, {"price": "0.3", "size": "5"}],
            "asks": [],
        })
        assert [level.price for level in book.bids] == [0.3]

    def test_accepts_list_style_levels(self):
        book = parse_book({"asset_id": "T", "bids": [["0.4", "10"]], "asks": [["0.6", "5"]]})
        assert book.best_bid == 0.4
        assert book.best_ask == 0.6

    def test_tolerates_garbage(self):
        book = parse_book({"asset_id": "T", "bids": "nonsense", "asks": None})
        assert book.is_empty()
