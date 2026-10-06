"""Market resolution.

The 5-minute crypto markets resolve **UP** when the oracle price at
``window_end`` is greater than or equal to the oracle price at ``window_start``
(ties resolve UP), where the oracle is the data stream named in the market's own
``resolutionSource`` -- for the crypto series, a Chainlink price stream.

That matters enormously for honesty about what this bot knows.  When the bot
tracks the price through a composite of centralised exchanges it is using a
*proxy* for that oracle.  The proxy is excellent for prediction (the two track
each other to a couple of basis points), but it is not authoritative for
settlement.  So resolution uses a strict source hierarchy:

1. ``market_resolved`` from the Polymarket websocket -- authoritative.
2. Gamma reporting the market closed with a decided ``outcomePrices`` --
   authoritative.
3. Local computation from the composite proxy -- **provisional**.

Provisional resolutions are labelled as such, used for paper settlement so the
bot can keep learning without waiting, and *reconciled* against the
authoritative answer when it arrives.  The disagreement rate between the two is
tracked and surfaced, because it is the single best empirical measure of how
much basis risk the proxy carries.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .core.types import Market, Outcome
from .logging_setup import get_logger


class ResolutionSource(str, Enum):
    WEBSOCKET = "websocket"
    GAMMA = "gamma"
    LOCAL_PROXY = "local_proxy"


@dataclass
class Resolution:
    market_id: str
    outcome: Outcome
    source: ResolutionSource
    at: float
    strike: float | None = None
    settle: float | None = None
    provisional: bool = False
    detail: str = ""

    @property
    def is_authoritative(self) -> bool:
        return self.source in (ResolutionSource.WEBSOCKET, ResolutionSource.GAMMA)


@dataclass
class ReconciliationStats:
    """How often the proxy agreed with the authoritative outcome."""

    compared: int = 0
    agreed: int = 0
    disagreed: int = 0
    disagreements: list[dict] = field(default_factory=list)

    @property
    def agreement_rate(self) -> float:
        return self.agreed / self.compared if self.compared else 0.0

    def as_dict(self) -> dict:
        return {
            "compared": self.compared, "agreed": self.agreed,
            "disagreed": self.disagreed,
            "agreement_rate": round(self.agreement_rate, 4),
        }


class ResolutionTracker:
    def __init__(self, tie_resolves_up: bool = True, settle_tolerance: float = 3.0):
        self.tie_resolves_up = tie_resolves_up
        self.settle_tolerance = settle_tolerance
        self.log = get_logger("pmbot.resolution")
        self.resolutions: dict[str, Resolution] = {}
        self.reconciliation = ReconciliationStats()

    # --------------------------------------------------------------- record
    def record(self, resolution: Resolution) -> Resolution:
        """Store a resolution, upgrading a provisional one when truth arrives."""
        existing = self.resolutions.get(resolution.market_id)
        if existing is None:
            self.resolutions[resolution.market_id] = resolution
            return resolution

        if existing.is_authoritative and not resolution.is_authoritative:
            return existing              # never downgrade

        if not existing.is_authoritative and resolution.is_authoritative:
            self.reconciliation.compared += 1
            if existing.outcome is resolution.outcome:
                self.reconciliation.agreed += 1
            else:
                self.reconciliation.disagreed += 1
                self.reconciliation.disagreements.append({
                    "market_id": resolution.market_id,
                    "proxy": existing.outcome.value,
                    "authoritative": resolution.outcome.value,
                    "strike": existing.strike,
                    "settle": existing.settle,
                })
                self.log.warning(
                    "proxy resolution disagreed with the venue",
                    extra={
                        "market": resolution.market_id,
                        "proxy": existing.outcome.value,
                        "authoritative": resolution.outcome.value,
                        "agreement_rate": round(self.reconciliation.agreement_rate, 4),
                    },
                )
            resolution.strike = resolution.strike or existing.strike
            resolution.settle = resolution.settle or existing.settle

        self.resolutions[resolution.market_id] = resolution
        return resolution

    def get(self, market_id: str) -> Resolution | None:
        return self.resolutions.get(market_id)

    def forget(self, market_ids: list[str]) -> None:
        for market_id in market_ids:
            self.resolutions.pop(market_id, None)

    # ------------------------------------------------------------- sources
    def from_websocket(
        self, market: Market, winning_token_or_outcome: str, now: float
    ) -> Resolution | None:
        outcome = market.outcome_of(winning_token_or_outcome)
        if outcome is None:
            label = str(winning_token_or_outcome).strip().lower()
            if label in ("up", "yes"):
                outcome = Outcome.UP
            elif label in ("down", "no"):
                outcome = Outcome.DOWN
            else:
                return None
        return self.record(Resolution(
            market_id=market.market_id, outcome=outcome,
            source=ResolutionSource.WEBSOCKET, at=now,
            detail="market_resolved event",
        ))

    def from_gamma(self, market: Market, raw: dict, now: float) -> Resolution | None:
        """Read a decided outcome out of a Gamma market payload."""
        from .polymarket.parsers import as_bool, loads_maybe

        if not as_bool(raw.get("closed"), False):
            return None
        prices = loads_maybe(raw.get("outcomePrices"))
        outcomes = loads_maybe(raw.get("outcomes"))
        if not isinstance(prices, list) or not isinstance(outcomes, list):
            return None
        if len(prices) != len(outcomes):
            return None

        from .polymarket.parsers import classify_outcome

        best: tuple[float, Outcome] | None = None
        for label, price in zip(outcomes, prices, strict=True):
            try:
                value = float(price)
            except (TypeError, ValueError):
                continue
            mapped = classify_outcome(str(label))
            if mapped is None:
                continue
            if best is None or value > best[0]:
                best = (value, mapped)
        # A decided market pays 1/0; anything in between is not yet settled.
        if best is None or best[0] < 0.99:
            return None
        return self.record(Resolution(
            market_id=market.market_id, outcome=best[1],
            source=ResolutionSource.GAMMA, at=now,
            detail="gamma outcomePrices",
        ))

    def from_proxy(
        self, market: Market, strike: float, settle: float, now: float
    ) -> Resolution | None:
        """Provisional resolution from the composite reference price."""
        if strike <= 0 or settle <= 0:
            return None
        up = settle >= strike if self.tie_resolves_up else settle > strike
        return self.record(Resolution(
            market_id=market.market_id,
            outcome=Outcome.UP if up else Outcome.DOWN,
            source=ResolutionSource.LOCAL_PROXY, at=now,
            strike=strike, settle=settle, provisional=True,
            detail=f"proxy {settle:.6g} vs strike {strike:.6g}",
        ))
