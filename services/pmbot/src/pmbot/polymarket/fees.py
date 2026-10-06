"""Polymarket fee model.

Verified against the published schedule (``crypto_fees_v2``) and the fee fields
carried on the Gamma market object::

    fee = shares * fee_rate * p * (1 - p)

where ``p`` is the execution price of the share.  Only **takers** pay; makers
pay zero and share a rebate pool.  Because fees scale with ``p(1-p)`` they peak
at 50c (1.75c/share at rate 0.07) and vanish towards the extremes.

Everything here works in *per-share* units, which for a binary contract paying
$1 is the same unit as probability -- so a fee of 0.0175 is exactly 1.75
probability points of required edge.

The rebate is deliberately modelled as 0 by default: it is a pro-rata share of
a daily pool and cannot be relied upon for a per-trade edge calculation.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_CRYPTO_TAKER_RATE = 0.07
BPS = 1e-4


@dataclass(frozen=True, slots=True)
class FeeSchedule:
    """Fee parameters for one market."""

    taker_rate: float = DEFAULT_CRYPTO_TAKER_RATE
    maker_rate: float = 0.0
    rebate_rate: float = 0.0
    taker_only: bool = True
    enabled: bool = True
    fee_type: str = "crypto_fees_v2"

    def per_share(self, price: float, is_maker: bool = False) -> float:
        """Fee charged per share executed at ``price``."""
        if not self.enabled:
            return 0.0
        p = min(max(price, 0.0), 1.0)
        rate = self.maker_rate if is_maker else self.taker_rate
        if is_maker and self.taker_only:
            rate = 0.0
        return rate * p * (1.0 - p)

    def total(self, price: float, shares: float, is_maker: bool = False) -> float:
        """Total fee in USDC for ``shares`` executed at ``price``."""
        return self.per_share(price, is_maker) * max(shares, 0.0)

    def effective_rebate_per_share(self, price: float) -> float:
        """Expected maker rebate per share (0 unless explicitly configured)."""
        if not self.enabled or self.rebate_rate <= 0:
            return 0.0
        return self.rebate_rate * self.taker_rate * price * (1.0 - price)

    @classmethod
    def from_market_dict(
        cls,
        raw: dict,
        default_taker: float = DEFAULT_CRYPTO_TAKER_RATE,
        default_maker: float = 0.0,
        rebate_rate: float = 0.0,
    ) -> FeeSchedule:
        """Build a schedule from a Gamma market object.

        ``feeSchedule.rate`` governs modern crypto markets; the legacy
        ``takerBaseFee``/``makerBaseFee`` bps fields are only used as a fallback
        when no ``feeSchedule`` is present, because on crypto markets they carry
        a stale value (1000) that is *not* what is charged.
        """
        enabled = bool(raw.get("feesEnabled", True))
        schedule = raw.get("feeSchedule") or {}
        fee_type = str(raw.get("feeType") or ("legacy_bps" if not schedule else ""))

        if schedule:
            taker = _as_float(schedule.get("rate"), default_taker)
            taker_only = bool(schedule.get("takerOnly", True))
            maker = 0.0 if taker_only else _as_float(schedule.get("makerRate"), default_maker)
            return cls(
                taker_rate=taker,
                maker_rate=maker,
                rebate_rate=rebate_rate,
                taker_only=taker_only,
                enabled=enabled,
                fee_type=fee_type or "crypto_fees_v2",
            )

        taker_bps = _as_float(raw.get("takerBaseFee"), 0.0)
        maker_bps = _as_float(raw.get("makerBaseFee"), 0.0)
        return cls(
            taker_rate=taker_bps * BPS if taker_bps else default_taker,
            maker_rate=maker_bps * BPS,
            rebate_rate=rebate_rate,
            taker_only=maker_bps <= 0,
            enabled=enabled,
            fee_type=fee_type or "legacy_bps",
        )


def _as_float(value, default: float) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if f == f else default  # NaN guard


def breakeven_probability(price: float, schedule: FeeSchedule, is_maker: bool = False) -> float:
    """Model probability at which buying at ``price`` has exactly zero EV."""
    return price + schedule.per_share(price, is_maker)


def net_edge(
    model_probability: float,
    entry_price: float,
    schedule: FeeSchedule,
    slippage: float = 0.0,
    is_maker: bool = False,
) -> float:
    """Edge per share after fees and slippage, in probability units.

    ``entry_price`` must already be the price actually expected to be paid
    (i.e. the touch price); ``slippage`` is the *additional* average cost of
    walking the book for the intended size.
    """
    fee = schedule.per_share(entry_price + slippage, is_maker)
    return model_probability - entry_price - slippage - fee
