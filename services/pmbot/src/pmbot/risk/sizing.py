"""Position sizing.

For a binary contract bought at price ``p`` that pays $1, staking ``p`` per
share, the Kelly-optimal fraction of bankroll to stake given true probability
``q`` is

    f* = (q - p) / (1 - p)

(the standard Kelly result with odds ``b = (1-p)/p``).  Three modifications are
applied, all of them in the conservative direction:

1. **Fees enter the price.**  ``p`` becomes ``p + fee_per_share + slippage``, so
   the size shrinks as execution gets worse -- which is exactly when it should.
2. **Uncertainty shrinks the edge.**  We size on a lower confidence bound
   ``q - k*sigma_q`` rather than the point estimate.  Kelly is notoriously
   sensitive to over-estimated edge; sizing on the point estimate is the single
   most common way a mathematically sound system blows up.
3. **Hard caps dominate.**  A fraction of Kelly, a fraction of bankroll, an
   absolute per-trade cap and the venue's own minimum size are all applied
   afterwards.

There is deliberately **no** Martingale, no loss-doubling, and no averaging
down: size is a function of edge and bankroll only, never of recent results
except through the bankroll itself.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SizingInputs:
    model_probability: float
    entry_price: float
    fee_per_share: float
    slippage: float
    uncertainty: float
    bankroll: float
    available: float
    kelly_fraction: float = 0.25
    uncertainty_multiple: float = 1.0
    max_stake_fraction: float = 0.02
    max_stake_absolute: float = 25.0
    min_notional: float = 1.0
    min_shares: float = 5.0
    tick_size: float = 0.01
    max_shares_from_book: float | None = None


@dataclass(frozen=True, slots=True)
class SizingResult:
    shares: float
    notional: float
    stake_fraction: float
    kelly_fraction_raw: float
    conservative_probability: float
    effective_price: float
    binding_constraint: str

    @property
    def is_tradable(self) -> bool:
        return self.shares > 0 and self.notional > 0


def kelly_fraction(probability: float, price: float) -> float:
    """Full-Kelly stake fraction for a $1-payout binary at ``price``."""
    if not 0.0 < price < 1.0:
        return 0.0
    return (probability - price) / (1.0 - price)


def size_position(inputs: SizingInputs, method: str = "kelly") -> SizingResult:
    """Compute a position size, reporting which constraint bound it."""
    price = inputs.entry_price
    if not 0.0 < price < 1.0:
        return _empty("invalid entry price", price)

    effective_price = min(
        price + max(inputs.fee_per_share, 0.0) + max(inputs.slippage, 0.0), 0.9999
    )

    # Conservative probability: a lower confidence bound on our own estimate.
    conservative = inputs.model_probability - inputs.uncertainty_multiple * inputs.uncertainty
    conservative = min(max(conservative, 0.0), 1.0)

    raw_kelly = kelly_fraction(conservative, effective_price)
    if raw_kelly <= 0:
        return _empty("no edge after fees and uncertainty", effective_price, raw_kelly, conservative)

    if method == "kelly":
        fraction = raw_kelly * inputs.kelly_fraction
    elif method == "edge_proportional":
        edge = conservative - effective_price
        fraction = min(edge * 2.0, 1.0) * inputs.max_stake_fraction
    else:                                     # "fixed"
        fraction = inputs.max_stake_fraction

    binding = "kelly"
    if fraction > inputs.max_stake_fraction:
        fraction, binding = inputs.max_stake_fraction, "max_stake_fraction"

    stake = fraction * max(inputs.bankroll, 0.0)
    if stake > inputs.max_stake_absolute:
        stake, binding = inputs.max_stake_absolute, "max_stake_per_trade"
    if stake > inputs.available:
        stake, binding = max(inputs.available, 0.0), "available_capital"

    if stake < inputs.min_notional:
        return _empty(
            f"stake {stake:.2f} below min notional {inputs.min_notional:.2f}",
            effective_price, raw_kelly, conservative,
        )

    shares = stake / price
    if inputs.max_shares_from_book is not None and shares > inputs.max_shares_from_book:
        shares, binding = inputs.max_shares_from_book, "book_depth"

    # The venue enforces a minimum share count; rounding is down so we never
    # exceed a cap by accident.
    shares = math.floor(shares * 100.0) / 100.0
    if shares < inputs.min_shares:
        return _empty(
            f"shares {shares:.2f} below venue minimum {inputs.min_shares:.2f}",
            effective_price, raw_kelly, conservative,
        )

    notional = shares * price
    return SizingResult(
        shares=shares,
        notional=notional,
        stake_fraction=notional / inputs.bankroll if inputs.bankroll > 0 else 0.0,
        kelly_fraction_raw=raw_kelly,
        conservative_probability=conservative,
        effective_price=effective_price,
        binding_constraint=binding,
    )


def _empty(
    reason: str, price: float = 0.0, kelly: float = 0.0, conservative: float = 0.0
) -> SizingResult:
    return SizingResult(
        shares=0.0, notional=0.0, stake_fraction=0.0,
        kelly_fraction_raw=kelly, conservative_probability=conservative,
        effective_price=price, binding_constraint=reason,
    )


def max_shares_for_slippage(
    book_walk, max_slippage: float, touch_price: float, upper_bound: float = 10_000.0
) -> float:
    """Largest order size whose average fill stays within ``max_slippage``.

    ``book_walk`` is a callable ``shares -> (avg_price, filled)``.  Solved by
    bisection because the book is a step function, not something differentiable.
    """
    if max_slippage <= 0:
        return 0.0
    lo, hi = 0.0, upper_bound
    result = book_walk(hi)
    if result is not None and abs(result[0] - touch_price) <= max_slippage:
        return result[1]
    for _ in range(40):
        mid = (lo + hi) / 2.0
        result = book_walk(mid)
        if result is None or result[1] <= 0:
            hi = mid
            continue
        if abs(result[0] - touch_price) <= max_slippage:
            lo = mid
        else:
            hi = mid
        if hi - lo < 0.01:
            break
    return lo
