"""Risk engine.

Two jobs, kept separate on purpose:

* **Accounting** -- the single source of truth for bankroll, exposure, open
  positions and realised/unrealised P&L.  Nothing else in the system is allowed
  to compute equity.
* **Permission** -- a hard gate in front of every order.  Each limit is checked
  independently and the *first* breach blocks the trade, with a named reason
  that is logged and shown on the dashboard.

Kill switches latch: once a loss limit fires, trading pauses for a configured
cooldown rather than resuming on the next tick that happens to look better.
A losing streak is evidence about the model, and the model does not improve
because the next tick looked friendlier.

Infrastructure pauses do not latch. A reconnecting feed is directly
observable and self-clearing, so riding out a five-minute cooldown after it
recovers buys nothing -- and when feeds flap, a latching health pause keeps
the bot switched off almost permanently while every panel reads healthy.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime

from ..core.clock import Clock, default_clock
from ..core.types import (
    Fill,
    Market,
    Outcome,
    Position,
    RiskEvent,
    RiskState,
    Side,
)
from ..logging_setup import get_logger


@dataclass
class RiskLimits:
    max_stake_per_trade: float = 25.0
    max_stake_fraction: float = 0.02
    max_portfolio_exposure: float = 200.0
    max_simultaneous_positions: int = 6
    max_positions_per_asset: int = 2
    max_positions_per_market: int = 1
    max_asset_exposure: float = 100.0
    max_correlated_exposure: float = 150.0
    max_daily_loss: float = 100.0
    max_session_loss: float = 150.0
    max_consecutive_losses: int = 8
    max_drawdown: float = 0.25
    pause_seconds: float = 300.0
    min_order_notional: float = 1.0


@dataclass
class Reservation:
    """Capital committed to an order that has not filled yet.

    Without this, a resting maker order is invisible to the risk engine: the
    next cycle sees no position, passes every limit, and places a *second*
    order on the same market.  Both then fill and the position is double the
    intended size -- the classic way a correct-looking sizing function still
    over-bets.
    """

    key: str
    market_id: str
    asset: str
    outcome: str
    notional: float
    created_at: float


@dataclass
class TradeDecisionCheck:
    allowed: bool
    reason: str = ""
    limit: str = ""

    def __bool__(self) -> bool:
        return self.allowed


ALLOWED = TradeDecisionCheck(True)


class RiskEngine:
    def __init__(
        self,
        limits: RiskLimits,
        starting_bankroll: float,
        clock: Clock | None = None,
        correlation_buckets: dict[str, str] | None = None,
    ):
        self.limits = limits
        self.clock = clock or default_clock()
        self.log = get_logger("pmbot.risk")

        self.starting_bankroll = starting_bankroll
        self.realized_pnl = 0.0
        self.fees_paid = 0.0
        self.peak_equity = starting_bankroll

        self.positions: dict[str, Position] = {}
        self.closed_positions: list[Position] = []
        self.reservations: dict[str, Reservation] = {}
        self.consecutive_losses = 0
        self.events: deque[RiskEvent] = deque(maxlen=500)

        self._session_start = self.clock.time()
        self._day_key = self._current_day()
        self._daily_start_pnl = 0.0
        self._paused_until = 0.0
        self._pause_reason = ""
        #: A latched pause must run its full cooldown. An unlatched one is
        #: cleared the moment the condition that caused it goes away.
        self._pause_latched = True
        # All crypto is one correlation bucket unless told otherwise.
        self._buckets = correlation_buckets or {}
        self._last_marks: dict[str, float] = {}

    # ------------------------------------------------------------ accounting
    def _current_day(self) -> str:
        return datetime.fromtimestamp(self.clock.time(), tz=UTC).strftime("%Y-%m-%d")

    def _roll_day_if_needed(self) -> None:
        today = self._current_day()
        if today != self._day_key:
            self._day_key = today
            self._daily_start_pnl = self.realized_pnl
            self.log.info("risk day rolled", extra={"day": today})

    def bucket(self, asset: str) -> str:
        return self._buckets.get(asset.upper(), "CRYPTO")

    @property
    def position_exposure(self) -> float:
        """Capital at risk in filled positions."""
        return sum(p.size * p.avg_price for p in self.positions.values())

    @property
    def reserved_exposure(self) -> float:
        """Capital committed to orders that have not filled yet."""
        return sum(r.notional for r in self.reservations.values())

    @property
    def open_exposure(self) -> float:
        """Total committed capital: filled positions plus working orders."""
        return self.position_exposure + self.reserved_exposure

    # ------------------------------------------------------------ reservations
    def reserve(
        self,
        key: str,
        market_id: str,
        asset: str,
        outcome: Outcome,
        notional: float,
    ) -> Reservation:
        reservation = Reservation(
            key=key, market_id=market_id, asset=asset, outcome=outcome.value,
            notional=max(notional, 0.0), created_at=self.clock.time(),
        )
        self.reservations[key] = reservation
        return reservation

    def release(self, key: str) -> Reservation | None:
        return self.reservations.pop(key, None)

    def release_stale_reservations(self, max_age: float = 120.0) -> int:
        """Safety net: a reservation whose order vanished must not leak."""
        now = self.clock.time()
        stale = [k for k, r in self.reservations.items() if now - r.created_at > max_age]
        for key in stale:
            self.reservations.pop(key, None)
        return len(stale)

    def has_commitment(self, market_id: str, outcome: Outcome | None = None) -> bool:
        """Is there already a position or a working order on this market?"""
        for position in self.positions.values():
            if position.market_id == market_id and (
                outcome is None or position.outcome is outcome
            ):
                return True
        for reservation in self.reservations.values():
            if reservation.market_id == market_id and (
                outcome is None or reservation.outcome == outcome.value
            ):
                return True
        return False

    def unrealized_pnl(self, marks: dict[str, float] | None = None) -> float:
        marks = marks or self._last_marks
        total = 0.0
        for position in self.positions.values():
            mark = marks.get(position.token_id)
            if mark is None:
                mark = position.avg_price       # no mark: assume flat, not a gain
            total += position.size * (mark - position.avg_price)
        return total

    def set_marks(self, marks: dict[str, float]) -> None:
        self._last_marks.update(marks)

    @property
    def bankroll(self) -> float:
        """Cash: starting capital plus realised P&L, minus what is tied up."""
        return self.starting_bankroll + self.realized_pnl

    @property
    def available(self) -> float:
        return max(0.0, self.bankroll - self.open_exposure)

    def equity(self, marks: dict[str, float] | None = None) -> float:
        return self.bankroll + self.unrealized_pnl(marks)

    @property
    def daily_pnl(self) -> float:
        self._roll_day_if_needed()
        return self.realized_pnl - self._daily_start_pnl

    @property
    def session_pnl(self) -> float:
        return self.realized_pnl

    def drawdown(self, marks: dict[str, float] | None = None) -> float:
        equity = self.equity(marks)
        self.peak_equity = max(self.peak_equity, equity)
        if self.peak_equity <= 0:
            return 0.0
        return max(0.0, (self.peak_equity - equity) / self.peak_equity)

    def state(self, marks: dict[str, float] | None = None) -> RiskState:
        now = self.clock.time()
        return RiskState(
            bankroll=self.bankroll,
            equity=self.equity(marks),
            peak_equity=self.peak_equity,
            available=self.available,
            open_exposure=self.open_exposure,
            realized_pnl=self.realized_pnl,
            unrealized_pnl=self.unrealized_pnl(marks),
            daily_pnl=self.daily_pnl,
            session_pnl=self.session_pnl,
            open_positions=len(self.positions),
            consecutive_losses=self.consecutive_losses,
            drawdown=self.drawdown(marks),
            trading_paused=self.is_paused(now),
            pause_reason=self._pause_reason,
            pause_until=self._paused_until,
        )

    # --------------------------------------------------------------- pausing
    def is_paused(self, now: float | None = None) -> bool:
        now = self.clock.time() if now is None else now
        if self._paused_until <= 0:
            return False
        if now >= self._paused_until:
            self._paused_until = 0.0
            self._pause_reason = ""
            self._pause_latched = True
            self.log.info("risk pause expired")
            return False
        return True

    def pause(
        self,
        reason: str,
        seconds: float | None = None,
        severity: str = "warning",
        latch: bool = True,
    ) -> None:
        """Stop trading.

        ``latch=False`` marks the pause as caused by a transient condition the
        caller is watching, so :meth:`clear_transient_pause` may lift it early.
        A latched pause always outranks an unlatched one: a loss stop that
        fires during a feed outage is not cancelled when the feed returns.
        """
        duration = self.limits.pause_seconds if seconds is None else seconds
        now = self.clock.time()
        # Read the existing pause before extending it, or every pause looks
        # like it arrived on top of an active one.
        was_latched = self.is_paused(now) and self._pause_latched
        self._paused_until = max(self._paused_until, now + duration)
        self._pause_reason = reason
        self._pause_latched = latch or was_latched
        self.record_event(
            "trading_pause", severity, reason,
            {"seconds": duration, "latched": self._pause_latched},
        )
        self.log.warning(
            "trading paused",
            extra={"reason": reason, "seconds": duration,
                   "latched": self._pause_latched},
        )

    def clear_transient_pause(self, reason: str = "condition cleared") -> bool:
        """Lift an unlatched pause once its cause is gone. True if lifted."""
        if self._pause_latched or not self.is_paused():
            return False
        self.log.info("trading resumed", extra={"reason": reason})
        self.resume(reason)
        return True

    def resume(self, reason: str = "manual") -> None:
        self._paused_until = 0.0
        self._pause_reason = ""
        self._pause_latched = True
        self.record_event("trading_resume", "info", reason)

    def record_event(
        self, kind: str, severity: str, message: str, detail: dict | None = None
    ) -> RiskEvent:
        event = RiskEvent(
            timestamp=self.clock.time(), kind=kind, severity=severity,
            message=message, detail=detail or {},
        )
        self.events.append(event)
        return event

    # ------------------------------------------------------------ permission
    def evaluate_stops(self, marks: dict[str, float] | None = None) -> TradeDecisionCheck:
        """Evaluate the latching loss/drawdown stops and pause if any has fired.

        Called both before every order and immediately after each settlement, so
        a breached limit is visible on the dashboard the moment it happens
        rather than only when the next order is attempted.
        """
        if self.daily_pnl <= -abs(self.limits.max_daily_loss):
            self.pause(
                f"daily loss limit hit ({self.daily_pnl:.2f})", severity="critical",
            )
            return TradeDecisionCheck(False, "daily loss limit", "max_daily_loss")

        if self.session_pnl <= -abs(self.limits.max_session_loss):
            self.pause(
                f"session loss limit hit ({self.session_pnl:.2f})", severity="critical",
            )
            return TradeDecisionCheck(False, "session loss limit", "max_session_loss")

        if self.consecutive_losses >= self.limits.max_consecutive_losses:
            self.pause(
                f"{self.consecutive_losses} consecutive losses", severity="critical",
            )
            return TradeDecisionCheck(False, "consecutive losses", "max_consecutive_losses")

        dd = self.drawdown(marks)
        if dd >= self.limits.max_drawdown:
            self.pause(f"max drawdown {dd:.1%}", severity="critical")
            return TradeDecisionCheck(False, f"drawdown {dd:.1%}", "max_drawdown")

        return ALLOWED

    def check_system(self, marks: dict[str, float] | None = None) -> TradeDecisionCheck:
        """Portfolio-level gates that do not depend on the specific trade."""
        if self.is_paused():
            return TradeDecisionCheck(False, f"trading paused: {self._pause_reason}", "pause")

        stops = self.evaluate_stops(marks)
        if not stops:
            return stops

        if self.available <= self.limits.min_order_notional:
            return TradeDecisionCheck(False, "no available capital", "available")

        return ALLOWED

    def check_trade(
        self,
        market: Market,
        outcome: Outcome,
        notional: float,
        marks: dict[str, float] | None = None,
    ) -> TradeDecisionCheck:
        """Per-trade gates.  Called immediately before an order is built."""
        system = self.check_system(marks)
        if not system:
            return system

        if notional < self.limits.min_order_notional:
            return TradeDecisionCheck(
                False, f"notional {notional:.2f} below minimum", "min_order_notional"
            )
        if notional > self.limits.max_stake_per_trade + 1e-9:
            return TradeDecisionCheck(
                False, f"notional {notional:.2f} over per-trade cap", "max_stake_per_trade"
            )
        if notional > self.available + 1e-9:
            return TradeDecisionCheck(False, "insufficient capital", "available")

        fraction = notional / self.bankroll if self.bankroll > 0 else 1.0
        if fraction > self.limits.max_stake_fraction + 1e-9:
            return TradeDecisionCheck(
                False, f"stake {fraction:.2%} over bankroll fraction cap",
                "max_stake_fraction",
            )

        # Every count below includes working orders, not just filled positions.
        open_slots = len(self.positions) + len(self.reservations)
        if open_slots >= self.limits.max_simultaneous_positions:
            return TradeDecisionCheck(
                False, f"{open_slots} positions/orders already open",
                "max_simultaneous_positions",
            )

        in_market = sum(
            1 for p in self.positions.values() if p.market_id == market.market_id
        ) + sum(
            1 for r in self.reservations.values() if r.market_id == market.market_id
        )
        if in_market >= self.limits.max_positions_per_market:
            return TradeDecisionCheck(
                False, "already committed to this market", "max_positions_per_market"
            )

        in_asset = sum(
            1 for p in self.positions.values() if p.asset == market.asset
        ) + sum(1 for r in self.reservations.values() if r.asset == market.asset)
        if in_asset >= self.limits.max_positions_per_asset:
            return TradeDecisionCheck(
                False, f"{in_asset} positions already in {market.asset}",
                "max_positions_per_asset",
            )

        if self.open_exposure + notional > self.limits.max_portfolio_exposure + 1e-9:
            return TradeDecisionCheck(
                False, "portfolio exposure cap", "max_portfolio_exposure"
            )

        asset_exposure = sum(
            p.size * p.avg_price for p in self.positions.values() if p.asset == market.asset
        ) + sum(
            r.notional for r in self.reservations.values() if r.asset == market.asset
        )
        if asset_exposure + notional > self.limits.max_asset_exposure + 1e-9:
            return TradeDecisionCheck(
                False, f"{market.asset} exposure cap", "max_asset_exposure"
            )

        bucket = self.bucket(market.asset)
        bucket_exposure = sum(
            p.size * p.avg_price for p in self.positions.values()
            if self.bucket(p.asset) == bucket
        ) + sum(
            r.notional for r in self.reservations.values()
            if self.bucket(r.asset) == bucket
        )
        if bucket_exposure + notional > self.limits.max_correlated_exposure + 1e-9:
            return TradeDecisionCheck(
                False, f"correlated ({bucket}) exposure cap", "max_correlated_exposure"
            )

        return ALLOWED

    # ------------------------------------------------------------- positions
    def open_position(
        self,
        market: Market,
        outcome: Outcome,
        fills: list[Fill],
        opportunity_id: str | None = None,
        strategy: str = "ensemble",
        regime: str = "UNKNOWN",
        execution_style: str = "",
        entry_edge: float = 0.0,
        entry_confidence: float = 0.0,
        entry_model_prob: float = 0.0,
        entry_market_prob: float = 0.0,
    ) -> Position | None:
        """Register (or add to) a position from executed fills."""
        buys = [f for f in fills if f.side is Side.BUY and f.size > 0]
        if not buys:
            return None
        size = sum(f.size for f in buys)
        cost = sum(f.size * f.price for f in buys)
        fees = sum(f.fee for f in buys)
        avg_price = cost / size if size > 0 else 0.0

        key = f"{market.market_id}:{outcome.value}"
        existing = self.positions.get(key)
        if existing is not None:
            # Adding to a position must not quietly exceed the per-trade cap:
            # that is the failure mode a partial fill followed by a re-quote
            # produces.
            combined = existing.size * existing.avg_price + cost
            if combined > self.limits.max_stake_per_trade * 1.5:
                self.record_event(
                    "position_cap_exceeded", "warning",
                    f"add-on would take {market.market_id} to {combined:.2f}, "
                    f"over 1.5x the per-trade cap",
                    {"market_id": market.market_id, "combined": combined},
                )
            total_size = existing.size + size
            existing.avg_price = (
                (existing.size * existing.avg_price + cost) / total_size
                if total_size > 0 else existing.avg_price
            )
            existing.size = total_size
            existing.fees_paid += fees
            self.fees_paid += fees
            return existing

        position = Position(
            position_id=key,
            market_id=market.market_id,
            condition_id=market.condition_id,
            asset=market.asset,
            outcome=outcome,
            token_id=market.token_id(outcome),
            size=size,
            avg_price=avg_price,
            fees_paid=fees,
            opened_at=self.clock.time(),
            window_end=market.window_end,
            opportunity_id=opportunity_id,
            strategy=strategy,
            regime=regime,
            execution_style=execution_style,
            entry_edge=entry_edge,
            entry_confidence=entry_confidence,
            entry_model_prob=entry_model_prob,
            entry_market_prob=entry_market_prob,
        )
        self.positions[key] = position
        self.fees_paid += fees
        self.log.info(
            "position opened",
            extra={
                "market": market.market_id, "asset": market.asset,
                "outcome": outcome.value, "size": round(size, 2),
                "avg_price": round(avg_price, 4), "fees": round(fees, 4),
            },
        )
        return position

    def settle_position(
        self, position_id: str, resolved_outcome: Outcome, at: float | None = None
    ) -> Position | None:
        """Settle at resolution: the winning token pays $1, the loser $0."""
        position = self.positions.pop(position_id, None)
        if position is None:
            return None
        at = self.clock.time() if at is None else at
        won = position.outcome is resolved_outcome
        pnl = position.settle(won, at)
        position.resolution = resolved_outcome
        self.realized_pnl += pnl
        self.closed_positions.append(position)

        if pnl < 0:
            self.consecutive_losses += 1
        else:
            self.consecutive_losses = 0

        self._roll_day_if_needed()
        self.peak_equity = max(self.peak_equity, self.equity())
        self.evaluate_stops()
        self.log.info(
            "position settled",
            extra={
                "market": position.market_id, "asset": position.asset,
                "outcome": position.outcome.value, "resolved": resolved_outcome.value,
                "won": won, "pnl": round(pnl, 4),
                "consecutive_losses": self.consecutive_losses,
            },
        )
        return position

    def close_position_at_price(
        self, position_id: str, price: float, fee: float = 0.0, at: float | None = None
    ) -> Position | None:
        """Exit early by selling into the book rather than holding to expiry."""
        position = self.positions.pop(position_id, None)
        if position is None:
            return None
        at = self.clock.time() if at is None else at
        proceeds = position.size * price - fee
        pnl = proceeds - position.size * position.avg_price - position.fees_paid
        position.realized_pnl = pnl
        position.closed_at = at
        position.exit_price = price
        position.fees_paid += fee
        self.realized_pnl += pnl
        self.fees_paid += fee
        self.closed_positions.append(position)
        if pnl < 0:
            self.consecutive_losses += 1
        else:
            self.consecutive_losses = 0
        self.peak_equity = max(self.peak_equity, self.equity())
        self.evaluate_stops()
        return position

    def position_for(self, market_id: str, outcome: Outcome) -> Position | None:
        return self.positions.get(f"{market_id}:{outcome.value}")

    def positions_for_market(self, market_id: str) -> list[Position]:
        return [p for p in self.positions.values() if p.market_id == market_id]

    # ------------------------------------------------------------ statistics
    def stats(self) -> dict:
        closed = [p for p in self.closed_positions if p.realized_pnl is not None]
        wins = [p for p in closed if (p.realized_pnl or 0) > 0]
        losses = [p for p in closed if (p.realized_pnl or 0) <= 0]
        gross_win = sum(p.realized_pnl or 0.0 for p in wins)
        gross_loss = -sum(p.realized_pnl or 0.0 for p in losses)
        session_hours = max((self.clock.time() - self._session_start) / 3600.0, 1e-9)
        return {
            "trades": len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": len(wins) / len(closed) if closed else 0.0,
            "realized_pnl": self.realized_pnl,
            "fees_paid": self.fees_paid,
            "avg_win": gross_win / len(wins) if wins else 0.0,
            "avg_loss": gross_loss / len(losses) if losses else 0.0,
            "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else float("inf")
            if gross_win > 0 else 0.0,
            "expectancy": self.realized_pnl / len(closed) if closed else 0.0,
            "trades_per_hour": len(closed) / session_hours,
            "session_hours": session_hours,
            "max_drawdown": self.drawdown(),
            "consecutive_losses": self.consecutive_losses,
        }

    def strategy_stats(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for position in self.closed_positions:
            if position.realized_pnl is None:
                continue
            row = out.setdefault(position.strategy, {
                "trades": 0, "wins": 0, "pnl": 0.0, "edge_sum": 0.0,
                "worst": 0.0, "equity": 0.0, "peak": 0.0, "max_dd": 0.0,
            })
            row["trades"] += 1
            row["pnl"] += position.realized_pnl
            row["edge_sum"] += position.entry_edge
            if position.realized_pnl > 0:
                row["wins"] += 1
            row["worst"] = min(row["worst"], position.realized_pnl)
            row["equity"] += position.realized_pnl
            row["peak"] = max(row["peak"], row["equity"])
            row["max_dd"] = max(row["max_dd"], row["peak"] - row["equity"])
        for row in out.values():
            n = max(row["trades"], 1)
            row["win_rate"] = row["wins"] / n
            row["expectancy"] = row["pnl"] / n
            row["avg_edge"] = row["edge_sum"] / n
        return out
