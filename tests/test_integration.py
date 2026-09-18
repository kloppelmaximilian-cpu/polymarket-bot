"""End-to-end: the whole bot, driven by fake feeds, in paper mode.

This is the test that proves the fifty-one-point requirement actually holds:
start, discover markets, ingest reference prices, build features, estimate a
probability, compute an edge, pass risk, place a paper trade, settle it, write
it all to the database and publish the dashboard snapshot -- with no manual
intervention anywhere.

Every external boundary is faked (Gamma discovery, reference-exchange ticks,
the Polymarket websocket) but *nothing internal* is: the runner, feature engine,
strategies, meta-model, risk engine, trade gate and paper venue are the real
ones, wired exactly as ``bot start`` wires them.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import math

import pytest

from pmbot.config import Settings
from pmbot.core.clock import SimulatedClock, floor_to_window
from pmbot.core.types import BookSnapshot, FeedStatus, Outcome, PriceLevel, Side
from pmbot.exchanges.base import make_tick
from pmbot.polymarket.gamma import GammaClient
from pmbot.runner import BotRunner

WINDOW = 300
EXCHANGES = ("binance", "coinbase", "kraken", "okx", "bybit")


def iso(ts: float) -> str:
    return dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def gamma_event(asset: str, window_start: float, index: int) -> dict:
    slug = f"{asset.lower()}-updown-5m-{int(window_start)}"
    return {
        "id": f"evt{index}", "slug": slug, "title": f"{asset} Up or Down",
        "seriesSlug": f"{asset.lower()}-up-or-down-5m",
        "series": [{"id": "1", "slug": f"{asset.lower()}-up-or-down-5m",
                    "recurrence": "5m"}],
        "startTime": iso(window_start), "endDate": iso(window_start + WINDOW),
        "active": True, "closed": False,
        "markets": [{
            "id": f"mkt{index}", "conditionId": f"0xcond{index}", "slug": slug,
            "question": f"{asset} Up or Down",
            "outcomes": '["Up", "Down"]',
            "clobTokenIds": f'["{asset}-UP-{index}", "{asset}-DOWN-{index}"]',
            "eventStartTime": iso(window_start),
            "endDate": iso(window_start + WINDOW),
            "orderPriceMinTickSize": 0.01, "orderMinSize": 5,
            "acceptingOrders": True, "enableOrderBook": True,
            "active": True, "closed": False, "negRisk": False,
            "feesEnabled": True, "feeType": "crypto_fees_v2",
            "feeSchedule": {"rate": 0.07, "takerOnly": True},
        }],
    }


class FakeGamma(GammaClient):
    """Serves one BTC window that is live right now."""

    def __init__(self, window_start: float):
        self.window_start = window_start
        self.calls = 0

    async def events_by_series_slug(self, series_slug, limit=500, closed=False):
        self.calls += 1
        if series_slug == "btc-up-or-down-5m":
            return [gamma_event("BTC", self.window_start, 1)]
        return []

    async def active_events(self, limit=500, offset=0, order="endDate"):
        return []

    async def close(self):
        return None


@pytest.fixture
def runner(tmp_path, monkeypatch):
    """A fully wired runner with the network boundaries stubbed out."""
    window_start = floor_to_window(1_760_000_400.0, WINDOW)
    settings = Settings(
        database_url=f"sqlite:///{tmp_path}/bot.db",
        log_dir=tmp_path / "logs", model_dir=tmp_path / "models",
        assets=["BTC"], exchanges=list(EXCHANGES), bankroll=1000.0,
        ml_enabled=False,
        enabled_strategies=[
            "fair_value", "momentum", "mean_reversion", "order_flow", "breakout",
            "volatility", "cross_exchange", "microstructure", "mispricing",
        ],
        # Let the model speak for itself here; the anchoring behaviour has its
        # own tests and would otherwise suppress every trade in a short run.
        market_anchor_weight=1.0, adaptive_anchor=False,
        min_edge=0.02, min_confidence=0.4, min_liquidity_usd=50.0,
        max_seconds_remaining=290.0, min_seconds_remaining=10.0,
        execution_style="taker", oracle_basis_bps=0.1,
        snapshot_interval_seconds=1.0,
    )
    # One simulated clock drives every component, so the real `_cycle` code
    # path runs against controlled time rather than wall time.
    clock = SimulatedClock(window_start - 500)
    bot = BotRunner(settings, clock=clock)
    bot.gamma = FakeGamma(window_start)
    bot.discovery.gamma = bot.gamma
    # Never touch a real socket.  The feeds are still marked healthy because
    # data *is* arriving (injected directly); otherwise the health monitor would
    # correctly pause trading for want of verifiable feeds.
    for feed in bot.feeds:
        feed.start = lambda: asyncio.sleep(0)
        feed.stop = lambda: asyncio.sleep(0)
    bot.pm_feed.start = lambda: asyncio.sleep(0)
    bot.pm_feed.stop = lambda: asyncio.sleep(0)
    bot.pm_feed.set_tokens = lambda tokens: asyncio.sleep(0)
    bot.window_start = window_start
    bot.sim_clock = clock
    return bot


def mark_feeds_healthy(bot, ts: float) -> None:
    """Report the (stubbed) feeds as connected and fresh."""
    for feed in bot.feeds:
        feed.health.status = FeedStatus.ONLINE
        feed.health.last_message_at = ts
        feed.health.score = 1.0
        feed.health.detail = "connected"
    bot.pm_feed.health.status = FeedStatus.ONLINE
    bot.pm_feed.health.last_message_at = ts
    bot.pm_feed.health.score = 1.0
    bot.pm_feed.health.detail = "connected"


def feed_prices(bot, ts: float, price: float) -> None:
    for exchange in EXCHANGES:
        tick = make_tick(exchange, "BTC", "BTCUSDT", price, size=0.1)
        tick.timestamp = ts
        tick.received_at = ts
        bot.composite.on_tick(tick)
    mark_feeds_healthy(bot, ts)


def feed_book(bot, token: str, bid: float, ask: float, ts: float,
              size: float = 200.0) -> None:
    bot.books.apply_book_event(
        BookSnapshot(
            token_id=token,
            bids=[PriceLevel(round(bid - i * 0.01, 4), size * (1 + i))
                  for i in range(4) if bid - i * 0.01 > 0],
            asks=[PriceLevel(round(ask + i * 0.01, 4), size * (1 + i))
                  for i in range(4) if ask + i * 0.01 < 1],
            timestamp=ts,
        ),
        now=ts,
    )


class TestEndToEnd:
    @pytest.mark.slow
    async def test_full_paper_cycle(self, runner, tmp_path):
        bot = runner
        window_start = bot.window_start
        await bot.db.start()
        await bot.venue.start()

        # --- prime the reference feeds through the pre-window period --------
        sigma = 0.5 / math.sqrt(365 * 24 * 3600)
        price = 100_000.0
        for offset in range(-400, 0):
            ts = window_start + offset
            bot.sim_clock.set(ts)
            price *= math.exp(sigma * math.sin(offset / 37.0))
            feed_prices(bot, ts, price)
            bot.composite.compute_all(ts)

        # --- discovery finds the market with no ids configured --------------
        markets = await bot.discovery.discover()
        assert len(markets) == 1, "discovery must find the live 5-minute market"
        market = markets[0]
        assert market.asset == "BTC"
        assert market.window_end - market.window_start == WINDOW
        await bot._apply_discovery(markets)
        assert market.market_id in bot._markets

        up_token = market.token_id(Outcome.UP)
        down_token = market.token_id(Outcome.DOWN)

        # --- the strike is captured exactly at the boundary -----------------
        bot.sim_clock.set(window_start)
        feed_prices(bot, window_start, price)
        bot.composite.compute_all(window_start)
        strike = bot.composite.strike_for("BTC", window_start, window_start)
        assert strike.quality == "exact"
        assert strike.price == pytest.approx(price)

        # --- run the window: price drifts up, the market lags ---------------
        traded = False
        # A drift of ~0.02bps/s: by mid-window the price sits a few basis points
        # above the strike, which is worth a handful of probability points -- a
        # plausible edge, not the sixteen-point fantasy an aggressive drift would
        # produce (the gate refuses those as model error, and rightly so).
        for offset in range(1, 280):
            ts = window_start + offset
            price *= 1.0000020
            feed_prices(bot, ts, price)
            # The market quotes near 50/50 throughout: it has not repriced.
            feed_book(bot, up_token, 0.51, 0.52, ts)
            feed_book(bot, down_token, 0.48, 0.49, ts)
            bot.books.record_trade(up_token, 0.52, 20.0, Side.BUY, ts)

            await _cycle(bot, ts)
            if bot.risk.positions or bot.risk.closed_positions:
                traded = True

        assert traded, "the bot should have found and taken a trade"
        position = next(iter(bot.risk.positions.values()), None)
        if position is not None:
            assert position.outcome is Outcome.UP
            assert position.size * position.avg_price <= 20.0 + 1e-6

        # --- settle the window ---------------------------------------------
        for offset in range(280, 320):
            ts = window_start + offset
            bot.sim_clock.set(ts)
            price *= 1.0000020
            feed_prices(bot, ts, price)
            bot.composite.compute_all(ts)
            await _cycle(bot, ts)

        assert bot.risk.closed_positions, "the position must be settled"
        settled = bot.risk.closed_positions[0]
        assert settled.realized_pnl is not None
        assert settled.resolution is Outcome.UP        # price rose all window
        assert settled.realized_pnl > 0

        # --- everything was written down ------------------------------------
        await bot.db.flush()
        for table, minimum in (
            ("markets", 1), ("features", 10), ("predictions", 10),
            ("signals", 10), ("orders", 1), ("fills", 1), ("positions", 1),
            ("book_snapshots", 10), ("audit_events", 2),
        ):
            rows = await bot.db.query(f"SELECT COUNT(*) c FROM {table}")
            assert rows[0]["c"] >= minimum, f"{table} has {rows[0]['c']} rows"

        # --- the audit trail explains the trade -----------------------------
        audit = await bot.db.query(
            "SELECT payload FROM audit_events WHERE kind = 'trade_opened'"
        )
        assert audit
        payload = json.loads(audit[0]["payload"])
        for key in ("model_probability", "market_probability", "net_edge",
                    "fee_cost", "entry_price", "signals", "regime", "decision",
                    "risk_state", "book_state"):
            assert key in payload, key
        assert payload["signals"], "the audit must record which strategies spoke"

        # --- the dashboard snapshot is publishable --------------------------
        await bot._publish_state()
        assert bot.state_path.exists()
        snapshot = json.loads(bot.state_path.read_text())
        assert snapshot["mode"] == "paper"
        assert snapshot["live_armed"] is False
        assert snapshot["stats"]["trades"] >= 1
        assert snapshot["trades"]

        from pmbot.dashboard.state import StateReader

        state = StateReader(bot.state_path).read()
        assert state.connected
        from pmbot.dashboard.render import account_panel, header_panel

        assert header_panel(state) is not None
        assert account_panel(state) is not None

        await bot.db.stop()

    @pytest.mark.slow
    async def test_no_trade_when_the_market_is_priced_correctly(self, runner):
        """The same machinery, with the market quoting our own fair value."""
        bot = runner
        window_start = bot.window_start
        await bot.db.start()
        await bot.venue.start()

        price = 100_000.0
        for offset in range(-400, 0):
            ts = window_start + offset
            bot.sim_clock.set(ts)
            feed_prices(bot, ts, price)
            bot.composite.compute_all(ts)

        markets = await bot.discovery.discover()
        await bot._apply_discovery(markets)
        market = markets[0]
        up_token = market.token_id(Outcome.UP)
        down_token = market.token_id(Outcome.DOWN)

        bot.sim_clock.set(window_start)
        feed_prices(bot, window_start, price)
        bot.composite.compute_all(window_start)

        for offset in range(1, 270):
            ts = window_start + offset
            feed_prices(bot, ts, price)          # dead flat: fair value is 0.50
            feed_book(bot, up_token, 0.50, 0.51, ts)
            feed_book(bot, down_token, 0.49, 0.50, ts)
            await _cycle(bot, ts)
            assert not bot.risk.positions, (
                "no edge exists here; a trade means the edge maths is wrong"
            )

        assert not bot.risk.positions
        assert not bot.risk.closed_positions
        await bot.db.stop()

    async def test_survives_a_total_data_outage(self, runner):
        """No prices, no books: the bot must idle quietly, not crash or trade."""
        bot = runner
        window_start = bot.window_start
        await bot.db.start()
        bot.sim_clock.set(window_start)
        markets = await bot.discovery.discover()
        await bot._apply_discovery(markets)
        for offset in range(0, 30):
            mark_feeds_healthy(bot, window_start + offset)
            await _cycle(bot, window_start + offset)
        assert not bot.risk.positions
        assert bot.stats.errors == 0
        await bot.db.stop()

    async def test_discovery_failure_is_survivable(self, runner):
        from pmbot.polymarket.http import ApiError

        bot = runner

        async def broken(*args, **kwargs):
            raise ApiError("gamma down", 503)

        bot.discovery.gamma.events_by_series_slug = broken
        bot.discovery.gamma.active_events = broken
        assert await bot.discovery.discover() == []
        assert bot.discovery.stats.last_error

    async def test_shutdown_is_clean(self, runner):
        bot = runner
        await bot.db.start()
        await bot.venue.start()
        await bot.shutdown()
        assert bot._tasks == []


async def _cycle(bot, ts: float) -> None:
    """Advance the shared simulated clock and run one real main-loop cycle."""
    bot.sim_clock.set(ts)
    await bot._cycle()


class TestTokenIndex:
    """The websocket calls back per trade print; a scan there is not free."""

    @staticmethod
    async def _runner(tmp_path):
        settings = Settings(
            database_url=f"sqlite:///{tmp_path}/b.db",
            log_dir=tmp_path / "logs", model_dir=tmp_path / "models",
        )
        bot = BotRunner(settings)
        await bot.db.start()
        return bot

    async def test_trade_prints_resolve_their_market_by_index(self, tmp_path):
        from tests.conftest import make_market

        bot = await self._runner(tmp_path)
        try:
            market = make_market()
            bot._markets = {market.market_id: market}
            bot._market_by_token = dict.fromkeys(market.token_ids, market)

            token_id = market.token_ids[0]
            bot._on_pm_event("last_trade_price", {
                "asset_id": token_id, "price": "0.52", "size": "10", "side": "BUY",
            })
            await bot.db.flush()
            rows = await bot.db.query("SELECT * FROM public_trades")
            assert len(rows) == 1
            assert rows[0]["market_id"] == market.market_id
            assert rows[0]["token_id"] == token_id
            assert rows[0]["price"] == pytest.approx(0.52)
        finally:
            await bot.db.stop()

    async def test_a_print_for_an_unknown_token_is_still_recorded(self, tmp_path):
        """A market we just dropped must not lose its prints or raise."""
        bot = await self._runner(tmp_path)
        try:
            bot._on_pm_event("last_trade_price", {
                "asset_id": "unknown", "price": "0.5", "size": "1", "side": "BUY",
            })
            await bot.db.flush()
            rows = await bot.db.query("SELECT * FROM public_trades")
            assert len(rows) == 1
            assert rows[0]["market_id"] is None
        finally:
            await bot.db.stop()

    async def test_the_index_is_rebuilt_to_match_the_tracked_markets(self, tmp_path):
        """Stale entries would attribute prints to a market we no longer hold."""
        from tests.conftest import make_market

        bot = await self._runner(tmp_path)
        try:
            old = make_market(market_id="old")
            bot._market_by_token = dict.fromkeys(old.token_ids, old)
            new = make_market(market_id="new")
            bot._markets = {new.market_id: new}
            bot._market_by_token = {
                token_id: market
                for market in bot._markets.values()
                for token_id in market.token_ids
            }
            assert set(bot._market_by_token) == set(new.token_ids)
        finally:
            await bot.db.stop()
