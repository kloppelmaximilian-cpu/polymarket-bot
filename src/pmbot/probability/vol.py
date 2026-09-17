"""Realized-volatility estimation under microstructure noise.

The digital pricer needs the volatility of the *efficient* price over the next
few minutes.  What we observe instead is the efficient price plus observation
noise: each exchange's quote wobbles by a basis point or two around the true
value, and the composite inherits a reduced version of that.

At one-second sampling this matters enormously.  BTC at 50% annualised vol moves
about **0.9 bps per second**, while per-observation noise is of the same order.
Naive realized variance therefore measures mostly noise:

    RV_observed  ≈  sigma_true^2 + 2 * sigma_noise^2   (per sampling interval)

and feeding that into a digital pricer pushes every probability toward 0.50 --
the model becomes systematically under-confident, which shows up as a *negative*
Brier skill against a market maker who knows the true volatility.  That failure
was visible in this project's own engine-validation run before this estimator
was corrected.

Two standard corrections are applied and combined:

* **Autocovariance correction.**  For i.i.d. noise on a martingale price, the
  first-order autocovariance of returns is ``-sigma_noise^2`` exactly (the noise
  at time *i* enters return *i* positively and return *i+1* negatively).  So a
  negative sample autocovariance is a direct estimate of the noise variance.
* **Two-scale realized variance** (Zhang, Mykland & Aït-Sahalia, 2005).  Coarse
  K-step returns dilute the noise by a factor of K; combining the coarse and
  fine estimates cancels the leading bias:

      TSRV = (RV_coarse - RV_fine / K) / (1 - 1/K)

Both estimators are computed on a regular one-second grid, which also makes the
result independent of how often each venue happens to print.  A jump-robust
bipower estimate is kept alongside them to detect news-like moves, and an EWMA
of the *corrected* variance provides the responsiveness needed when volatility
regimes change inside a five-minute window.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

MIN_VOL_PER_SEC = 1e-7            # ~0.001 bps/s floor, keeps the pricer sane
MAX_VOL_PER_SEC = 5e-3
DEFAULT_COARSE_SCALE = 10         # seconds per coarse return for the TSRV leg


@dataclass
class VolEstimate:
    """Per-second volatility of the efficient log price."""

    ewma: float                   # noise-corrected, responsive
    realized: float               # noise-corrected, full lookback
    bipower: float                # jump-robust
    raw_realized: float           # uncorrected -- shows how much noise there was
    tsrv: float                   # two-scale estimate
    blended: float                # what the pricer uses
    noise_bps: float              # estimated per-observation noise, in bps
    noise_share: float            # fraction of raw variance attributed to noise
    jump_ratio: float
    n_samples: int
    is_reliable: bool
    #: relative standard error of ``blended`` -- how unsure we are of the level
    relative_uncertainty: float = 0.0

    @property
    def per_window(self) -> float:
        """Volatility over a 300-second window (the contract's horizon)."""
        return self.blended * math.sqrt(300.0)

    @property
    def effective(self) -> float:
        """Volatility to price with, accounting for uncertainty in the estimate.

        Volatility is not merely unknown, it is *stochastic*: it bursts.  The
        terminal price distribution is therefore a scale mixture of normals, and
        a mixture has fatter tails than any single normal in it.  Pricing a
        digital with the point estimate makes the model systematically
        over-confident -- which is exactly what this project's own validation
        measured: even with a perfect price feed the model lost to a market
        maker using a deliberately *over*-stated volatility.

        For a multiplicative estimation error with relative standard deviation
        ``nu``, ``E[sigma^2] = sigma_hat^2 (1 + nu^2)``, so inflating by
        ``sqrt(1 + nu^2)`` prices against the mixture rather than a single draw.
        """
        nu = max(self.relative_uncertainty, 0.0)
        return self.blended * math.sqrt(1.0 + nu * nu)

    @property
    def effective_per_window(self) -> float:
        return self.effective * math.sqrt(300.0)


class VolatilityEstimator:
    """Incremental, noise-corrected volatility tracker for one asset.

    Fed with irregular ``(timestamp, price)`` observations; internally resamples
    onto a one-second grid by last-observation-carried-forward, which is both
    causal and the same convention the feature engine uses.
    """

    __slots__ = (
        "halflife", "lookback", "min_samples", "coarse_scale", "_alpha",
        "_grid", "_last_grid_ts", "_last_price", "_ewma_var", "_n",
        "_max_gap", "_noise_var",
    )

    def __init__(
        self,
        halflife_seconds: float = 45.0,
        lookback: int = 600,
        min_samples: int = 30,
        max_gap_seconds: float = 10.0,
        coarse_scale: int = DEFAULT_COARSE_SCALE,
    ):
        self.halflife = halflife_seconds
        self.lookback = lookback
        self.min_samples = min_samples
        self.coarse_scale = max(int(coarse_scale), 2)
        self._max_gap = max_gap_seconds
        self._alpha = 1.0 - math.exp(-math.log(2.0) / max(halflife_seconds, 1e-9))
        #: one-second grid of log prices
        self._grid: deque[float] = deque(maxlen=lookback)
        self._last_grid_ts: float | None = None
        self._last_price: float | None = None
        self._ewma_var = 0.0
        self._noise_var = 0.0
        self._n = 0

    # ------------------------------------------------------------------ feed
    def reset(self) -> None:
        self._grid.clear()
        self._last_grid_ts = None
        self._last_price = None
        self._ewma_var = 0.0
        self._noise_var = 0.0
        self._n = 0

    def update(self, timestamp: float, price: float) -> None:
        if price <= 0 or not math.isfinite(price):
            return
        self._last_price = price

        if self._last_grid_ts is None:
            self._last_grid_ts = math.floor(timestamp)
            self._grid.append(math.log(price))
            return

        # Advance the grid one second at a time, carrying the last price
        # forward.  A long gap resets the chain rather than fabricating one
        # enormous return.
        gap = timestamp - self._last_grid_ts
        if gap > self._max_gap:
            self._grid.clear()
            self._last_grid_ts = math.floor(timestamp)
            self._grid.append(math.log(price))
            self._ewma_var = 0.0
            return

        steps = int(math.floor(timestamp) - self._last_grid_ts)
        if steps <= 0:
            return
        log_price = math.log(price)
        for _ in range(steps):
            previous = self._grid[-1] if self._grid else log_price
            self._grid.append(log_price)
            ret = log_price - previous
            self._ewma_var = (1 - self._alpha) * self._ewma_var + self._alpha * ret * ret
            self._n += 1
        self._last_grid_ts = math.floor(timestamp)

    # -------------------------------------------------------------- estimate
    def estimate(self) -> VolEstimate:
        grid = list(self._grid)
        n = len(grid)
        if n < 3:
            floor = MIN_VOL_PER_SEC
            return VolEstimate(
                ewma=floor, realized=floor, bipower=floor, raw_realized=floor,
                tsrv=floor, blended=floor, noise_bps=0.0, noise_share=0.0,
                jump_ratio=1.0, n_samples=n, is_reliable=False,
                relative_uncertainty=1.0,
            )

        returns = [grid[i] - grid[i - 1] for i in range(1, n)]
        m = len(returns)
        raw_var = sum(r * r for r in returns) / m

        # --- noise variance from the first-order autocovariance --------------
        # For an efficient martingale price observed with i.i.d. noise,
        # cov(r_i, r_{i+1}) = -sigma_noise^2.  A positive sample value means no
        # detectable noise (or genuine positive autocorrelation), so clamp at 0.
        if m >= 4:
            autocov = sum(returns[i] * returns[i - 1] for i in range(1, m)) / (m - 1)
            noise_var = max(-autocov, 0.0)
        else:
            noise_var = 0.0
        # The correction cannot exceed the observed variance.
        noise_var = min(noise_var, raw_var / 2.0)
        self._noise_var = noise_var
        corrected_var = max(raw_var - 2.0 * noise_var, 0.0)

        # --- two-scale realized variance ------------------------------------
        tsrv_var = corrected_var
        k = self.coarse_scale
        if n > k * 2:
            coarse_sum = 0.0
            coarse_count = 0
            for offset in range(k):
                indices = list(range(offset, n, k))
                for j in range(1, len(indices)):
                    ret = grid[indices[j]] - grid[indices[j - 1]]
                    coarse_sum += ret * ret
                    coarse_count += 1
            if coarse_count > 0:
                # Per-second coarse variance, averaged across the K subgrids.
                rv_coarse = (coarse_sum / coarse_count) / k
                tsrv_var = max((rv_coarse - raw_var / k) / (1.0 - 1.0 / k), 0.0)

        # --- jump-robust bipower variation -----------------------------------
        mu1 = math.sqrt(2.0 / math.pi)
        if m >= 3:
            bipower_sum = sum(
                abs(returns[i]) * abs(returns[i - 1]) for i in range(1, m)
            ) / (m - 1)
            bipower_var = max(bipower_sum / (mu1 * mu1) - 2.0 * noise_var, 0.0)
        else:
            bipower_var = corrected_var

        # --- EWMA, scaled by the same noise correction ------------------------
        # The EWMA is computed on raw returns for responsiveness; scaling it by
        # the corrected/raw ratio removes the same bias without losing the fast
        # reaction to a volatility burst.
        correction = (corrected_var / raw_var) if raw_var > 0 else 1.0
        ewma_var = max(self._ewma_var * correction, 0.0)

        ewma = math.sqrt(ewma_var)
        realized = math.sqrt(corrected_var)
        bipower = math.sqrt(bipower_var)
        tsrv = math.sqrt(tsrv_var)
        raw = math.sqrt(raw_var)

        # The blend leans on TSRV (least biased) and the EWMA (most responsive),
        # anchored by the plain corrected estimate.
        blended = 0.40 * tsrv + 0.35 * ewma + 0.25 * realized
        blended = min(max(blended, MIN_VOL_PER_SEC), MAX_VOL_PER_SEC)

        jump_ratio = (realized / bipower) if bipower > 1e-12 else 1.0
        noise_share = (2.0 * noise_var / raw_var) if raw_var > 0 else 0.0
        reliable = (
            m >= self.min_samples
            and blended > MIN_VOL_PER_SEC * 2
            and noise_share < 0.95
        )

        # How unsure are we of the level?  Three sources, combined in quadrature:
        #   * sampling error of a variance estimate from m returns: ~1/sqrt(2m)
        #     on the variance, so ~1/sqrt(8m) on the volatility;
        #   * disagreement between the estimators, which widens exactly when the
        #     series is behaving unusually;
        #   * the noise correction itself, which is less reliable the more of the
        #     observed variance it had to remove.
        sampling = 1.0 / math.sqrt(max(8 * m, 1))
        candidates = [v for v in (ewma, realized, tsrv, bipower) if v > 0]
        if len(candidates) >= 2 and blended > 0:
            spread = (max(candidates) - min(candidates)) / blended
            disagreement = spread / 2.0
        else:
            disagreement = 0.0
        noise_penalty = 0.5 * noise_share
        relative_uncertainty = min(
            math.sqrt(sampling ** 2 + disagreement ** 2 + noise_penalty ** 2), 1.5
        )

        return VolEstimate(
            ewma=max(ewma, MIN_VOL_PER_SEC),
            realized=max(realized, MIN_VOL_PER_SEC),
            bipower=max(bipower, MIN_VOL_PER_SEC),
            raw_realized=max(raw, MIN_VOL_PER_SEC),
            tsrv=max(tsrv, MIN_VOL_PER_SEC),
            blended=blended,
            noise_bps=math.sqrt(noise_var) * 1e4,
            noise_share=min(max(noise_share, 0.0), 1.0),
            jump_ratio=jump_ratio,
            n_samples=m,
            is_reliable=reliable,
            relative_uncertainty=relative_uncertainty,
        )

    @property
    def n_samples(self) -> int:
        return max(len(self._grid) - 1, 0)
