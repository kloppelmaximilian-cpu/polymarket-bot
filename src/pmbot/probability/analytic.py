"""Analytic fair value for a 5-minute up/down market.

Market mechanics (verified from the market's own ``description`` and
``resolutionSource``): the market resolves **UP** if the oracle price at the end
of the 5-minute window is **greater than or equal to** the oracle price at the
start of that window; otherwise **DOWN**.  Ties therefore resolve UP.

So the contract is a *digital (binary) option* struck at the window-open price
``S`` and expiring at ``window_end``.  With ``P_t`` the current price, remaining
time ``tau`` and per-second log-return volatility ``sigma``:

    x    = ln(P_t / S) + mu * tau            (log-moneyness incl. drift)
    P(UP) = Phi( x / sqrt(sigma^2 * tau + sigma_basis^2) )

Two refinements matter in practice and are implemented here:

1. **Basis / measurement uncertainty.**  Resolution follows the market's own
   oracle (a Chainlink data stream for the crypto series).  When we track the
   price through a composite of centralised exchanges we are using a *proxy*,
   and the proxy-vs-oracle basis can move between the two snapshot instants.
   That uncertainty is added in quadrature as ``sigma_basis`` and it is what
   stops the model from printing 0.999 with ten seconds left -- which is where
   a naive implementation loses money.

2. **Drift shrinkage.**  Over 300 seconds the diffusive term dominates any
   plausible drift, so signal-implied drift is capped at a fraction of one
   standard deviation of the remaining move.  Without this cap a momentum
   signal can push the fair value far past anything the data supports.

The same formula inverted gives the *implied* log-moneyness (and hence the
implied strike or implied volatility) from the market's own price, which the
mispricing strategy uses as a cross-check.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SQRT2 = math.sqrt(2.0)
_MIN_SIGMA_TOTAL = 1e-9


def norm_cdf(x: float) -> float:
    """Standard normal CDF (erf-based; accurate and dependency-free)."""
    return 0.5 * (1.0 + math.erf(x / SQRT2))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation).

    Max relative error ~1.15e-9, which is far tighter than anything the inputs
    justify.
    """
    if p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf

    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00)

    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


@dataclass(frozen=True, slots=True)
class FairValueInputs:
    spot: float
    strike: float
    seconds_remaining: float
    sigma_per_sec: float
    drift_per_sec: float = 0.0
    sigma_basis: float = 0.0        # log-price std-dev of proxy-vs-oracle basis
    max_drift_sd_fraction: float = 0.35


@dataclass(frozen=True, slots=True)
class FairValue:
    probability_up: float
    log_moneyness: float
    z_score: float
    sigma_total: float
    drift_applied: float
    diffusive_sd: float
    basis_share: float          # fraction of total variance that is basis noise
    sensitivity: float          # d(prob)/d(log spot) -- the "delta"

    @property
    def probability_down(self) -> float:
        return 1.0 - self.probability_up


def fair_value(inputs: FairValueInputs) -> FairValue:
    """Price the digital.  Pure function -- no state, no I/O, fully testable."""
    spot = inputs.spot
    strike = inputs.strike
    if spot <= 0 or strike <= 0:
        raise ValueError("spot and strike must be positive")

    tau = max(inputs.seconds_remaining, 0.0)
    sigma = max(inputs.sigma_per_sec, 0.0)
    diffusive_var = sigma * sigma * tau
    basis_var = max(inputs.sigma_basis, 0.0) ** 2
    total_var = diffusive_var + basis_var
    sigma_total = math.sqrt(total_var) if total_var > 0 else 0.0

    raw_moneyness = math.log(spot / strike)

    # Shrink the drift so it can never dominate the diffusive term.
    drift_cap = inputs.max_drift_sd_fraction * max(sigma_total, _MIN_SIGMA_TOTAL)
    drift_term = inputs.drift_per_sec * tau
    drift_applied = max(-drift_cap, min(drift_cap, drift_term))

    x = raw_moneyness + drift_applied

    if sigma_total <= _MIN_SIGMA_TOTAL:
        # Degenerate: no time and no basis noise left. Ties resolve UP.
        prob = 1.0 if raw_moneyness >= 0.0 else 0.0
        return FairValue(
            probability_up=prob,
            log_moneyness=raw_moneyness,
            z_score=math.inf if raw_moneyness >= 0 else -math.inf,
            sigma_total=0.0,
            drift_applied=drift_applied,
            diffusive_sd=math.sqrt(diffusive_var),
            basis_share=0.0,
            sensitivity=0.0,
        )

    z = x / sigma_total
    prob = norm_cdf(z)
    sensitivity = norm_pdf(z) / sigma_total

    return FairValue(
        probability_up=prob,
        log_moneyness=raw_moneyness,
        z_score=z,
        sigma_total=sigma_total,
        drift_applied=drift_applied,
        diffusive_sd=math.sqrt(diffusive_var),
        basis_share=(basis_var / total_var) if total_var > 0 else 0.0,
        sensitivity=sensitivity,
    )


def probability_up(
    spot: float,
    strike: float,
    seconds_remaining: float,
    sigma_per_sec: float,
    drift_per_sec: float = 0.0,
    sigma_basis: float = 0.0,
) -> float:
    """Thin convenience wrapper around :func:`fair_value`."""
    return fair_value(
        FairValueInputs(
            spot=spot,
            strike=strike,
            seconds_remaining=seconds_remaining,
            sigma_per_sec=sigma_per_sec,
            drift_per_sec=drift_per_sec,
            sigma_basis=sigma_basis,
        )
    ).probability_up


def implied_log_moneyness(
    probability: float,
    seconds_remaining: float,
    sigma_per_sec: float,
    sigma_basis: float = 0.0,
) -> float:
    """Invert the pricer: what log-moneyness does a market price imply?"""
    p = min(max(probability, 1e-9), 1 - 1e-9)
    total_var = sigma_per_sec * sigma_per_sec * max(seconds_remaining, 0.0) + sigma_basis ** 2
    sigma_total = math.sqrt(max(total_var, 0.0))
    return norm_ppf(p) * sigma_total


def implied_strike(
    probability: float,
    spot: float,
    seconds_remaining: float,
    sigma_per_sec: float,
    sigma_basis: float = 0.0,
) -> float:
    """The strike the market's price is consistent with, given our vol."""
    x = implied_log_moneyness(probability, seconds_remaining, sigma_per_sec, sigma_basis)
    return spot * math.exp(-x)


def implied_volatility(
    probability: float,
    spot: float,
    strike: float,
    seconds_remaining: float,
    sigma_basis: float = 0.0,
) -> float | None:
    """Per-second volatility that makes the model agree with the market price.

    ``None`` when the market price is not attainable for any volatility (e.g.
    the market says 0.30 while spot is already above the strike, which no
    positive volatility can produce without drift).
    """
    tau = max(seconds_remaining, 0.0)
    if tau <= 0:
        return None
    p = min(max(probability, 1e-9), 1 - 1e-9)
    z = norm_ppf(p)
    x = math.log(spot / strike)
    if abs(z) < 1e-9:
        return None if abs(x) > 1e-12 else 0.0
    if (x > 0) != (z > 0):
        return None                      # sign mismatch: unattainable
    total_var_needed = (x / z) ** 2
    diffusive = total_var_needed - sigma_basis ** 2
    if diffusive <= 0:
        return None
    return math.sqrt(diffusive / tau)


def basis_sigma_from_bps(bps: float, n_snapshots: int = 2) -> float:
    """Convert a basis assumption in bps into a log-price standard deviation.

    The strike and the settlement price are two independent oracle snapshots,
    so with an i.i.d. basis assumption the *difference* carries sqrt(n) times
    the single-observation standard deviation.
    """
    single = max(bps, 0.0) * 1e-4
    return single * math.sqrt(max(n_snapshots, 1))
