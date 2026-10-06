"""The bot: wires every component into one running system.

Loop structure (all of it asynchronous, nothing blocking):

* **Discovery loop** -- refreshes the tracked market set and reconciles the
  websocket subscription.
* **Main loop** -- per cycle: refresh composite prices, evaluate health, build a
  prediction for every tracked market, score both outcomes through the trade
  gate, rank globally, execute the best, advance working orders, settle closed
  windows.
* **Persistence loop** -- flushes batched writes and publishes the state
  snapshot the dashboard reads.

Two invariants hold throughout:

* Nothing in the loop may raise into the event loop.  A failure in one market's
  evaluation must not stop the other markets from being traded, so every stage
  is individually guarded, counted and logged.
* The **same** code path runs in paper and live mode.  The only difference is
  which :class:`~pmbot.execution.base.ExecutionVenue` is plugged in.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .alerts.manager import AlertManager
from .config import Settings, TradingMode, get_settings
from .core.clock import Clock, default_clock
from .core.health import HealthMonitor
from .core.types import (
    Decision,
    Market,
    Opportunity,
    Outcome,
    Prediction,
)
from .database.repo import Repository
from .database.store import Database
from .exchanges.composite import CompositePriceEngine
from .exchanges.venues import build_feeds
from .execution.base import ExecutionVenue
from .execution.executor import Executor
from .execution.gate import GateConfig, TradeGate, rank_opportunities
from .execution.paper import PaperVenue
from .features.engine import FEATURE_NAMES, FeatureEngine
from .logging_setup import (
    get_logger,
    install_loop_exception_handler,
    setup_logging,
)
from .ml.registry import load_model
from .orderbook.book import OrderBookManager
from .polymarket.clob_rest import ClobRestClient
from .polymarket.clob_ws import PolymarketMarketFeed
from .polymarket.discovery import MarketDiscovery
from .polymarket.fees import FeeSchedule
from .polymarket.gamma import GammaClient
from .probability.analytic import basis_sigma_from_bps
from .probability.calibration import Calibrator
from .probability.engine import PredictionEngine
from .resolution import ResolutionTracker
from .risk.engine import RiskEngine, RiskLimits
from .strategies.base import StrategyConfig
from .strategies.ensemble import MetaModel, StrategyPerformanceTracker
from .strategies.ml_strategy import MLStrategy
from .strategies.regime import RegimeDetector
from .strategies.signals import build_strategies


def _regime_from_name(name: str):
    """Map a stored regime name back onto the enum, defaulting safely."""
    from .core.types import Regime

    try:
        return Regime(name)
    except ValueError:
        return Regime.RANGING


@dataclass
class LoopStats:
    cycles: int = 0
    evaluations: int = 0
    opportunities: int = 0
    trades_attempted: int = 0
    trades_filled: int = 0
    errors: int = 0
    last_cycle_ms: float = 0.0
    avg_cycle_ms: float = 0.0
    started_at: float = field(default_factory=time.time)

    @property
    def uptime(self) -> float:
        return time.time() - self.started_at


class BotRunner:
    def __init__(self, settings: Settings | None = None, clock: Clock | None = None):
        self.settings = settings or get_settings()
        self.clock = clock or default_clock()
        self.log = get_logger("pmbot.runner")
        self.stats = LoopStats()

        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._markets: dict[str, Market] = {}
        #: token id -> market, rebuilt on each discovery cycle. Read on
        #: the websocket hot path, so it must not be a scan.
        self._market_by_token: dict[str, Market] = {}
        self._last_snapshot: dict[str, float] = {}
        self._last_pnl_snapshot = 0.0
        self._settled: set[str] = set()
        self._prediction_cache: dict[str, Prediction] = {}
        self._opportunity_cache: list[Opportunity] = []
        self._signals_at_entry: dict[str, list] = {}
        self._build()

    # ---------------------------------------------------------------- wiring
    def _build(self) -> None:
        settings = self.settings

        self.db = Database(
            settings.database_url,
            flush_interval=settings.db_flush_interval_seconds,
            batch_size=settings.db_batch_size,
        )
        self.repo = Repository(self.db)
        self.alerts = AlertManager(
            telegram_enabled=settings.telegram_enabled,
            telegram_token=(
                settings.telegram_bot_token.get_secret_value()
                if settings.telegram_bot_token else None
            ),
            telegram_chat_id=settings.telegram_chat_id,
        )

        self.gamma = GammaClient(settings.gamma_base_url)
        self.clob = ClobRestClient(settings.clob_base_url)
        self.discovery = MarketDiscovery(
            gamma=self.gamma,
            assets=settings.assets,
            series_slug_templates=settings.series_slug_templates,
            window_seconds=settings.market_window_seconds,
            lookahead_seconds=settings.discovery_lookahead_seconds,
            max_markets=settings.max_tracked_markets,
            clock=self.clock,
            default_taker_fee=settings.default_taker_fee_rate,
        )

        self.composite = CompositePriceEngine(
            assets=settings.assets,
            stale_seconds=settings.feed_stale_seconds,
            min_sources=settings.min_healthy_exchanges,
            divergence_bps=settings.feed_divergence_bps,
            window_seconds=settings.market_window_seconds,
            clock=self.clock,
        )
        self.feeds = build_feeds(
            settings.exchanges,
            settings.assets,
            on_tick=self.composite.on_tick,
            clock=self.clock,
            stale_after=settings.feed_stale_seconds,
            reconnect_base=settings.ws_reconnect_base_delay,
            reconnect_max=settings.ws_reconnect_max_delay,
        )

        self.books = OrderBookManager(stale_seconds=settings.stale_book_seconds)
        self.pm_feed = PolymarketMarketFeed(
            self.books,
            url=settings.clob_ws_market_url,
            ping_interval=settings.ws_ping_interval,
            stale_after=settings.stale_book_seconds,
            reconnect_base=settings.ws_reconnect_base_delay,
            reconnect_max=settings.ws_reconnect_max_delay,
            on_event=self._on_pm_event,
        )

        sigma_basis = (
            basis_sigma_from_bps(settings.oracle_basis_bps)
            if settings.resolution_oracle == "composite" else 0.0
        )
        self.features = FeatureEngine(
            composite=self.composite,
            books=self.books,
            stale_book_seconds=settings.stale_book_seconds,
            sigma_basis=sigma_basis,
            probability_floor=settings.probability_floor,
            probability_cap=settings.probability_cap,
        )

        strategy_names = [n for n in settings.enabled_strategies if n != "ml"]
        self.strategies = build_strategies(
            strategy_names, {n: StrategyConfig() for n in strategy_names}
        )
        self.tracker = StrategyPerformanceTracker(
            halflife=settings.strategy_weight_halflife,
            min_weight=settings.min_strategy_weight,
            max_weight=settings.max_strategy_weight,
        )
        self.tracker.load(settings.model_dir / "strategy_performance.json")
        self.meta = MetaModel(tracker=self.tracker, adaptive=settings.adaptive_weights)

        loaded_model = None
        if settings.ml_enabled:
            loaded_model = load_model(settings.model_dir / settings.model_name, FEATURE_NAMES)
        self.ml_strategy = (
            MLStrategy(loaded_model) if "ml" in settings.enabled_strategies else None
        )

        calibrator = Calibrator.load(
            settings.model_dir / settings.model_name / "calibrator.json"
        )
        self.engine = PredictionEngine(
            features=self.features,
            strategies=self.strategies,
            meta=self.meta,
            regime_detector=RegimeDetector(),
            calibrator=calibrator,
            ml_strategy=self.ml_strategy,
            ml_blend_weight=settings.ml_blend_weight if loaded_model else 0.0,
            probability_floor=settings.probability_floor,
            probability_cap=settings.probability_cap,
            market_anchor_weight=settings.market_anchor_weight,
            adaptive_anchor=settings.adaptive_anchor,
            anchor_weight_uncertainty=settings.anchor_weight_uncertainty,
        )

        self.risk = RiskEngine(
            limits=RiskLimits(
                max_stake_per_trade=settings.max_stake_per_trade,
                max_stake_fraction=settings.max_stake_fraction,
                max_portfolio_exposure=settings.max_portfolio_exposure,
                max_simultaneous_positions=settings.max_simultaneous_positions,
                max_positions_per_asset=settings.max_positions_per_asset,
                max_positions_per_market=settings.max_positions_per_market,
                max_asset_exposure=settings.max_asset_exposure,
                max_correlated_exposure=settings.max_correlated_exposure,
                max_daily_loss=settings.max_daily_loss,
                max_session_loss=settings.max_session_loss,
                max_consecutive_losses=settings.max_consecutive_losses,
                max_drawdown=settings.max_drawdown,
                pause_seconds=settings.risk_pause_seconds,
                min_order_notional=settings.min_order_notional,
            ),
            starting_bankroll=settings.bankroll,
            clock=self.clock,
        )

        self.gate = TradeGate(
            config=GateConfig(
                min_edge=settings.min_edge,
                min_confidence=settings.min_confidence,
                min_model_agreement=settings.min_model_agreement,
                edge_uncertainty_multiple=settings.edge_uncertainty_multiple,
                max_spread=settings.max_spread,
                min_liquidity_usd=settings.min_liquidity_usd,
                min_top_of_book_shares=settings.min_top_of_book_shares,
                max_slippage=settings.max_slippage,
                min_seconds_remaining=settings.min_seconds_remaining,
                max_seconds_remaining=settings.max_seconds_remaining,
                stale_book_seconds=settings.stale_book_seconds,
                max_plausible_edge=settings.max_plausible_edge,
            ),
            risk=self.risk,
            sizing_method=settings.sizing_method,
            kelly_fraction=settings.kelly_fraction,
        )

        self.venue: ExecutionVenue = self._build_venue()
        self.executor = Executor(
            venue=self.venue,
            books=self.books,
            clock=self.clock,
            style=settings.execution_style,
            maker_wait_seconds=settings.maker_wait_seconds,
            min_seconds_remaining=settings.min_seconds_remaining,
            max_retries=settings.max_order_retries,
            risk=self.risk,
        )

        self.health = HealthMonitor(min_healthy_exchanges=settings.min_healthy_exchanges)
        self.resolutions = ResolutionTracker()
        self.state_path = Path(settings.log_dir).parent / "data" / "state.json"

    def _build_venue(self) -> ExecutionVenue:
        settings = self.settings
        if settings.trading_mode is TradingMode.LIVE:
            from .execution.live import LiveVenue

            creds = None
            address = None
            if settings.polymarket_api_key and settings.polymarket_api_secret \
                    and settings.polymarket_api_passphrase:
                from .polymarket.auth import ApiCreds

                creds = ApiCreds(
                    settings.polymarket_api_key.get_secret_value(),
                    settings.polymarket_api_secret.get_secret_value(),
                    settings.polymarket_api_passphrase.get_secret_value(),
                )
                address = settings.polymarket_funder
            authed = ClobRestClient(settings.clob_base_url, creds=creds, address=address)
            self.clob_authed = authed
            self.log.warning("building LIVE execution venue")
            return LiveVenue(settings, authed, clock=self.clock)

        return PaperVenue(
            self.books,
            clock=self.clock,
            latency_ms=settings.paper_latency_ms,
            maker_fill_ratio=settings.paper_maker_fill_ratio,
            queue_model=settings.paper_queue_model,
            order_timeout=settings.order_timeout_seconds,
            seed=settings.random_seed,
        )

    # -------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        settings = self.settings
        setup_logging(settings.log_level, settings.log_dir, settings.log_json)
        # Exceptions raised in a loop callback bypass every try/except here.
        install_loop_exception_handler()
        self.log.info(
            "starting bot",
            extra={
                "mode": settings.trading_mode.value,
                "live_armed": settings.is_live,
                "assets": settings.assets,
                "exchanges": [f.name for f in self.feeds],
                "strategies": [s.name for s in self.strategies]
                + (["ml"] if self.ml_strategy else []),
                "bankroll": settings.bankroll,
            },
        )
        if settings.is_live:
            self.log.warning(
                "LIVE TRADING IS ARMED - real orders will be placed",
                extra={"dry_run": settings.dry_run_live},
            )
            await self.alerts.send(
                "critical", "runner",
                f"LIVE trading armed (dry_run={settings.dry_run_live})",
            )

        await self.db.start()
        await self.venue.start()
        for feed in self.feeds:
            await feed.start()
        await self.pm_feed.start()

        self._stop.clear()
        self._tasks = [
            asyncio.create_task(self._discovery_loop(), name="discovery"),
            asyncio.create_task(self._main_loop(), name="main"),
            asyncio.create_task(self._persistence_loop(), name="persistence"),
        ]

    async def run(self) -> None:
        await self.start()
        try:
            await self._stop.wait()
        finally:
            await self.shutdown()

    async def shutdown(self) -> None:
        self.log.info("shutting down")
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

        with contextlib.suppress(Exception):
            await self.executor.cancel_all()
        with contextlib.suppress(Exception):
            await self.venue.stop()
        for feed in self.feeds:
            with contextlib.suppress(Exception):
                await feed.stop()
        with contextlib.suppress(Exception):
            await self.pm_feed.stop()
        with contextlib.suppress(Exception):
            self.tracker.save(self.settings.model_dir / "strategy_performance.json")
        with contextlib.suppress(Exception):
            await self.gamma.close()
        with contextlib.suppress(Exception):
            await self.clob.close()
        with contextlib.suppress(Exception):
            await self.db.stop()
        self.log.info("shutdown complete", extra={"cycles": self.stats.cycles})

    def request_stop(self) -> None:
        self._stop.set()

    # --------------------------------------------------------------- loops
    async def _discovery_loop(self) -> None:
        while not self._stop.is_set():
            try:
                markets = await self.discovery.discover()
                await self._apply_discovery(markets)
            except Exception as exc:  # noqa: BLE001
                self.stats.errors += 1
                self._record_error("discovery", exc)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(), timeout=self.settings.discovery_interval_seconds
                )

    async def _apply_discovery(self, markets: list[Market]) -> None:
        new_ids = {m.market_id for m in markets}
        for market in markets:
            if market.market_id not in self._markets:
                self._persist_market(market)
                if isinstance(self.venue, PaperVenue):
                    schedule = FeeSchedule(
                        taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
                    )
                    for token_id in market.token_ids:
                        self.venue.set_fee_schedule(token_id, schedule)
            self._markets[market.market_id] = market

        # Keep markets that are closed but still hold a position or await
        # resolution, so settlement is never lost to a discovery refresh.
        keep: dict[str, Market] = {}
        for market_id, market in self._markets.items():
            if market_id in new_ids or market_id not in self._settled and (
                self.risk.positions_for_market(market_id)
                or market.window_end > self.clock.time() - 900
            ):
                keep[market_id] = market
        self._markets = keep

        tokens = {t for m in self._markets.values() for t in m.token_ids}
        self._market_by_token = {
            token_id: market
            for market in self._markets.values()
            for token_id in market.token_ids
        }
        await self.pm_feed.set_tokens(tokens)
        self.books.prune(tokens)
        self.features.prune(set(self._markets))

    async def _main_loop(self) -> None:
        interval = 1.0 / max(self.settings.dashboard_refresh_hz * 2, 1.0)
        interval = max(min(interval, 1.0), 0.2)
        while not self._stop.is_set():
            started = time.perf_counter()
            try:
                await self._cycle()
            except Exception as exc:  # noqa: BLE001
                self.stats.errors += 1
                self._record_error("main_loop", exc)
            elapsed = (time.perf_counter() - started) * 1000.0
            self.stats.last_cycle_ms = elapsed
            self.stats.avg_cycle_ms = (
                0.9 * self.stats.avg_cycle_ms + 0.1 * elapsed
                if self.stats.avg_cycle_ms else elapsed
            )
            self.stats.cycles += 1
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(), timeout=max(interval - elapsed / 1000.0, 0.01)
                )

    async def _cycle(self) -> None:
        now = self.clock.time()

        # 1. reference prices and feed health
        for feed in self.feeds:
            health = feed.update_health(now)
            self.composite.set_health(feed.name, health.score)
        composites = self.composite.compute_all(now)
        self.pm_feed.update_health(now)

        # 2. system health -> size scaling and pausing
        system = self.health.evaluate(
            feeds=[f.health for f in self.feeds],
            polymarket=self.pm_feed.health,
            composite_healthy={a: c.is_healthy for a, c in composites.items()},
            now=now,
            db_errors=self.db.stats.errors,
        )
        self.system_health = system
        if system.should_pause and not self.risk.is_paused(now):
            # Unlatched: the cause is a feed we are watching, so it is lifted
            # the moment the feeds come back rather than after a fixed
            # cooldown. Flapping feeds would otherwise keep the bot off
            # almost permanently while every panel reads healthy.
            self.risk.pause(
                f"system health: {'; '.join(system.issues[:2])}", latch=False
            )
            await self.alerts.send("critical", "health", "; ".join(system.issues[:3]))
        elif not system.should_pause and self.risk.clear_transient_pause(
            "system health recovered"
        ):
            await self.alerts.send("info", "health", "trading resumed: health recovered")

        # 3. mark open positions
        marks: dict[str, float] = {}
        for position in self.risk.positions.values():
            book = self.books.snapshot(position.token_id, now)
            if book is not None and book.mid is not None:
                marks[position.token_id] = book.mid
        self.risk.set_marks(marks)

        # 4. evaluate every tracked market
        candidates: list[Opportunity] = []
        for market in sorted(self._markets.values(), key=lambda m: m.window_end):
            if market.window_end <= now:
                continue
            try:
                opportunities = self._evaluate_market(market, now, system.size_multiplier)
            except Exception as exc:  # noqa: BLE001
                self.stats.errors += 1
                self._record_error(f"evaluate:{market.market_id}", exc)
                continue
            candidates.extend(opportunities)

        self.stats.evaluations += len(self._markets)
        ranked = rank_opportunities(candidates)
        self._opportunity_cache = ranked[:40]
        self.stats.opportunities += sum(1 for o in ranked if o.is_tradable)

        # 5. execute, best first, re-checking risk before each order
        for opportunity in ranked:
            if not opportunity.is_tradable:
                break
            if self.risk.is_paused(now):
                break
            check = self.risk.check_trade(
                opportunity.market, opportunity.outcome, opportunity.notional
            )
            if not check:
                continue
            await self._take(opportunity, now)

        # 6. advance working maker orders
        try:
            finished = await self.executor.step(revalidate=self._revalidate, now=now)
            for outcome in finished:
                if outcome.is_filled:
                    self._register_fill(outcome, now)
        except Exception as exc:  # noqa: BLE001
            self.stats.errors += 1
            self._record_error("executor", exc)

        # 7. settle windows that have closed
        await self._settle_closed(now)

    def _evaluate_market(
        self, market: Market, now: float, size_multiplier: float
    ) -> list[Opportunity]:
        result = self.engine.predict(market, now)
        if result is None:
            return []
        prediction = result.prediction
        self._prediction_cache[market.market_id] = prediction

        self._maybe_snapshot(market, result, now)

        opportunities = self.gate.evaluate(
            market=market,
            prediction=prediction,
            market_probability=result.feature_set.context.market_probability,
            up_book=result.feature_set.context.up_book,
            down_book=result.feature_set.context.down_book,
            now=now,
            fee_schedule=FeeSchedule(
                taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
            ),
        )
        if size_multiplier < 1.0:
            for opportunity in opportunities:
                opportunity.size_shares *= size_multiplier
                opportunity.notional *= size_multiplier
                opportunity.expected_value *= size_multiplier
                if opportunity.size_shares < market.min_order_size:
                    opportunity.blockers.append("size reduced below minimum by health")
                    opportunity.decision = Decision.WATCH

        for opportunity in opportunities:
            self._persist_opportunity(opportunity, now)
        return opportunities

    async def _take(self, opportunity: Opportunity, now: float) -> None:
        self.stats.trades_attempted += 1
        self._signals_at_entry[opportunity.opportunity_id] = list(
            opportunity.prediction.signals
        )
        try:
            outcome = await self.executor.execute(opportunity)
        except Exception as exc:  # noqa: BLE001
            self.stats.errors += 1
            self.health.record_execution_failure(now)
            self._record_error("execute", exc)
            return
        if outcome.result is not None:
            self._persist_order(outcome, now)
        if outcome.is_filled:
            self._register_fill(outcome, now)
        elif outcome.note and "resting" not in outcome.note:
            self.health.record_execution_failure(now)

    def _register_fill(self, outcome, now: float) -> None:
        opportunity = outcome.opportunity
        result = outcome.result
        if result is None or not result.fills:
            return
        position = self.risk.open_position(
            market=opportunity.market,
            outcome=opportunity.outcome,
            fills=result.fills,
            opportunity_id=opportunity.opportunity_id,
            strategy=self._dominant_strategy(opportunity),
            regime=opportunity.regime.value,
            execution_style=outcome.style,
            entry_edge=opportunity.net_edge,
            entry_confidence=opportunity.confidence,
            entry_model_prob=opportunity.model_probability,
            entry_market_prob=opportunity.market_probability.implied_up
            if opportunity.outcome is Outcome.UP
            else opportunity.market_probability.implied_down,
        )
        if position is None:
            return
        self.stats.trades_filled += 1
        self._persist_position(position)
        for fill in result.fills:
            self.db.enqueue("fills", {
                "fill_id": fill.fill_id, "ts": fill.timestamp,
                "order_id": fill.order_id, "client_id": fill.client_id,
                "market_id": opportunity.market.market_id, "token_id": fill.token_id,
                "side": fill.side.value, "price": fill.price, "size": fill.size,
                "fee": fill.fee, "is_maker": int(fill.is_maker),
            })
        self.db.enqueue("audit_events", {
            "ts": now, "kind": "trade_opened",
            "market_id": opportunity.market.market_id,
            "payload": self._audit_payload(opportunity, outcome, position),
        })

    @staticmethod
    def _dominant_strategy(opportunity: Opportunity) -> str:
        active = [s for s in opportunity.prediction.signals if not s.abstain]
        if not active:
            return "ensemble"
        aligned = [
            s for s in active
            if (s.probability_up > 0.5) == (opportunity.outcome is Outcome.UP)
        ]
        pool = aligned or active
        return max(pool, key=lambda s: s.confidence * s.strength).strategy

    def _revalidate(self, opportunity: Opportunity) -> float | None:
        """Current net taker edge for a resting order, or ``None`` if invalid."""
        market = self._markets.get(opportunity.market.market_id)
        if market is None:
            return None
        prediction = self._prediction_cache.get(market.market_id)
        if prediction is None:
            return None
        book = self.books.snapshot(market.token_id(opportunity.outcome), self.clock.time())
        if book is None or book.best_ask is None:
            return None
        schedule = FeeSchedule(
            taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
        )
        model_probability = prediction.probability(opportunity.outcome)
        return (
            model_probability - book.best_ask - schedule.per_share(book.best_ask)
        )

    # ------------------------------------------------------------- settlement
    async def _settle_closed(self, now: float) -> None:
        grace = 2.0
        for market_id, market in list(self._markets.items()):
            if market.window_end > now - grace or market_id in self._settled:
                continue

            resolution = self.resolutions.get(market_id)
            if resolution is None or not resolution.is_authoritative:
                winner = self.pm_feed.resolved.get(market.condition_id)
                if winner:
                    resolution = self.resolutions.from_websocket(market, winner, now) or resolution
            if resolution is None:
                strike = self.composite.strike_for(market.asset, market.window_start, now)
                settle = self._settle_price(market, now)
                if strike.is_usable and settle:
                    resolution = self.resolutions.from_proxy(
                        market, strike.price, settle, now
                    )
            if resolution is None:
                if market.window_end < now - 600:
                    # Give up after ten minutes: no source ever produced an
                    # outcome, so close the position at the last mark instead of
                    # leaving it open forever.
                    await self._force_close(market, now)
                continue

            self._settled.add(market_id)
            for position in self.risk.positions_for_market(market_id):
                settled = self.risk.settle_position(position.position_id, resolution.outcome, now)
                if settled is None:
                    continue
                self._persist_position(settled)
                self.db.enqueue("audit_events", {
                    "ts": now, "kind": "trade_settled", "market_id": market_id,
                    "payload": {
                        "position_id": settled.position_id,
                        "outcome": settled.outcome.value,
                        "resolution": resolution.outcome.value,
                        "resolution_source": resolution.source.value,
                        "realized_pnl": settled.realized_pnl,
                        "entry_edge": settled.entry_edge,
                        "entry_model_prob": settled.entry_model_prob,
                        "entry_market_prob": settled.entry_market_prob,
                        "strategy": settled.strategy, "regime": settled.regime,
                    },
                })
                if settled.realized_pnl is not None and settled.realized_pnl < 0:
                    await self.alerts.maybe_warn_losses(
                        self.risk.consecutive_losses, self.risk.limits.max_consecutive_losses
                    )

            resolved_up = resolution.outcome is Outcome.UP
            prediction = self._prediction_cache.get(market_id)
            if prediction is not None:
                self.health.record_prediction_outcome(prediction.probability_up, resolved_up)
                self.engine.record_outcome(
                    prediction.signals, prediction.regime, resolved_up,
                    model_probability=(
                        prediction.unanchored_probability_up
                        if prediction.unanchored_probability_up is not None
                        else prediction.probability_up
                    ),
                    market_probability=prediction.features.get("implied_up"),
                )
            # Attribute the outcome to the signals that were live when each
            # position was actually opened, not to the latest prediction: a
            # position taken 90 seconds ago was justified by a different view.
            for position in self.risk.closed_positions:
                if position.market_id != market_id or not position.opportunity_id:
                    continue
                entry_signals = self._signals_at_entry.pop(position.opportunity_id, None)
                if entry_signals:
                    self.engine.record_outcome(
                        entry_signals,
                        _regime_from_name(position.regime),
                        resolved_up,
                    )

            self.db.enqueue("markets", self._market_row(
                market,
                resolved_outcome=resolution.outcome.value,
                resolved_at=now,
                strike_price=resolution.strike,
                settle_price=resolution.settle,
            ))
            self.log.info(
                "market resolved",
                extra={
                    "market": market_id, "asset": market.asset,
                    "outcome": resolution.outcome.value,
                    "source": resolution.source.value,
                    "provisional": resolution.provisional,
                },
            )

        stale = [
            market_id for market_id, market in self._markets.items()
            if market.window_end < now - 1800
        ]
        for market_id in stale:
            self._markets.pop(market_id, None)
            self._prediction_cache.pop(market_id, None)
            self._settled.discard(market_id)
        self.resolutions.forget(stale)

    def _settle_price(self, market: Market, now: float) -> float | None:
        """Composite price at (or just after) the window close."""
        history = self.composite.history(market.asset, now - market.window_end + 60.0, now)
        best: float | None = None
        for ts, price in history:
            if ts <= market.window_end + 1.0:
                best = price
            else:
                break
        return best or self.composite.price(market.asset)

    async def _force_close(self, market: Market, now: float) -> None:
        for position in self.risk.positions_for_market(market.market_id):
            book = self.books.snapshot(position.token_id, now)
            price = book.mid if book is not None and book.mid is not None else position.avg_price
            closed = self.risk.close_position_at_price(position.position_id, price, 0.0, now)
            if closed is not None:
                self._persist_position(closed)
                self.log.warning(
                    "position force-closed: no resolution source responded",
                    extra={"market": market.market_id, "price": price},
                )
        self._settled.add(market.market_id)

    # ------------------------------------------------------------ persistence
    async def _persistence_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._publish_state()
                now = self.clock.time()
                if now - self._last_pnl_snapshot >= 10.0:
                    self._last_pnl_snapshot = now
                    self._persist_pnl(now)
                    self._persist_feed_health(now)
                    self._persist_strategy_performance(now)
                self._drain_risk_events()
            except Exception as exc:  # noqa: BLE001
                self.stats.errors += 1
                self._record_error("persistence", exc)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=1.0)

    def _drain_risk_events(self) -> None:
        """Persist risk events once each; the engine keeps a bounded deque."""
        while self.risk.events:
            event = self.risk.events.popleft()
            self.db.enqueue("risk_events", {
                "ts": event.timestamp, "kind": event.kind,
                "severity": event.severity, "message": event.message[:500],
                "detail": event.detail,
            })

    def _maybe_snapshot(self, market: Market, result, now: float) -> None:
        if not self.settings.record_training_data:
            return
        last = self._last_snapshot.get(market.market_id, 0.0)
        if now - last < self.settings.snapshot_interval_seconds:
            return
        self._last_snapshot[market.market_id] = now

        fs = result.feature_set
        prediction = result.prediction
        self.db.enqueue("features", {
            "ts": now, "market_id": market.market_id, "asset": market.asset,
            "window_start": market.window_start, "window_end": market.window_end,
            "spot": fs.context.spot, "strike": fs.context.strike,
            "data_quality": fs.context.data_quality, "payload": fs.features,
        })
        self.db.enqueue("predictions", {
            "ts": now, "market_id": market.market_id, "asset": market.asset,
            "probability_up": prediction.probability_up,
            "confidence": prediction.confidence,
            "uncertainty": prediction.uncertainty,
            "regime": prediction.regime.value,
            "analytic_up": prediction.analytic_probability_up,
            "ml_up": prediction.ml_probability_up,
            "implied_up": fs.features.get("implied_up"),
            "calibrated": int(prediction.calibrated),
            "model_version": prediction.model_version,
            "decision": None,
        })
        for signal in prediction.signals:
            self.db.enqueue("signals", {
                "ts": now, "market_id": market.market_id, "strategy": signal.strategy,
                "probability_up": signal.probability_up, "confidence": signal.confidence,
                "abstain": int(signal.abstain), "reason": signal.reason[:200],
            })
        for label, book in (("UP", fs.context.up_book), ("DOWN", fs.context.down_book)):
            if book is None:
                continue
            self.db.enqueue("book_snapshots", {
                "ts": now, "market_id": market.market_id, "token_id": book.token_id,
                "outcome": label, "best_bid": book.best_bid, "best_ask": book.best_ask,
                "bid_size": book.best_bid_size, "ask_size": book.best_ask_size,
                "mid": book.mid, "spread": book.spread, "microprice": book.microprice,
                "imbalance": book.imbalance(0.05),
                "depth_bid": book.depth("bid", 0.05), "depth_ask": book.depth("ask", 0.05),
                "liquidity": book.notional_depth("bid", 0.05)
                + book.notional_depth("ask", 0.05),
                "levels": len(book.bids) + len(book.asks),
                "book_age": now - book.timestamp if book.timestamp else None,
            })

    def _market_row(self, market: Market, **extra: Any) -> dict[str, Any]:
        row = {
            "market_id": market.market_id, "condition_id": market.condition_id,
            "question_id": market.question_id, "slug": market.slug,
            "asset": market.asset, "title": market.title,
            "series_slug": market.series_slug,
            "window_start": market.window_start, "window_end": market.window_end,
            "up_token_id": market.token_id(Outcome.UP),
            "down_token_id": market.token_id(Outcome.DOWN),
            "tick_size": market.tick_size, "min_order_size": market.min_order_size,
            "neg_risk": int(market.neg_risk), "taker_fee_rate": market.taker_fee_rate,
            "maker_fee_rate": market.maker_fee_rate, "fee_type": market.fee_type,
            "resolution_source": market.resolution_source,
            "discovered_at": market.discovered_at,
        }
        row.update(extra)
        return row

    def _persist_market(self, market: Market) -> None:
        self.db.enqueue("markets", self._market_row(market))

    def _persist_opportunity(self, opportunity: Opportunity, now: float) -> None:
        # Only record decisions worth reviewing: every rejected tick would be
        # millions of rows a day and would drown the interesting ones.
        if (
            opportunity.decision is Decision.NO_TRADE
            and not opportunity.is_tradable
            and opportunity.net_edge <= 0
        ):
            return
        self.db.enqueue("opportunities", {
            "opportunity_id": opportunity.opportunity_id, "ts": now,
            "market_id": opportunity.market.market_id, "asset": opportunity.market.asset,
            "outcome": opportunity.outcome.value, "decision": opportunity.decision.value,
            "entry_price": opportunity.entry_price,
            "model_probability": opportunity.model_probability,
            "market_probability": opportunity.market_probability.implied_up
            if opportunity.outcome is Outcome.UP
            else opportunity.market_probability.implied_down,
            "gross_edge": opportunity.gross_edge, "fee_cost": opportunity.fee_cost,
            "slippage_cost": opportunity.slippage_cost, "net_edge": opportunity.net_edge,
            "required_edge": self.gate.required_edge(
                opportunity.prediction, opportunity.prediction.features
            ),
            "size_shares": opportunity.size_shares, "notional": opportunity.notional,
            "expected_value": opportunity.expected_value, "score": opportunity.score,
            "confidence": opportunity.confidence, "regime": opportunity.regime.value,
            "seconds_remaining": opportunity.market.seconds_remaining(now),
            "reasons": opportunity.reasons, "blockers": opportunity.blockers,
            "book_state": opportunity.book_state, "risk_state": opportunity.risk_state,
        })

    def _persist_order(self, outcome, now: float) -> None:
        result = outcome.result
        request = result.request
        self.db.enqueue("orders", {
            "ts": now, "client_id": request.client_id, "order_id": result.order_id,
            "opportunity_id": request.opportunity_id, "market_id": request.market_id,
            "token_id": request.token_id, "asset": request.asset,
            "outcome": request.outcome.value, "side": request.side.value,
            "kind": request.kind.value, "post_only": int(request.post_only),
            "price": request.price, "size": request.size, "state": result.state.value,
            "filled_size": result.filled_size, "avg_price": result.avg_price,
            "fees": result.fees, "error": result.error,
            "mode": self.settings.trading_mode.value,
            "finalised_at": result.finalised_at,
        })

    def _persist_position(self, position) -> None:
        self.db.enqueue("positions", {
            "position_id": position.position_id, "market_id": position.market_id,
            "condition_id": position.condition_id, "asset": position.asset,
            "outcome": position.outcome.value, "token_id": position.token_id,
            "size": position.size, "avg_price": position.avg_price,
            "fees_paid": position.fees_paid, "opened_at": position.opened_at,
            "window_end": position.window_end,
            "opportunity_id": position.opportunity_id, "strategy": position.strategy,
            "regime": position.regime, "entry_edge": position.entry_edge,
            "entry_confidence": position.entry_confidence,
            "entry_model_prob": position.entry_model_prob,
            "entry_market_prob": position.entry_market_prob,
            "closed_at": position.closed_at, "exit_price": position.exit_price,
            "realized_pnl": position.realized_pnl,
            "resolution": position.resolution.value if position.resolution else None,
        })

    def _persist_pnl(self, now: float) -> None:
        state = self.risk.state()
        stats = self.risk.stats()
        self.db.enqueue("pnl_snapshots", {
            "ts": now, "bankroll": state.bankroll, "equity": state.equity,
            "peak_equity": state.peak_equity, "open_exposure": state.open_exposure,
            "realized_pnl": state.realized_pnl, "unrealized_pnl": state.unrealized_pnl,
            "daily_pnl": state.daily_pnl, "open_positions": state.open_positions,
            "drawdown": state.drawdown, "trades": stats["trades"],
            "win_rate": stats["win_rate"],
        })

    def _persist_feed_health(self, now: float) -> None:
        for health in [f.health for f in self.feeds] + [self.pm_feed.health]:
            self.db.enqueue("feed_health", {
                "ts": now, "feed": health.name, "status": health.status.value,
                "latency_ms": health.latency_ms,
                "messages_per_sec": health.messages_per_sec,
                "reconnects": health.reconnects, "errors": health.errors,
                "clock_drift_ms": health.clock_drift_ms, "score": health.score,
                "detail": health.detail[:200],
            })

    def _persist_strategy_performance(self, now: float) -> None:
        pnl_by_strategy = self.risk.strategy_stats()
        for name, score in self.tracker.scores.items():
            row = pnl_by_strategy.get(name, {})
            self.db.enqueue("strategy_performance", {
                "ts": now, "strategy": name, "regime": None, "n": score.n,
                "ewma_brier": score.ewma_brier, "skill": score.skill,
                "wins": score.wins, "losses": score.losses,
                "weight": self.tracker.performance_weight(
                    name, self._last_regime()
                ),
                "pnl": row.get("pnl", 0.0),
            })

    def _last_regime(self):
        from .core.types import Regime

        for prediction in self._prediction_cache.values():
            return prediction.regime
        return Regime.RANGING

    def _record_error(self, component: str, exc: BaseException) -> None:
        self.log.warning(
            "component error",
            extra={"component": component, "error": f"{type(exc).__name__}: {exc}"[:300]},
        )
        self.health.record_api_error(self.clock.time())
        self.db.enqueue("errors", {
            "ts": self.clock.time(), "component": component,
            "kind": type(exc).__name__, "message": str(exc)[:500], "detail": None,
        })

    @staticmethod
    def _audit_payload(opportunity, outcome, position) -> dict[str, Any]:
        """The full "why did we do this?" record for one trade."""
        prediction = opportunity.prediction
        return {
            "opportunity_id": opportunity.opportunity_id,
            "position_id": position.position_id,
            "market_id": opportunity.market.market_id,
            "condition_id": opportunity.market.condition_id,
            "token_id": opportunity.market.token_id(opportunity.outcome),
            "asset": opportunity.market.asset,
            "slug": opportunity.market.slug,
            "window_start": opportunity.market.window_start,
            "window_end": opportunity.market.window_end,
            "side": opportunity.side.value,
            "outcome": opportunity.outcome.value,
            "entry_price": opportunity.entry_price,
            "fill_price": outcome.avg_price,
            "filled_size": outcome.filled_size,
            "fees": outcome.fees,
            "execution_style": outcome.style,
            "model_probability": opportunity.model_probability,
            "market_probability": opportunity.market_probability.implied_up,
            "analytic_probability": prediction.analytic_probability_up,
            "ml_probability": prediction.ml_probability_up,
            "gross_edge": opportunity.gross_edge,
            "fee_cost": opportunity.fee_cost,
            "slippage_cost": opportunity.slippage_cost,
            "net_edge": opportunity.net_edge,
            "expected_value": opportunity.expected_value,
            "confidence": prediction.confidence,
            "uncertainty": prediction.uncertainty,
            "calibrated": prediction.calibrated,
            "model_version": prediction.model_version,
            "regime": opportunity.regime.value,
            "decision": opportunity.decision.value,
            "score": opportunity.score,
            "strategy": position.strategy,
            "signals": [
                {
                    "strategy": s.strategy, "probability_up": s.probability_up,
                    "confidence": s.confidence, "abstain": s.abstain,
                    "reason": s.reason[:160],
                }
                for s in prediction.signals
            ],
            "reasons": opportunity.reasons,
            "book_state": opportunity.book_state,
            "risk_state": opportunity.risk_state,
        }

    # ------------------------------------------------------------ ws callback
    def _on_pm_event(self, event_type: str, message: dict) -> None:
        if event_type == "last_trade_price":
            token_id = str(message.get("asset_id") or "")
            # Called for every trade print on every tracked token. A scan over
            # markets x token ids here is paid a thousand times a second, and
            # falling behind gets us disconnected as a slow consumer.
            market = self._market_by_token.get(token_id)
            self.db.enqueue("public_trades", {
                "ts": self.clock.time(),
                "market_id": market.market_id if market else None,
                "token_id": token_id,
                "price": float(message.get("price") or 0.0),
                "size": float(message.get("size") or 0.0),
                "side": message.get("side"),
            })

    # ------------------------------------------------------------- state file
    async def _publish_state(self) -> None:
        """Atomically write the snapshot the dashboard reads."""
        state = self.snapshot()
        path = self.state_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(state, default=str))
            os.replace(tmp, path)
        except OSError as exc:
            self.log.warning("state publish failed", extra={"error": str(exc)[:200]})

    def snapshot(self) -> dict[str, Any]:
        now = self.clock.time()
        risk_state = self.risk.state()
        stats = self.risk.stats()
        health = getattr(self, "system_health", None)

        markets: list[dict[str, Any]] = []
        for market in sorted(self._markets.values(), key=lambda m: m.window_end):
            prediction = self._prediction_cache.get(market.market_id)
            up_book = self.books.snapshot(market.token_id(Outcome.UP), now)
            down_book = self.books.snapshot(market.token_id(Outcome.DOWN), now)
            best = max(
                (o for o in self._opportunity_cache if o.market.market_id == market.market_id),
                key=lambda o: o.net_edge, default=None,
            )
            strike = self.composite.strike_for(market.asset, market.window_start, now)
            spot = self.composite.price(market.asset)
            markets.append({
                "market_id": market.market_id, "asset": market.asset,
                "slug": market.slug, "title": market.title,
                "seconds_remaining": market.seconds_remaining(now),
                "in_window": market.is_in_window(now),
                "up_bid": up_book.best_bid if up_book else None,
                "up_ask": up_book.best_ask if up_book else None,
                "down_bid": down_book.best_bid if down_book else None,
                "down_ask": down_book.best_ask if down_book else None,
                "spread": up_book.spread if up_book else None,
                "liquidity": (
                    up_book.notional_depth("bid", 0.05) + up_book.notional_depth("ask", 0.05)
                ) if up_book else 0.0,
                "spot": spot, "strike": strike.price if strike.is_usable else None,
                "strike_quality": strike.quality,
                "distance_bps": (
                    (spot / strike.price - 1.0) * 1e4
                    if spot and strike.is_usable and strike.price > 0 else None
                ),
                "model_up": prediction.probability_up if prediction else None,
                "market_up": (prediction.features.get("implied_up") if prediction else None),
                "edge": best.net_edge if best else None,
                "required_edge": (
                    self.gate.required_edge(prediction, prediction.features)
                    if prediction else None
                ),
                "confidence": prediction.confidence if prediction else None,
                "uncertainty": prediction.uncertainty if prediction else None,
                "regime": prediction.regime.value if prediction else None,
                "decision": best.decision.value if best else None,
                "outcome_side": best.outcome.value if best else None,
                "data_quality": prediction.features.get("data_quality") if prediction else None,
            })

        signals: list[dict[str, Any]] = []
        for opportunity in self._opportunity_cache[:12]:
            prediction = opportunity.prediction
            signals.append({
                "asset": opportunity.market.asset,
                "market_id": opportunity.market.market_id,
                "outcome": opportunity.outcome.value,
                "model_probability": opportunity.model_probability,
                "market_probability": (
                    opportunity.market_probability.implied_up
                    if opportunity.outcome is Outcome.UP
                    else opportunity.market_probability.implied_down
                ),
                "net_edge": opportunity.net_edge,
                "gross_edge": opportunity.gross_edge,
                "fee_cost": opportunity.fee_cost,
                "slippage_cost": opportunity.slippage_cost,
                "confidence": opportunity.confidence,
                "decision": opportunity.decision.value,
                "score": opportunity.score,
                "regime": opportunity.regime.value,
                "seconds_remaining": opportunity.market.seconds_remaining(now),
                "size_shares": opportunity.size_shares,
                "notional": opportunity.notional,
                "reasons": opportunity.reasons[:5],
                "blockers": opportunity.blockers[:5],
                "drivers": [
                    {"strategy": s.strategy, "probability": s.probability_up,
                     "confidence": s.confidence, "reason": s.reason[:90]}
                    for s in sorted(
                        (x for x in prediction.signals if not x.abstain),
                        key=lambda x: -x.confidence,
                    )[:6]
                ],
            })

        positions = []
        for position in self.risk.positions.values():
            book = self.books.snapshot(position.token_id, now)
            mark = book.mid if book is not None and book.mid is not None else position.avg_price
            market = self._markets.get(position.market_id)
            positions.append({
                "position_id": position.position_id, "market_id": position.market_id,
                "asset": position.asset, "outcome": position.outcome.value,
                "size": position.size, "avg_price": position.avg_price,
                "current": mark, "exposure": position.size * position.avg_price,
                "unrealized": position.unrealized_pnl(mark),
                "seconds_remaining": market.seconds_remaining(now) if market else None,
                "entry_edge": position.entry_edge,
                "entry_confidence": position.entry_confidence,
                "expected_value": (position.entry_model_prob - position.avg_price)
                * position.size,
                "strategy": position.strategy,
            })

        trades = []
        for position in self.risk.closed_positions[-25:][::-1]:
            trades.append({
                "closed_at": position.closed_at, "asset": position.asset,
                "outcome": position.outcome.value, "size": position.size,
                "entry": position.avg_price, "exit": position.exit_price,
                "pnl": position.realized_pnl, "strategy": position.strategy,
                "edge": position.entry_edge, "confidence": position.entry_confidence,
                "resolution": position.resolution.value if position.resolution else None,
            })

        feeds = []
        for health_row in [f.health for f in self.feeds] + [self.pm_feed.health]:
            feeds.append({
                "name": health_row.name, "status": health_row.status.value,
                "latency_ms": health_row.latency_ms,
                "messages_per_sec": health_row.messages_per_sec,
                "reconnects": health_row.reconnects, "errors": health_row.errors,
                "clock_drift_ms": health_row.clock_drift_ms,
                "last_update": health_row.last_message_at, "score": health_row.score,
                "detail": health_row.detail[:80],
            })

        composites = {
            asset: {
                "price": state.last_composite.price if state.last_composite else None,
                "sources": state.last_composite.n_sources if state.last_composite else 0,
                "dispersion_bps": state.last_composite.dispersion_bps
                if state.last_composite else None,
                "healthy": state.last_composite.is_healthy if state.last_composite else False,
                "sigma_window_bps": self.composite.volatility(asset).per_window * 1e4,
            }
            for asset, state in self.composite.states.items()
        }

        return {
            "ts": now,
            "mode": self.settings.trading_mode.value,
            "live_armed": self.settings.is_live,
            "dry_run": self.settings.dry_run_live,
            "uptime": self.stats.uptime,
            "risk": risk_state.as_dict(),
            "stats": stats,
            "loop": {
                "cycles": self.stats.cycles, "errors": self.stats.errors,
                "last_cycle_ms": round(self.stats.last_cycle_ms, 2),
                "avg_cycle_ms": round(self.stats.avg_cycle_ms, 2),
                "evaluations": self.stats.evaluations,
                "trades_attempted": self.stats.trades_attempted,
                "trades_filled": self.stats.trades_filled,
            },
            "health": {
                "level": health.level.value if health else "OK",
                "score": health.score if health else 1.0,
                "issues": health.issues if health else [],
                "size_multiplier": health.size_multiplier if health else 1.0,
                "detail": health.detail if health else {},
            },
            "discovery": {
                "cycles": self.discovery.stats.cycles,
                "tracked": len(self._markets),
                "series": self.discovery.series_by_asset,
                "rejects": dict(list(self.discovery.stats.reject_reasons.items())[:6]),
                "last_error": self.discovery.stats.last_error[:160],
            },
            "markets": markets,
            "signals": signals,
            "positions": positions,
            "trades": trades,
            "feeds": feeds,
            "composites": composites,
            "execution": self.venue.stats.as_dict(),
            "working_orders": self.executor.working_count,
            "strategy_performance": {
                name: score.as_dict() for name, score in self.tracker.scores.items()
            },
            "strategy_pnl": self.risk.strategy_stats(),
            "database": self.db.stats.as_dict(),
            "resolution": self.resolutions.reconciliation.as_dict(),
            "alerts": self.alerts.recent(12),
        }
