"""The trade gate: the single place where a view becomes (or fails to become)
an order.

Every condition is checked explicitly and every failure is *named*, so the audit
log can answer "why was this trade not taken?" as precisely as "why was it?".

The economics are computed on the price we would actually get -- the touch we
have to cross plus the slippage of walking the book for our intended size --
never on the mid.  Trading off the mid is the fastest way to turn a real 2-point
edge into a real loss, because on these markets the spread alone is one tick and
the taker fee at 50c is another 1.75 points.

Net edge, in probability units (identical to dollars per share on a $1 binary):

    net_edge = model_probability - entry_price - slippage - fee_per_share

and the trade must additionally clear ``k * model_uncertainty`` so that a wide
error bar cannot masquerade as an edge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..core.types import (
    BookSnapshot,
    Decision,
    Market,
    MarketProbability,
    Opportunity,
    Outcome,
    Prediction,
    Regime,
    Side,
)
from ..logging_setup import get_logger
from ..polymarket.fees import FeeSchedule
from ..risk.engine import RiskEngine
from ..risk.sizing import SizingInputs, max_shares_for_slippage, size_position


@dataclass
class GateConfig:
    min_edge: float = 0.025
    min_confidence: float = 0.55
    min_model_agreement: float = 0.5
    edge_uncertainty_multiple: float = 1.0
    max_spread: float = 0.03
    min_liquidity_usd: float = 200.0
    min_top_of_book_shares: float = 5.0
    max_slippage: float = 0.02
    min_seconds_remaining: float = 20.0
    max_seconds_remaining: float = 270.0
    stale_book_seconds: float = 5.0
    min_data_quality: float = 0.5
    require_calibration: bool = False
    max_plausible_edge: float = 0.12
    high_confidence_edge: float = 0.05
    high_confidence_threshold: float = 0.75
    # Dynamic threshold shaping
    edge_vol_scaling: bool = True
    edge_liquidity_scaling: bool = True
    max_edge_multiplier: float = 2.5


class TradeGate:
    def __init__(
        self,
        config: GateConfig,
        risk: RiskEngine,
        sizing_method: str = "kelly",
        kelly_fraction: float = 0.25,
        maker_preferred: bool = True,
    ):
        self.config = config
        self.risk = risk
        self.sizing_method = sizing_method
        self.kelly_fraction = kelly_fraction
        self.maker_preferred = maker_preferred
        self.log = get_logger("pmbot.gate")

    # ------------------------------------------------------------- threshold
    def required_edge(self, prediction: Prediction, features: dict[str, float]) -> float:
        """The edge bar for *this* market right now.

        The bar rises with model uncertainty, thin liquidity, poor data quality
        and untradable regimes.  A fixed threshold is wrong because the cost of
        being wrong is not fixed.
        """
        base = self.config.min_edge
        multiplier = 1.0

        # Uncertainty: the dominant term.
        multiplier += 2.0 * max(0.0, prediction.uncertainty - 0.02)

        if self.config.edge_liquidity_scaling:
            liquidity = features.get("pm_liq_usd", 0.0)
            if liquidity < self.config.min_liquidity_usd * 3:
                shortfall = 1.0 - min(
                    liquidity / max(self.config.min_liquidity_usd * 3, 1e-9), 1.0
                )
                multiplier += 0.5 * shortfall

        if self.config.edge_vol_scaling:
            # When basis/measurement noise dominates the remaining move, our
            # probability is mostly a statement about our own error.
            multiplier += 1.0 * features.get("basis_share", 0.0)

        quality = features.get("data_quality", 1.0)
        multiplier += 1.0 * (1.0 - quality)

        if prediction.regime in (Regime.ABNORMAL_VOL, Regime.NEWS_LIKE, Regime.DIVERGENT):
            multiplier += 0.5

        multiplier = min(multiplier, self.config.max_edge_multiplier)
        return base * multiplier

    # ------------------------------------------------------------ evaluation
    def evaluate(
        self,
        market: Market,
        prediction: Prediction,
        market_probability: MarketProbability | None,
        up_book: BookSnapshot | None,
        down_book: BookSnapshot | None,
        now: float,
        fee_schedule: FeeSchedule | None = None,
    ) -> list[Opportunity]:
        """Score both outcomes; return every candidate, tradable or not.

        Rejected candidates are returned too (with ``blockers`` populated) so the
        dashboard and audit log can show near-misses.
        """
        schedule = fee_schedule or FeeSchedule(
            taker_rate=market.taker_fee_rate, maker_rate=market.maker_fee_rate
        )
        out: list[Opportunity] = []
        for outcome in (Outcome.UP, Outcome.DOWN):
            book = up_book if outcome is Outcome.UP else down_book
            opportunity = self._evaluate_side(
                market, outcome, prediction, market_probability, book,
                up_book, down_book, now, schedule,
            )
            if opportunity is not None:
                out.append(opportunity)
        return out

    def _evaluate_side(
        self,
        market: Market,
        outcome: Outcome,
        prediction: Prediction,
        market_probability: MarketProbability | None,
        book: BookSnapshot | None,
        up_book: BookSnapshot | None,
        down_book: BookSnapshot | None,
        now: float,
        schedule: FeeSchedule,
    ) -> Opportunity | None:
        features = prediction.features
        blockers: list[str] = []
        reasons: list[str] = []

        model_probability = prediction.probability(outcome)

        # ---- market validity -------------------------------------------
        if not market.is_tradable(now):
            blockers.append("market not tradable")
        tau = market.seconds_remaining(now)
        if tau < self.config.min_seconds_remaining:
            blockers.append(f"only {tau:.0f}s remaining")
        if tau > self.config.max_seconds_remaining:
            blockers.append(f"{tau:.0f}s remaining, window too fresh")

        # ---- data quality ------------------------------------------------
        quality = features.get("data_quality", 0.0)
        if quality < self.config.min_data_quality:
            blockers.append(f"data quality {quality:.2f}")
        if self.config.require_calibration and not prediction.calibrated:
            blockers.append("probability not calibrated")
        if not prediction.calibrated:
            reasons.append("uncalibrated probability")

        # ---- book validity ------------------------------------------------
        if book is None or book.best_ask is None or book.best_bid is None:
            blockers.append("no two-sided book")
            return self._reject(
                market, outcome, prediction, market_probability, model_probability,
                blockers, reasons, now,
            )
        if book.is_crossed():
            blockers.append("book crossed")
        age = now - book.timestamp if book.timestamp else float("inf")
        if age > self.config.stale_book_seconds:
            blockers.append(f"book stale {age:.1f}s")

        spread = book.spread or 1.0
        if spread > self.config.max_spread:
            blockers.append(f"spread {spread:.3f} > {self.config.max_spread:.3f}")

        liquidity = book.notional_depth("bid", 0.05) + book.notional_depth("ask", 0.05)
        if liquidity < self.config.min_liquidity_usd:
            blockers.append(f"liquidity ${liquidity:.0f} < ${self.config.min_liquidity_usd:.0f}")
        if book.best_ask_size < self.config.min_top_of_book_shares:
            blockers.append(f"top of book only {book.best_ask_size:.1f} shares")

        # ---- economics ----------------------------------------------------
        # Opening a position always means *buying* the outcome token, so the
        # relevant price is the ask we have to cross (or rest just inside).
        entry_price = book.best_ask
        if not 0.0 < entry_price < 1.0:
            blockers.append(f"invalid ask {entry_price}")
            return self._reject(
                market, outcome, prediction, market_probability, model_probability,
                blockers, reasons, now,
            )

        # How much can we buy before slippage exceeds the budget?
        max_shares = max_shares_for_slippage(
            lambda shares: book.walk(Side.BUY, shares),
            self.config.max_slippage,
            entry_price,
            upper_bound=max(book.depth("ask", 0.10), 1.0),
        )
        if max_shares < market.min_order_size:
            blockers.append(
                f"only {max_shares:.1f} shares available within slippage budget"
            )

        risk_state = self.risk.state()
        sizing = size_position(
            SizingInputs(
                model_probability=model_probability,
                entry_price=entry_price,
                fee_per_share=schedule.per_share(entry_price),
                slippage=0.0,      # slippage is bounded by max_shares below
                uncertainty=prediction.uncertainty,
                bankroll=self.risk.bankroll,
                available=self.risk.available,
                kelly_fraction=self.kelly_fraction,
                uncertainty_multiple=self.config.edge_uncertainty_multiple,
                max_stake_fraction=self.risk.limits.max_stake_fraction,
                max_stake_absolute=self.risk.limits.max_stake_per_trade,
                min_notional=self.risk.limits.min_order_notional,
                min_shares=market.min_order_size,
                tick_size=market.tick_size,
                max_shares_from_book=max_shares if max_shares > 0 else None,
            ),
            method=self.sizing_method,
        )

        shares = sizing.shares
        slippage = 0.0
        if shares > 0:
            walk = book.walk(Side.BUY, shares)
            if walk is not None:
                slippage = max(0.0, walk[0] - entry_price)
        if slippage > self.config.max_slippage:
            blockers.append(f"slippage {slippage:.4f} > {self.config.max_slippage:.4f}")

        fill_price = entry_price + slippage
        fee_per_share = schedule.per_share(fill_price)
        gross_edge = model_probability - entry_price
        net_edge = model_probability - fill_price - fee_per_share
        ev_per_share = net_edge

        # ---- signal quality ------------------------------------------------
        threshold = self.required_edge(prediction, features)
        if net_edge < threshold:
            blockers.append(f"net edge {net_edge:+.4f} < required {threshold:.4f}")
        if net_edge > self.config.max_plausible_edge:
            # A very large disagreement with a liquid market is far more often
            # a bug in our inputs than free money, so it is refused rather than
            # sized up.  Real opportunities of this size will still be caught
            # after the cause has been understood.
            blockers.append(
                f"net edge {net_edge:+.4f} implausibly large "
                f"(> {self.config.max_plausible_edge:.3f}); treating as model error"
            )
        if net_edge < self.config.edge_uncertainty_multiple * prediction.uncertainty:
            blockers.append(
                f"net edge {net_edge:+.4f} inside uncertainty band "
                f"{prediction.uncertainty:.4f}"
            )
        if prediction.confidence < self.config.min_confidence:
            blockers.append(
                f"confidence {prediction.confidence:.2f} < {self.config.min_confidence:.2f}"
            )

        agreement = self._agreement(prediction, outcome)
        if agreement < self.config.min_model_agreement:
            blockers.append(f"strategy agreement {agreement:.2f}")

        # ---- risk ----------------------------------------------------------
        if sizing.shares <= 0:
            blockers.append(f"sizing: {sizing.binding_constraint}")
        else:
            risk_check = self.risk.check_trade(market, outcome, sizing.notional)
            if not risk_check:
                blockers.append(f"risk: {risk_check.reason}")

        # ---- decision ------------------------------------------------------
        decision = self._decide(net_edge, threshold, prediction, bool(blockers))
        score = self._score(net_edge, prediction, liquidity, slippage, agreement, tau)

        if not blockers:
            reasons.insert(0, f"net edge {net_edge:+.4f} vs required {threshold:.4f}")
            reasons.append(f"confidence {prediction.confidence:.2f}")
            reasons.append(f"agreement {agreement:.2f}")
            top = sorted(
                (s for s in prediction.signals if not s.abstain),
                key=lambda s: -s.confidence,
            )[:4]
            if top:
                reasons.append(
                    "drivers: " + ", ".join(f"{s.strategy}={s.probability_up:.2f}" for s in top)
                )

        return Opportunity(
            market=market,
            outcome=outcome,
            side=Side.BUY,
            prediction=prediction,
            market_probability=market_probability or MarketProbability(
                0.5, 0.5, None, None, 0.0, "unavailable"
            ),
            entry_price=entry_price,
            model_probability=model_probability,
            gross_edge=gross_edge,
            fee_cost=fee_per_share,
            slippage_cost=slippage,
            net_edge=net_edge,
            expected_value_per_share=ev_per_share,
            size_shares=sizing.shares,
            notional=sizing.notional,
            expected_value=ev_per_share * sizing.shares,
            decision=decision,
            score=score,
            confidence=prediction.confidence,
            regime=prediction.regime,
            reasons=reasons,
            blockers=blockers,
            book_state={
                "best_bid": book.best_bid,
                "best_ask": book.best_ask,
                "spread": spread,
                "bid_size": book.best_bid_size,
                "ask_size": book.best_ask_size,
                "liquidity_usd": liquidity,
                "imbalance": book.imbalance(0.05),
                "max_shares_in_budget": max_shares,
                "age": age,
                "tick_size": book.tick_size,
            },
            risk_state=risk_state.as_dict(),
        )

    # ---------------------------------------------------------------- helpers
    def _reject(
        self, market, outcome, prediction, market_probability, model_probability,
        blockers, reasons, now,
    ) -> Opportunity:
        return Opportunity(
            market=market, outcome=outcome, side=Side.BUY, prediction=prediction,
            market_probability=market_probability or MarketProbability(
                0.5, 0.5, None, None, 0.0, "unavailable"
            ),
            entry_price=0.0, model_probability=model_probability,
            gross_edge=0.0, fee_cost=0.0, slippage_cost=0.0, net_edge=0.0,
            expected_value_per_share=0.0, size_shares=0.0, notional=0.0,
            expected_value=0.0, decision=Decision.NO_TRADE, score=0.0,
            confidence=prediction.confidence, regime=prediction.regime,
            reasons=reasons, blockers=blockers,
            risk_state=self.risk.state().as_dict(),
        )

    @staticmethod
    def _agreement(prediction: Prediction, outcome: Outcome) -> float:
        """Confidence-weighted share of strategies pointing the same way."""
        active = [s for s in prediction.signals if not s.abstain and s.confidence > 0]
        if not active:
            return 0.0
        total = sum(s.confidence for s in active)
        if total <= 0:
            return 0.0
        aligned = sum(
            s.confidence for s in active
            if (s.probability_up > 0.5) == (outcome is Outcome.UP)
        )
        return aligned / total

    def _decide(
        self, net_edge: float, threshold: float, prediction: Prediction, blocked: bool
    ) -> Decision:
        if blocked:
            if net_edge >= threshold * 0.6 and prediction.confidence >= self.config.min_confidence * 0.8:
                return Decision.WATCH
            if net_edge > 0:
                return Decision.WEAK_SIGNAL
            return Decision.NO_TRADE
        if (
            net_edge >= self.config.high_confidence_edge
            and prediction.confidence >= self.config.high_confidence_threshold
        ):
            return Decision.HIGH_CONFIDENCE_TRADE
        return Decision.TRADE

    @staticmethod
    def _score(
        net_edge: float,
        prediction: Prediction,
        liquidity: float,
        slippage: float,
        agreement: float,
        seconds_remaining: float,
    ) -> float:
        """Ranking score across simultaneously-tradable opportunities.

        Not "biggest signal": a large edge on an illiquid, uncertain market with
        four seconds left is worse than a moderate edge that can actually be
        executed.  The score is an expected-value estimate discounted for
        execution quality, model uncertainty and disagreement.
        """
        if net_edge <= 0:
            return 0.0
        execution_quality = 1.0 / (1.0 + slippage * 50.0)
        liquidity_factor = min(1.0, math.log1p(max(liquidity, 0.0)) / math.log1p(2000.0))
        uncertainty_penalty = 1.0 / (1.0 + max(prediction.uncertainty, 0.0) * 8.0)
        # A little more time left is better: more chance to work an order.
        time_factor = min(1.0, max(seconds_remaining, 0.0) / 120.0) ** 0.5
        return (
            net_edge
            * prediction.confidence
            * agreement
            * execution_quality
            * liquidity_factor
            * uncertainty_penalty
            * (0.6 + 0.4 * time_factor)
        )


def rank_opportunities(opportunities: list[Opportunity]) -> list[Opportunity]:
    """Tradable first by score, then the near-misses for display."""
    tradable = [o for o in opportunities if o.is_tradable]
    rest = [o for o in opportunities if not o.is_tradable]
    tradable.sort(key=lambda o: o.score, reverse=True)
    rest.sort(key=lambda o: (o.net_edge, o.confidence), reverse=True)
    return tradable + rest
