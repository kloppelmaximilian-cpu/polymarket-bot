"""Automatic market discovery -- no hand-entered ids anywhere."""

from __future__ import annotations

import datetime as dt
import time

import pytest

from pmbot.polymarket.discovery import MarketDiscovery, summarise
from pmbot.polymarket.gamma import GammaClient
from pmbot.polymarket.http import ApiError

WINDOW = 300


def iso(ts: float) -> str:
    return dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_event(asset: str, series_slug: str, window_start: float, index: int,
               recurrence: str = "5m", window: int = WINDOW, **market_overrides):
    slug = f"{asset.lower()}-updown-{recurrence}-{int(window_start)}"
    market = {
        "id": f"mkt-{asset}-{index}",
        "conditionId": f"0xcond{asset}{index}",
        "slug": slug,
        "question": f"{asset} Up or Down",
        "outcomes": '["Up", "Down"]',
        "clobTokenIds": f'["{asset}-UP-{index}", "{asset}-DOWN-{index}"]',
        "eventStartTime": iso(window_start),
        "endDate": iso(window_start + window),
        "orderPriceMinTickSize": 0.01,
        "orderMinSize": 5,
        "acceptingOrders": True,
        "enableOrderBook": True,
        "active": True,
        "closed": False,
        "negRisk": False,
        "feesEnabled": True,
        "feeType": "crypto_fees_v2",
        "feeSchedule": {"rate": 0.07, "takerOnly": True},
    }
    market.update(market_overrides)
    return {
        "id": f"evt-{asset}-{index}",
        "slug": slug,
        "title": f"{asset} Up or Down",
        "seriesSlug": series_slug,
        "series": [{"id": "1", "slug": series_slug, "recurrence": recurrence}],
        "startTime": iso(window_start),
        "endDate": iso(window_start + window),
        "active": True,
        "closed": False,
        "markets": [market],
    }


class FakeGamma(GammaClient):
    def __init__(self, series_events=None, sweep_events=None, fail_series=()):
        self.series_events = series_events or {}
        self.sweep_events = sweep_events or []
        self.fail_series = set(fail_series)
        self.series_calls: list[str] = []
        self.sweep_calls = 0

    async def events_by_series_slug(self, series_slug, limit=500, closed=False):
        self.series_calls.append(series_slug)
        if series_slug in self.fail_series:
            raise ApiError(f"boom for {series_slug}", 500)
        return self.series_events.get(series_slug, [])

    async def active_events(self, limit=500, offset=0, order="endDate"):
        self.sweep_calls += 1
        return self.sweep_events

    async def close(self):
        return None


@pytest.fixture
def base():
    return float(int(time.time()) // WINDOW * WINDOW)


def discovery(gamma, assets=("BTC", "ETH"), **kwargs):
    defaults = dict(
        series_slug_templates=["{asset_lower}-up-or-down-5m", "{asset_lower}-updown-5m"],
        window_seconds=WINDOW, lookahead_seconds=900, max_markets=40,
    )
    defaults.update(kwargs)
    return MarketDiscovery(gamma=gamma, assets=list(assets), **defaults)


class TestSeriesProbe:
    async def test_finds_markets_through_the_series_slug(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [make_event("BTC", "btc-up-or-down-5m", base, 1)],
        })
        found = await discovery(gamma, assets=("BTC",)).discover()
        assert len(found) == 1
        assert found[0].asset == "BTC"
        assert found[0].window_end - found[0].window_start == WINDOW

    async def test_falls_through_template_variants(self, base):
        gamma = FakeGamma({
            "btc-updown-5m": [make_event("BTC", "btc-updown-5m", base, 1)],
        })
        found = await discovery(gamma, assets=("BTC",)).discover()
        assert len(found) == 1
        assert "btc-up-or-down-5m" in gamma.series_calls   # tried first
        assert "btc-updown-5m" in gamma.series_calls

    async def test_resolved_series_is_remembered(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [make_event("BTC", "btc-up-or-down-5m", base, 1)],
        })
        engine = discovery(gamma, assets=("BTC",))
        await engine.discover()
        first_calls = len(gamma.series_calls)
        await engine.discover()
        assert engine.series_by_asset["BTC"] == "btc-up-or-down-5m"
        # The second cycle probes exactly one slug, not the whole template list.
        assert len(gamma.series_calls) - first_calls == 1

    async def test_one_failing_series_does_not_stop_the_others(self, base):
        gamma = FakeGamma(
            {"eth-up-or-down-5m": [make_event("ETH", "eth-up-or-down-5m", base, 1)]},
            fail_series=["btc-up-or-down-5m", "btc-updown-5m"],
        )
        found = await discovery(gamma).discover()
        assert [m.asset for m in found] == ["ETH"]

    async def test_no_hardcoded_ids_anywhere(self):
        import pathlib

        source = pathlib.Path("src/pmbot").rglob("*.py")
        for path in source:
            text = path.read_text()
            # A 60+ digit run would be a pasted CLOB token id.
            assert not any(
                len(chunk) >= 60 and chunk.isdigit()
                for chunk in text.replace('"', " ").replace("'", " ").split()
            ), path


class TestSweep:
    async def test_discovers_an_unconfigured_asset(self, base):
        gamma = FakeGamma(
            sweep_events=[make_event("SOL", "sol-up-or-down-5m", base, 1)]
        )
        engine = discovery(gamma, assets=("BTC",))
        found = await engine.discover()
        assert any(m.asset == "SOL" for m in found)
        assert engine.series_by_asset["SOL"] == "sol-up-or-down-5m"

    async def test_ignores_series_with_the_wrong_recurrence(self, base):
        gamma = FakeGamma(
            sweep_events=[make_event("SOL", "sol-up-or-down-1h", base, 1,
                                     recurrence="1h", window=3600)]
        )
        assert await discovery(gamma, assets=("BTC",)).discover() == []

    async def test_ignores_non_crypto_series(self, base):
        event = make_event("BTC", "election-5m", base, 1)
        event["title"] = "Some Election"
        event["seriesSlug"] = "election-5m"
        event["series"] = [{"slug": "election-5m", "recurrence": "5m"}]
        event["slug"] = "election-5m-1"
        event["markets"][0]["slug"] = "election-5m-1"
        event["markets"][0]["question"] = "Some Election"
        gamma = FakeGamma(sweep_events=[event])
        assert await discovery(gamma, assets=()).discover() == []

    async def test_sweep_failure_is_survivable(self, base):
        class Broken(FakeGamma):
            async def active_events(self, limit=500, offset=0, order="endDate"):
                raise ApiError("sweep down", 503)

        gamma = Broken({
            "btc-up-or-down-5m": [make_event("BTC", "btc-up-or-down-5m", base, 1)]
        })
        found = await discovery(gamma, assets=("BTC",)).discover()
        assert len(found) == 1


class TestFiltering:
    async def test_rejects_a_wrong_length_window(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base, 1, window=900)
            ],
        })
        engine = discovery(gamma, assets=("BTC",))
        assert await engine.discover() == []
        assert any("window" in reason for reason in engine.stats.reject_reasons)

    async def test_rejects_closed_and_inactive_markets(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base, 1, closed=True),
                make_event("BTC", "btc-up-or-down-5m", base, 2, active=False),
            ],
        })
        assert await discovery(gamma, assets=("BTC",)).discover() == []

    async def test_rejects_markets_not_accepting_orders(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base, 1, acceptingOrders=False),
                make_event("BTC", "btc-up-or-down-5m", base, 2, enableOrderBook=False),
            ],
        })
        assert await discovery(gamma, assets=("BTC",)).discover() == []

    async def test_rejects_expired_windows(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base - 3600, 1)
            ],
        })
        assert await discovery(gamma, assets=("BTC",)).discover() == []

    async def test_rejects_windows_beyond_the_lookahead(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base + 7200, 1)
            ],
        })
        engine = discovery(gamma, assets=("BTC",), lookahead_seconds=600)
        assert await engine.discover() == []

    async def test_keeps_upcoming_windows_inside_the_lookahead(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base, 1),
                make_event("BTC", "btc-up-or-down-5m", base + 300, 2),
                make_event("BTC", "btc-up-or-down-5m", base + 600, 3),
            ],
        })
        found = await discovery(gamma, assets=("BTC",), lookahead_seconds=900).discover()
        assert len(found) == 3
        assert [m.window_start for m in found] == sorted(m.window_start for m in found)

    async def test_unparseable_markets_are_counted_not_fatal(self, base):
        broken = make_event("BTC", "btc-up-or-down-5m", base, 1)
        broken["markets"][0]["clobTokenIds"] = "not json"
        good = make_event("BTC", "btc-up-or-down-5m", base, 2)
        gamma = FakeGamma({"btc-up-or-down-5m": [broken, good]})
        engine = discovery(gamma, assets=("BTC",))
        found = await engine.discover()
        assert len(found) == 1
        assert engine.stats.markets_rejected == 1

    async def test_result_is_capped(self, base):
        gamma = FakeGamma({
            "btc-up-or-down-5m": [
                make_event("BTC", "btc-up-or-down-5m", base + i * 300, i)
                for i in range(20)
            ],
        })
        engine = discovery(gamma, assets=("BTC",), max_markets=5,
                           lookahead_seconds=100_000)
        assert len(await engine.discover()) == 5

    async def test_duplicate_markets_are_deduplicated(self, base):
        event = make_event("BTC", "btc-up-or-down-5m", base, 1)
        gamma = FakeGamma({"btc-up-or-down-5m": [event, dict(event)]})
        assert len(await discovery(gamma, assets=("BTC",)).discover()) == 1


class TestSummary:
    def test_counts_live_and_upcoming(self, base):
        from tests.conftest import make_market

        now = base + 10
        markets = [
            make_market("m1", window_start=base),
            make_market("m2", window_start=base + 300),
        ]
        summary = summarise(markets, now)
        assert summary["total"] == 2
        assert summary["live"] == 1
        assert summary["upcoming"] == 1
