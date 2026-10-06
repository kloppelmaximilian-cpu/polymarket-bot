"""Market resolution and the proxy/authoritative reconciliation."""

from __future__ import annotations

import pytest

from pmbot.core.types import Outcome
from pmbot.resolution import Resolution, ResolutionSource, ResolutionTracker
from tests.conftest import make_market


@pytest.fixture
def market():
    return make_market()


class TestRules:
    def test_close_above_open_resolves_up(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_proxy(market, 100.0, 100.5, 1300.0).outcome is Outcome.UP

    def test_close_below_open_resolves_down(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_proxy(market, 100.0, 99.5, 1300.0).outcome is Outcome.DOWN

    def test_ties_resolve_up(self, market):
        """The market's own wording: 'greater than or equal to'."""
        tracker = ResolutionTracker()
        assert tracker.from_proxy(market, 100.0, 100.0, 1300.0).outcome is Outcome.UP

    def test_tie_rule_is_configurable(self, market):
        tracker = ResolutionTracker(tie_resolves_up=False)
        assert tracker.from_proxy(market, 100.0, 100.0, 1300.0).outcome is Outcome.DOWN

    def test_invalid_prices_give_no_resolution(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_proxy(market, 0.0, 100.0, 1300.0) is None
        assert tracker.from_proxy(market, 100.0, -1.0, 1300.0) is None


class TestSources:
    def test_proxy_resolution_is_provisional(self, market):
        tracker = ResolutionTracker()
        resolution = tracker.from_proxy(market, 100.0, 100.5, 1300.0)
        assert resolution.provisional is True
        assert resolution.is_authoritative is False

    def test_websocket_resolution_by_token(self, market):
        tracker = ResolutionTracker()
        resolution = tracker.from_websocket(market, market.token_id(Outcome.DOWN), 1310.0)
        assert resolution.outcome is Outcome.DOWN
        assert resolution.is_authoritative

    def test_websocket_resolution_by_label(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_websocket(market, "Up", 1310.0).outcome is Outcome.UP
        assert tracker.from_websocket(market, "nonsense", 1310.0) is None

    def test_gamma_decided_market(self, market):
        tracker = ResolutionTracker()
        resolution = tracker.from_gamma(market, {
            "closed": True, "outcomePrices": '["1", "0"]',
            "outcomes": '["Up", "Down"]',
        }, 1320.0)
        assert resolution.outcome is Outcome.UP
        assert resolution.is_authoritative

    def test_gamma_undecided_market_is_not_a_resolution(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_gamma(market, {
            "closed": True, "outcomePrices": '["0.5", "0.5"]',
            "outcomes": '["Up", "Down"]',
        }, 1320.0) is None

    def test_gamma_open_market_is_not_a_resolution(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_gamma(market, {
            "closed": False, "outcomePrices": '["1", "0"]',
            "outcomes": '["Up", "Down"]',
        }, 1320.0) is None

    def test_gamma_malformed_payload(self, market):
        tracker = ResolutionTracker()
        assert tracker.from_gamma(market, {"closed": True}, 1320.0) is None
        assert tracker.from_gamma(market, {}, 1320.0) is None


class TestReconciliation:
    def test_authoritative_upgrades_a_proxy_resolution(self, market):
        tracker = ResolutionTracker()
        tracker.from_proxy(market, 100.0, 99.9, 1300.0)
        upgraded = tracker.from_websocket(market, market.token_id(Outcome.UP), 1310.0)
        assert upgraded.outcome is Outcome.UP
        assert upgraded.source is ResolutionSource.WEBSOCKET

    def test_agreement_is_counted(self, market):
        tracker = ResolutionTracker()
        tracker.from_proxy(market, 100.0, 100.5, 1300.0)
        tracker.from_websocket(market, market.token_id(Outcome.UP), 1310.0)
        assert tracker.reconciliation.compared == 1
        assert tracker.reconciliation.agreed == 1
        assert tracker.reconciliation.agreement_rate == 1.0

    def test_disagreement_is_recorded_with_detail(self, market):
        tracker = ResolutionTracker()
        tracker.from_proxy(market, 100.0, 100.5, 1300.0)
        tracker.from_websocket(market, market.token_id(Outcome.DOWN), 1310.0)
        assert tracker.reconciliation.disagreed == 1
        assert tracker.reconciliation.disagreements[0]["proxy"] == "UP"
        assert tracker.reconciliation.disagreements[0]["authoritative"] == "DOWN"

    def test_an_authoritative_result_is_never_downgraded(self, market):
        tracker = ResolutionTracker()
        tracker.from_websocket(market, market.token_id(Outcome.UP), 1310.0)
        kept = tracker.record(Resolution(
            market.market_id, Outcome.DOWN, ResolutionSource.LOCAL_PROXY, 1400.0
        ))
        assert kept.outcome is Outcome.UP
        assert kept.source is ResolutionSource.WEBSOCKET

    def test_forget_frees_memory(self, market):
        tracker = ResolutionTracker()
        tracker.from_proxy(market, 100.0, 100.5, 1300.0)
        tracker.forget([market.market_id])
        assert tracker.get(market.market_id) is None
