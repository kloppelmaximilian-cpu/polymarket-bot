"""Domain types shared across the whole system.

These are plain dataclasses on purpose: they sit on the hot path (thousands of
book updates per minute) and pydantic validation there would be wasted work.
Validation happens at the boundary (parsers in ``pmbot.polymarket``).
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

# --------------------------------------------------------------------- enums


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Outcome(str, Enum):
    UP = "UP"
    DOWN = "DOWN"

    @property
    def other(self) -> Outcome:
        return Outcome.DOWN if self is Outcome.UP else Outcome.UP


class Decision(str, Enum):
    NO_TRADE = "NO_TRADE"
    WEAK_SIGNAL = "WEAK_SIGNAL"
    WATCH = "WATCH"
    TRADE = "TRADE"
    HIGH_CONFIDENCE_TRADE = "HIGH_CONFIDENCE_TRADE"

    @property
    def is_actionable(self) -> bool:
        return self in (Decision.TRADE, Decision.HIGH_CONFIDENCE_TRADE)


class Regime(str, Enum):
    TRENDING = "TRENDING"
    RANGING = "RANGING"
    HIGH_VOL = "HIGH_VOL"
    LOW_VOL = "LOW_VOL"
    ABNORMAL_VOL = "ABNORMAL_VOL"
    LIQUIDITY_SHOCK = "LIQUIDITY_SHOCK"
    NEWS_LIKE = "NEWS_LIKE"
    UNSTABLE = "UNSTABLE"
    DIVERGENT = "DIVERGENT"


class OrderState(str, Enum):
    PENDING = "PENDING"
    OPEN = "OPEN"
    PARTIAL = "PARTIAL"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"

    @property
    def is_terminal(self) -> bool:
        return self in (
            OrderState.FILLED,
            OrderState.CANCELLED,
            OrderState.REJECTED,
            OrderState.EXPIRED,
        )


class FeedStatus(str, Enum):
    ONLINE = "ONLINE"
    DEGRADED = "DEGRADED"
    OFFLINE = "OFFLINE"


class OrderKind(str, Enum):
    GTC = "GTC"
    GTD = "GTD"
    FOK = "FOK"
    FAK = "FAK"


# ------------------------------------------------------------------- markets


@dataclass(slots=True)
class TokenInfo:
    token_id: str
    outcome: Outcome
    raw_outcome: str


@dataclass(slots=True)
class Market:
    """A single 5-minute crypto up/down market."""

    market_id: str
    condition_id: str
    question_id: str | None
    slug: str
    asset: str
    title: str
    window_start: float           # epoch seconds, UTC
    window_end: float             # epoch seconds, UTC
    tokens: dict[Outcome, TokenInfo]
    tick_size: float
    min_order_size: float
    neg_risk: bool
    enable_order_book: bool
    accepting_orders: bool
    active: bool
    closed: bool
    resolution_source: str | None = None
    taker_fee_rate: float = 0.07
    maker_fee_rate: float = 0.0
    fee_type: str | None = None
    liquidity: float = 0.0
    volume: float = 0.0
    series_slug: str | None = None
    discovered_at: float = field(default_factory=time.time)
    raw: dict[str, Any] = field(default_factory=dict)

    def token_id(self, outcome: Outcome) -> str:
        return self.tokens[outcome].token_id

    def outcome_of(self, token_id: str) -> Outcome | None:
        for outcome, info in self.tokens.items():
            if info.token_id == token_id:
                return outcome
        return None

    @property
    def token_ids(self) -> list[str]:
        return [t.token_id for t in self.tokens.values()]

    def seconds_remaining(self, now: float | None = None) -> float:
        return self.window_end - (time.time() if now is None else now)

    def seconds_elapsed(self, now: float | None = None) -> float:
        return (time.time() if now is None else now) - self.window_start

    def is_in_window(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return self.window_start <= now < self.window_end

    def is_tradable(self, now: float | None = None) -> bool:
        return (
            self.active
            and not self.closed
            and self.accepting_orders
            and self.enable_order_book
            and self.seconds_remaining(now) > 0
        )


# ---------------------------------------------------------------- order book


@dataclass(slots=True, frozen=True)
class PriceLevel:
    price: float
    size: float


@dataclass(slots=True)
class BookSnapshot:
    """Normalised L2 snapshot. ``bids`` descending, ``asks`` ascending."""

    token_id: str
    bids: list[PriceLevel]
    asks: list[PriceLevel]
    timestamp: float
    sequence: int = 0
    tick_size: float = 0.01
    source_hash: str | None = None

    @property
    def best_bid(self) -> float | None:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> float | None:
        return self.asks[0].price if self.asks else None

    @property
    def best_bid_size(self) -> float:
        return self.bids[0].size if self.bids else 0.0

    @property
    def best_ask_size(self) -> float:
        return self.asks[0].size if self.asks else 0.0

    @property
    def mid(self) -> float | None:
        b, a = self.best_bid, self.best_ask
        if b is None or a is None:
            return None
        return (b + a) / 2.0

    @property
    def spread(self) -> float | None:
        b, a = self.best_bid, self.best_ask
        if b is None or a is None:
            return None
        return a - b

    @property
    def microprice(self) -> float | None:
        """Size-weighted top-of-book price: leans toward the thin side."""
        b, a = self.best_bid, self.best_ask
        if b is None or a is None:
            return None
        bs, as_ = self.best_bid_size, self.best_ask_size
        total = bs + as_
        if total <= 0:
            return (b + a) / 2.0
        return (b * as_ + a * bs) / total

    def depth(self, side: str, within: float = 0.05) -> float:
        """Resting *shares* within ``within`` of the touch on one side."""
        levels = self.bids if side == "bid" else self.asks
        if not levels:
            return 0.0
        anchor = levels[0].price
        total = 0.0
        for lvl in levels:
            if abs(lvl.price - anchor) > within:
                break
            total += lvl.size
        return total

    def notional_depth(self, side: str, within: float = 0.05) -> float:
        levels = self.bids if side == "bid" else self.asks
        if not levels:
            return 0.0
        anchor = levels[0].price
        total = 0.0
        for lvl in levels:
            if abs(lvl.price - anchor) > within:
                break
            total += lvl.size * lvl.price
        return total

    def imbalance(self, within: float = 0.05) -> float:
        """(bid - ask) / (bid + ask) depth imbalance in [-1, 1]."""
        b = self.depth("bid", within)
        a = self.depth("ask", within)
        if b + a <= 0:
            return 0.0
        return (b - a) / (b + a)

    def walk(self, side: Side, shares: float) -> tuple[float, float] | None:
        """Average execution price for a taker order of ``shares``.

        Returns ``(avg_price, filled_shares)`` or ``None`` when the book is
        empty on the relevant side.  A BUY consumes asks, a SELL consumes bids.
        """
        levels = self.asks if side is Side.BUY else self.bids
        if not levels or shares <= 0:
            return None
        remaining = shares
        cost = 0.0
        for lvl in levels:
            take = min(remaining, lvl.size)
            cost += take * lvl.price
            remaining -= take
            if remaining <= 1e-12:
                break
        filled = shares - remaining
        if filled <= 0:
            return None
        return cost / filled, filled

    def slippage(self, side: Side, shares: float) -> float | None:
        """Average fill price minus touch price (always >= 0)."""
        res = self.walk(side, shares)
        if res is None:
            return None
        avg, _ = res
        touch = self.best_ask if side is Side.BUY else self.best_bid
        if touch is None:
            return None
        return abs(avg - touch)

    def is_crossed(self) -> bool:
        b, a = self.best_bid, self.best_ask
        return b is not None and a is not None and b >= a

    def is_empty(self) -> bool:
        return not self.bids and not self.asks


@dataclass(slots=True)
class PublicTrade:
    token_id: str
    price: float
    size: float
    side: Side | None
    timestamp: float


# -------------------------------------------------------------- price feeds


@dataclass(slots=True)
class Tick:
    """One normalised price observation from a reference exchange."""

    exchange: str
    symbol: str
    asset: str
    price: float
    size: float
    timestamp: float          # exchange-provided, epoch seconds
    received_at: float        # local receipt, epoch seconds
    bid: float | None = None
    ask: float | None = None
    is_trade: bool = True

    @property
    def latency(self) -> float:
        return max(0.0, self.received_at - self.timestamp)


@dataclass(slots=True)
class CompositePrice:
    asset: str
    price: float
    timestamp: float
    contributors: dict[str, float]
    n_sources: int
    dispersion_bps: float
    is_healthy: bool
    reason: str = ""


@dataclass(slots=True)
class FeedHealth:
    name: str
    status: FeedStatus = FeedStatus.OFFLINE
    last_message_at: float = 0.0
    messages: int = 0
    messages_per_sec: float = 0.0
    reconnects: int = 0
    errors: int = 0
    latency_ms: float = 0.0
    clock_drift_ms: float = 0.0
    score: float = 0.0
    detail: str = ""


# ------------------------------------------------------------------ signals


@dataclass(slots=True)
class StrategySignal:
    """One strategy's view on a market.

    ``probability_up`` is the strategy's estimate of P(market resolves UP).
    ``confidence`` in [0,1] expresses how much the strategy trusts itself right
    now (data quality, regime fit, sample support).
    """

    strategy: str
    probability_up: float
    confidence: float
    reason: str = ""
    features_used: dict[str, float] = field(default_factory=dict)
    abstain: bool = False

    @property
    def direction(self) -> Outcome | None:
        if self.abstain:
            return None
        if self.probability_up > 0.5:
            return Outcome.UP
        if self.probability_up < 0.5:
            return Outcome.DOWN
        return None

    @property
    def strength(self) -> float:
        return abs(self.probability_up - 0.5) * 2.0


@dataclass(slots=True)
class MarketProbability:
    """What the Polymarket book implies, de-vigged across both outcomes."""

    implied_up: float
    implied_down: float
    raw_up_mid: float | None
    raw_down_mid: float | None
    vig: float
    source: str = "midpoint"


@dataclass(slots=True)
class Prediction:
    """Fused model output for one market at one point in time."""

    market_id: str
    asset: str
    timestamp: float
    probability_up: float
    probability_down: float
    confidence: float
    uncertainty: float
    regime: Regime
    signals: list[StrategySignal] = field(default_factory=list)
    features: dict[str, float] = field(default_factory=dict)
    analytic_probability_up: float | None = None
    ml_probability_up: float | None = None
    #: the ensemble's own probability, before it was anchored to the market
    unanchored_probability_up: float | None = None
    anchor_weight: float = 1.0
    calibrated: bool = False
    model_version: str = "n/a"

    def probability(self, outcome: Outcome) -> float:
        return self.probability_up if outcome is Outcome.UP else self.probability_down


@dataclass(slots=True)
class Opportunity:
    """A tradable (or rejected) idea with the full economics attached."""

    market: Market
    outcome: Outcome
    side: Side
    prediction: Prediction
    market_probability: MarketProbability
    entry_price: float            # price we would actually pay/receive
    model_probability: float
    gross_edge: float             # model prob - entry price
    fee_cost: float               # per share, in probability units
    slippage_cost: float
    net_edge: float
    expected_value_per_share: float
    size_shares: float
    notional: float
    expected_value: float
    decision: Decision
    score: float
    confidence: float
    regime: Regime
    reasons: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    book_state: dict[str, Any] = field(default_factory=dict)
    risk_state: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    opportunity_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])

    @property
    def is_tradable(self) -> bool:
        return self.decision.is_actionable and not self.blockers


# ------------------------------------------------------------------- orders


@dataclass(slots=True)
class OrderRequest:
    market_id: str
    condition_id: str
    token_id: str
    asset: str
    outcome: Outcome
    side: Side
    price: float
    size: float
    kind: OrderKind = OrderKind.GTC
    post_only: bool = False
    expiration: int | None = None
    client_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    opportunity_id: str | None = None
    created_at: float = field(default_factory=time.time)

    @property
    def notional(self) -> float:
        return self.price * self.size

    def idempotency_key(self) -> str:
        """Stable key that makes accidental duplicate submissions detectable."""
        return f"{self.token_id}:{self.side.value}:{self.price:.4f}:{self.size:.4f}:{self.client_id}"


@dataclass(slots=True)
class Fill:
    order_id: str
    client_id: str
    token_id: str
    side: Side
    price: float
    size: float
    fee: float
    timestamp: float
    is_maker: bool = False
    fill_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])


@dataclass(slots=True)
class OrderResult:
    request: OrderRequest
    state: OrderState
    order_id: str | None = None
    filled_size: float = 0.0
    avg_price: float = 0.0
    fees: float = 0.0
    fills: list[Fill] = field(default_factory=list)
    error: str | None = None
    submitted_at: float = field(default_factory=time.time)
    finalised_at: float | None = None

    @property
    def notional(self) -> float:
        return self.filled_size * self.avg_price

    @property
    def is_filled(self) -> bool:
        return self.filled_size > 0


# ---------------------------------------------------------------- positions


@dataclass(slots=True)
class Position:
    position_id: str
    market_id: str
    condition_id: str
    asset: str
    outcome: Outcome
    token_id: str
    size: float
    avg_price: float
    fees_paid: float
    opened_at: float
    window_end: float
    opportunity_id: str | None = None
    strategy: str = "ensemble"
    regime: str = "UNKNOWN"
    execution_style: str = ""
    entry_edge: float = 0.0
    entry_confidence: float = 0.0
    entry_model_prob: float = 0.0
    entry_market_prob: float = 0.0
    closed_at: float | None = None
    exit_price: float | None = None
    realized_pnl: float | None = None
    resolution: Outcome | None = None

    @property
    def cost_basis(self) -> float:
        return self.size * self.avg_price + self.fees_paid

    @property
    def is_open(self) -> bool:
        return self.closed_at is None

    def unrealized_pnl(self, current_price: float) -> float:
        return self.size * (current_price - self.avg_price) - self.fees_paid

    def settle(self, won: bool, at: float) -> float:
        payoff = self.size * (1.0 if won else 0.0)
        self.realized_pnl = payoff - self.size * self.avg_price - self.fees_paid
        self.closed_at = at
        self.exit_price = 1.0 if won else 0.0
        return self.realized_pnl


# ------------------------------------------------------------- risk / audit


@dataclass(slots=True)
class RiskState:
    bankroll: float
    equity: float
    peak_equity: float
    available: float
    open_exposure: float
    realized_pnl: float
    unrealized_pnl: float
    daily_pnl: float
    session_pnl: float
    open_positions: int
    consecutive_losses: int
    drawdown: float
    trading_paused: bool = False
    pause_reason: str = ""
    pause_until: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class RiskEvent:
    timestamp: float
    kind: str
    severity: str
    message: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Alert:
    timestamp: float
    level: str
    component: str
    message: str
    detail: dict[str, Any] = field(default_factory=dict)


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f
