"""Event-driven backtester.

It constructs the *same* objects the live bot uses -- composite price engine,
order-book manager, feature engine, strategies, meta-model, risk engine, trade
gate, paper venue, executor -- and drives them with a
:class:`~pmbot.core.clock.SimulatedClock` over a replay event stream.  There is
no separate "backtest strategy" implementation that could drift from the live
one.

No look-ahead, structurally:

* The simulated clock only ever moves forward, and every component reads time
  from it.
* At simulated time ``t`` only events with ``ts <= t`` have been applied, so a
  feature computed at ``t`` cannot see a later book update or print.
* Market resolution is applied strictly *after* ``window_end``, and the truth
  dictionary is never exposed to the feature engine, the strategies or the gate.
* Fills come from walking the replayed book, so execution cannot be better than
  the liquidity that actually existed at that instant.

Reproducibility: every run records its config, seed, code commit, dataset
fingerprint and the resulting metrics in a manifest.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import Settings
from ..core.clock import SimulatedClock
from ..core.types import Market, Opportunity, Outcome, Prediction
from ..exchanges.composite import CompositePriceEngine
from ..execution.executor import Executor
from ..execution.gate import GateConfig, TradeGate, rank_opportunities
from ..execution.paper import PaperVenue
from ..features.engine import FEATURE_NAMES, FeatureEngine
from ..logging_setup import get_logger
from ..ml.dataset import Dataset, TrainingSample
from ..ml.registry import LoadedModel
from ..orderbook.book import OrderBookManager
from ..polymarket.fees import FeeSchedule
from ..probability.analytic import basis_sigma_from_bps
from ..probability.calibration import Calibrator, evaluate
from ..probability.engine import PredictionEngine
from ..resolution import ResolutionTracker
from ..risk.engine import RiskEngine, RiskLimits
from ..strategies.base import StrategyConfig
from ..strategies.ensemble import MetaModel, StrategyPerformanceTracker
from ..strategies.ml_strategy import MLStrategy
from ..strategies.regime import RegimeDetector
from ..strategies.signals import build_strategies
from .metrics import PerformanceReport, TradeRecord, evaluate_trades
from .replay import ReplaySession


@dataclass
class BacktestConfig:
    decision_interval: float = 1.0
    record_samples: bool = True
    sample_interval: float = 5.0
    label: str = "backtest"
    seed: int = 42
    progress_every: int = 0          # cycles between progress logs; 0 = silent


@dataclass
class BacktestResult:
    run_id: str
    label: str
    report: PerformanceReport
    trades: list[TradeRecord]
    dataset: Dataset
    manifest: dict[str, Any]
    predictions: list[tuple[float, float, int]] = field(default_factory=list)
    diagnostics: dict[str, Any] = field(default_factory=dict)

    @property
    def calibration(self):
        if not self.predictions:
            return None
        return evaluate([p for _, p, _ in self.predictions],
                        [y for _, _, y in self.predictions])

    def calibration_by_horizon(
        self, buckets: tuple[tuple[float, float], ...] = (
            (240, 300), (180, 240), (120, 180), (60, 120), (20, 60), (0, 20),
        ),
        probability_key: str = "analytic_up",
    ) -> dict[str, dict]:
        """Calibration of the model's probability at each time-to-expiry band.

        A single aggregate number is misleading here: near expiry the analytic
        model is almost deterministic, so it will look brilliant, while the
        interesting question is whether it is calibrated with minutes to run.
        """
        rows = [s for s in self.dataset.samples if s.is_labelled]
        out: dict[str, dict] = {}
        for lo, hi in buckets:
            selected = [
                s for s in rows
                if lo <= (s.window_end - s.timestamp) < hi
                and probability_key in s.features
            ]
            if len(selected) < 20:
                continue
            probabilities = [s.features[probability_key] for s in selected]
            labels = [int(s.label or 0) for s in selected]
            report = evaluate(probabilities, labels)
            market = [
                (s.market_probability_up, int(s.label or 0))
                for s in selected if s.market_probability_up is not None
            ]
            market_report = (
                evaluate([p for p, _ in market], [y for _, y in market])
                if len(market) >= 20 else None
            )
            out[f"{int(lo)}-{int(hi)}s"] = {
                "n": report.n_samples,
                "brier": round(report.brier, 5),
                "brier_skill": round(report.brier_skill, 5),
                "ece": round(report.ece, 5),
                "ece_floor": round(report.ece_noise_floor, 5),
                "ece_excess": round(report.ece_excess, 5),
                "auc": round(report.auc, 4) if report.auc is not None else None,
                "market_brier": round(market_report.brier, 5) if market_report else None,
                "vs_market": (
                    round(market_report.brier - report.brier, 5)
                    if market_report else None
                ),
            }
        return out

    def save(self, directory: Path) -> Path:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{self.run_id}.json"
        calibration = self.calibration
        path.write_text(json.dumps({
            "run_id": self.run_id,
            "label": self.label,
            "manifest": self.manifest,
            "report": self.report.as_dict(),
            "diagnostics": self.diagnostics,
            "calibration": calibration.as_dict() if calibration else None,
            "calibration_by_horizon": self.calibration_by_horizon(),
            "by_asset": self.report.by_asset,
            "by_strategy": self.report.by_strategy,
            "by_regime": self.report.by_regime,
        }, indent=2, default=str))
        return path


class BacktestEngine:
    def __init__(
        self,
        settings: Settings,
        session: ReplaySession,
        config: BacktestConfig | None = None,
        model: LoadedModel | None = None,
        calibrator: Calibrator | None = None,
    ):
        self.settings = settings
        self.session = session
        self.config = config or BacktestConfig()
        self.log = get_logger("pmbot.backtest")
        self.clock = SimulatedClock(session.start if session.events else 0.0)

        self.composite = CompositePriceEngine(
            assets=sorted({m.asset for m in session.markets}) or list(settings.assets),
            stale_seconds=settings.feed_stale_seconds,
            min_sources=settings.min_healthy_exchanges,
            divergence_bps=settings.feed_divergence_bps,
            window_seconds=settings.market_window_seconds,
            clock=self.clock,
        )
        self.books = OrderBookManager(stale_seconds=settings.stale_book_seconds)
        sigma_basis = (
            basis_sigma_from_bps(settings.oracle_basis_bps)
            if settings.resolution_oracle == "composite" else 0.0
        )
        self.features = FeatureEngine(
            composite=self.composite, books=self.books,
            stale_book_seconds=settings.stale_book_seconds,
            sigma_basis=sigma_basis,
            probability_floor=settings.probability_floor,
            probability_cap=settings.probability_cap,
        )
        names = [n for n in settings.enabled_strategies if n != "ml"]
        self.strategies = build_strategies(names, {n: StrategyConfig() for n in names})
        self.tracker = StrategyPerformanceTracker(
            halflife=settings.strategy_weight_halflife,
            min_weight=settings.min_strategy_weight,
            max_weight=settings.max_strategy_weight,
        )
        self.meta = MetaModel(tracker=self.tracker, adaptive=settings.adaptive_weights)
        self.ml_strategy = (
            MLStrategy(model) if "ml" in settings.enabled_strategies else None
        )
        self.engine = PredictionEngine(
            features=self.features, strategies=self.strategies, meta=self.meta,
            regime_detector=RegimeDetector(), calibrator=calibrator,
            ml_strategy=self.ml_strategy,
            ml_blend_weight=settings.ml_blend_weight if model else 0.0,
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
        self.venue = PaperVenue(
            self.books, clock=self.clock, latency_ms=settings.paper_latency_ms,
            maker_fill_ratio=settings.paper_maker_fill_ratio,
            queue_model=settings.paper_queue_model,
            order_timeout=settings.order_timeout_seconds,
            seed=self.config.seed, simulate_latency_sleep=False,
        )
        for market in session.markets:
            schedule = FeeSchedule(
                taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
            )
            for token_id in market.token_ids:
                self.venue.set_fee_schedule(token_id, schedule)
        self.executor = Executor(
            venue=self.venue, books=self.books, clock=self.clock,
            style=settings.execution_style,
            maker_wait_seconds=settings.maker_wait_seconds,
            min_seconds_remaining=settings.min_seconds_remaining,
            risk=self.risk,
        )
        self.resolutions = ResolutionTracker()

        self._cursor = 0
        self._trades: list[TradeRecord] = []
        self._samples: list[TrainingSample] = []
        self._predictions: list[tuple[float, float, int]] = []
        self._prediction_cache: dict[str, Prediction] = {}
        self._signals_at_entry: dict[str, list] = {}
        self._last_sample: dict[str, float] = {}
        self._settled: set[str] = set()
        self._diagnostics = {
            "cycles": 0, "evaluations": 0, "tradable": 0, "blocked": 0,
            "blocker_counts": {}, "gate_rejections": 0, "orders": 0,
        }

    # ------------------------------------------------------------------ run
    def run(self) -> BacktestResult:
        return asyncio.run(self.run_async())

    async def run_async(self) -> BacktestResult:
        session = self.session
        if not session.events:
            raise ValueError("replay session has no events")

        started_wall = time.time()
        end = session.end
        step = self.config.decision_interval
        current = session.start

        await self.venue.start()

        while current <= end + self.settings.market_window_seconds:
            self.clock.set(current)
            self._apply_events(current)
            await self._cycle(current)
            self._diagnostics["cycles"] += 1
            if (
                self.config.progress_every
                and self._diagnostics["cycles"] % self.config.progress_every == 0
            ):
                self.log.info(
                    "backtest progress",
                    extra={
                        "simulated_time": current,
                        "pct": round((current - session.start) / max(end - session.start, 1) * 100, 1),
                        "trades": len(self._trades),
                        "equity": round(self.risk.equity(), 2),
                    },
                )
            current += step

        # Close anything still open at the end of the data.
        await self.executor.cancel_all()
        for position in list(self.risk.positions.values()):
            self.risk.close_position_at_price(
                position.position_id, position.avg_price, 0.0, self.clock.time()
            )

        report = evaluate_trades(self._trades, self.settings.bankroll)
        dataset = Dataset(self._samples, FEATURE_NAMES)
        manifest = self._manifest(started_wall, dataset)
        result = BacktestResult(
            run_id=manifest["run_id"], label=self.config.label, report=report,
            trades=self._trades, dataset=dataset, manifest=manifest,
            predictions=self._predictions,
            diagnostics={
                **self._diagnostics,
                "execution": self.venue.stats.as_dict(),
                "risk": self.risk.state().as_dict(),
                "resolution": self.resolutions.reconciliation.as_dict(),
                "top_blockers": sorted(
                    self._diagnostics["blocker_counts"].items(),
                    key=lambda kv: -kv[1],
                )[:12],
            },
        )
        return result

    # --------------------------------------------------------------- internals
    def _apply_events(self, until: float) -> None:
        events, self._cursor = self.session.iter_until(until, self._cursor)
        for event in events:
            if event.kind == "tick":
                tick = event.payload
                tick.received_at = event.ts
                self.composite.on_tick(tick)
            elif event.kind == "book":
                token_id, bids, asks, tick_size = event.payload
                book = self.books.ensure(token_id)
                book.apply_snapshot(bids, asks, event.ts, tick_size, now=event.ts)
            elif event.kind == "trade":
                token_id, price, size, side = event.payload
                from ..core.types import Side

                mapped = (
                    Side.BUY if side == "BUY" else (Side.SELL if side == "SELL" else None)
                )
                self.books.record_trade(token_id, price, size, mapped, event.ts)

    async def _cycle(self, now: float) -> None:
        self.composite.compute_all(now)

        marks: dict[str, float] = {}
        for position in self.risk.positions.values():
            book = self.books.snapshot(position.token_id, now)
            if book is not None and book.mid is not None:
                marks[position.token_id] = book.mid
        self.risk.set_marks(marks)

        candidates: list[Opportunity] = []
        for market in self.session.markets:
            if not (market.window_start - 30 <= now < market.window_end):
                continue
            self._diagnostics["evaluations"] += 1
            result = self.engine.predict(market, now)
            if result is None:
                continue
            self._prediction_cache[market.market_id] = result.prediction
            self._record_sample(market, result, now)

            opportunities = self.gate.evaluate(
                market=market, prediction=result.prediction,
                market_probability=result.feature_set.context.market_probability,
                up_book=result.feature_set.context.up_book,
                down_book=result.feature_set.context.down_book,
                now=now,
                fee_schedule=FeeSchedule(
                    taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
                ),
            )
            for opportunity in opportunities:
                if opportunity.is_tradable:
                    self._diagnostics["tradable"] += 1
                else:
                    self._diagnostics["blocked"] += 1
                    for blocker in opportunity.blockers[:2]:
                        key = _blocker_key(blocker)
                        counts = self._diagnostics["blocker_counts"]
                        counts[key] = counts.get(key, 0) + 1
            candidates.extend(opportunities)

        for opportunity in rank_opportunities(candidates):
            if not opportunity.is_tradable:
                break
            if self.risk.is_paused(now):
                break
            if not self.risk.check_trade(
                opportunity.market, opportunity.outcome, opportunity.notional
            ):
                continue
            self._signals_at_entry[opportunity.opportunity_id] = list(
                opportunity.prediction.signals
            )
            outcome = await self.executor.execute(opportunity)
            self._diagnostics["orders"] += 1
            if outcome.is_filled:
                self._open(opportunity, outcome)

        for finished in await self.executor.step(revalidate=self._revalidate, now=now):
            if finished.is_filled:
                self._open(finished.opportunity, finished)

        self._settle(now)

    def _open(self, opportunity: Opportunity, outcome) -> None:
        result = outcome.result
        if result is None or not result.fills:
            return
        self.risk.open_position(
            market=opportunity.market, outcome=opportunity.outcome,
            fills=result.fills, opportunity_id=opportunity.opportunity_id,
            strategy=_dominant_strategy(opportunity),
            regime=opportunity.regime.value,
            execution_style=outcome.style,
            entry_edge=opportunity.net_edge,
            entry_confidence=opportunity.confidence,
            entry_model_prob=opportunity.model_probability,
            entry_market_prob=(
                opportunity.market_probability.implied_up
                if opportunity.outcome is Outcome.UP
                else opportunity.market_probability.implied_down
            ),
        )
        return

    def _settle(self, now: float) -> None:
        for market in self.session.markets:
            if market.window_end > now or market.market_id in self._settled:
                continue
            truth = self.session.truth.get(market.market_id)
            if truth is None:
                continue
            self._settled.add(market.market_id)
            resolved = truth.outcome

            for position in self.risk.positions_for_market(market.market_id):
                style = position.execution_style
                settled = self.risk.settle_position(position.position_id, resolved, now)
                if settled is None or settled.realized_pnl is None:
                    continue
                self._trades.append(TradeRecord(
                    market_id=market.market_id, asset=market.asset,
                    outcome=settled.outcome.value, opened_at=settled.opened_at,
                    closed_at=now, entry_price=settled.avg_price, size=settled.size,
                    fees=settled.fees_paid, pnl=settled.realized_pnl,
                    won=settled.outcome is resolved,
                    model_probability=settled.entry_model_prob,
                    market_probability=settled.entry_market_prob,
                    edge=settled.entry_edge, confidence=settled.entry_confidence,
                    strategy=settled.strategy, regime=settled.regime,
                    execution_style=style,
                ))

            prediction = self._prediction_cache.get(market.market_id)
            if prediction is not None:
                resolved_up = resolved is Outcome.UP
                self._predictions.append((
                    now, prediction.probability_up, 1 if resolved_up else 0
                ))
                self.engine.skill.record(
                    prediction.unanchored_probability_up
                    if prediction.unanchored_probability_up is not None
                    else prediction.probability_up,
                    prediction.features.get("implied_up"),
                    resolved_up,
                )
            for position in self.risk.closed_positions:
                if position.market_id != market.market_id or not position.opportunity_id:
                    continue
                signals = self._signals_at_entry.pop(position.opportunity_id, None)
                if signals:
                    from ..runner import _regime_from_name

                    self.engine.record_outcome(
                        signals, _regime_from_name(position.regime),
                        resolved is Outcome.UP,
                    )

            for sample in self._samples:
                if sample.market_id == market.market_id and sample.label is None:
                    sample.label = 1 if resolved is Outcome.UP else 0

    def _record_sample(self, market: Market, result, now: float) -> None:
        if not self.config.record_samples:
            return
        last = self._last_sample.get(market.market_id, 0.0)
        if now - last < self.config.sample_interval:
            return
        self._last_sample[market.market_id] = now
        self._samples.append(TrainingSample(
            market_id=market.market_id, asset=market.asset, timestamp=now,
            window_start=market.window_start, window_end=market.window_end,
            features=dict(result.feature_set.features), label=None,
            market_probability_up=result.feature_set.features.get("implied_up"),
        ))

    def _revalidate(self, opportunity: Opportunity) -> float | None:
        prediction = self._prediction_cache.get(opportunity.market.market_id)
        if prediction is None:
            return None
        book = self.books.snapshot(
            opportunity.market.token_id(opportunity.outcome), self.clock.time()
        )
        if book is None or book.best_ask is None:
            return None
        schedule = FeeSchedule(taker_rate=opportunity.market.taker_fee_rate)
        model = prediction.probability(opportunity.outcome)
        return model - book.best_ask - schedule.per_share(book.best_ask)

    def _manifest(self, started_wall: float, dataset: Dataset) -> dict[str, Any]:
        from ..ml.train import code_commit

        config_blob = json.dumps(self.settings.redacted_dict(), sort_keys=True, default=str)
        return {
            "run_id": f"{self.config.label}-{uuid.uuid4().hex[:10]}",
            "label": self.config.label,
            "created_at": time.time(),
            "wall_seconds": round(time.time() - started_wall, 2),
            "seed": self.config.seed,
            "code_commit": code_commit(),
            "config_hash": hashlib.sha256(config_blob.encode()).hexdigest()[:16],
            "config": self.settings.redacted_dict(),
            "session": self.session.describe(),
            "dataset": dataset.describe(),
            "decision_interval": self.config.decision_interval,
            "synthetic": self.session.synthetic,
        }


_BLOCKER_PREFIXES = (
    "net edge", "confidence", "spread", "liquidity", "book stale",
    "risk:", "sizing:", "data quality", "slippage", "strategy agreement",
    "top of book", "market not tradable", "no two-sided book", "book crossed",
    "probability not calibrated", "size reduced",
)
_BLOCKER_SUBSTRINGS = (
    ("window too fresh", "window too fresh"),
    ("s remaining", "too little time remaining"),
    ("within slippage budget", "not enough size inside slippage budget"),
    ("inside uncertainty band", "edge inside uncertainty band"),
)


def _blocker_key(blocker: str) -> str:
    """Collapse a blocker message into a countable category."""
    for needle, label in _BLOCKER_SUBSTRINGS:
        if needle in blocker:
            return label
    for prefix in _BLOCKER_PREFIXES:
        if blocker.startswith(prefix):
            return prefix.rstrip(":")
    return blocker.split()[0] if blocker else "unknown"


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
