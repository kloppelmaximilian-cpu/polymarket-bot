"""Strategy framework.

The key design decision: a strategy does **not** output "BUY" or a raw
probability out of thin air.  It outputs a **drift**, expressed in units of the
standard deviation of the move still to come, and the analytic pricer converts
that into a probability.

Why this matters.  A momentum reading of "+0.5 sigma" means something
completely different with 240 seconds left than with 20 seconds left, and it
means something different for BTC at 0.3%/5min vol than for DOGE at 1.5%.
Routing every signal through the pricer makes the time- and volatility-scaling
automatic and consistent, and it keeps every strategy on one comparable scale.

Formally, with ``z = log(spot/strike) / sigma_total`` the analytic z-score:

    P(UP) = Phi(z + drift_sd)

so ``drift_sd`` is exactly the number of standard deviations a strategy thinks
the path is tilted.  It is hard-capped, because no five-minute signal deserves
to move a probability by more than a fraction of a sigma.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..core.types import Regime, StrategySignal
from ..features.engine import FeatureSet
from ..logging_setup import get_logger
from ..probability.analytic import norm_cdf

#: No single strategy may tilt the fair value by more than this many sigma.
MAX_DRIFT_SD = 0.5


@dataclass
class StrategyConfig:
    enabled: bool = True
    weight: float = 1.0
    min_confidence: float = 0.0
    max_drift_sd: float = MAX_DRIFT_SD
    #: regimes in which the strategy should stand down (empty = always on)
    disabled_regimes: set[Regime] = field(default_factory=set)


class Strategy(ABC):
    """Base class for every signal generator."""

    name: str = "abstract"
    #: features the strategy needs; missing ones cause an abstain
    requires: tuple[str, ...] = ()

    def __init__(self, config: StrategyConfig | None = None):
        self.config = config or StrategyConfig()
        self.log = get_logger(f"pmbot.strategy.{self.name}")

    # ----------------------------------------------------------------- API
    def evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        if not self.config.enabled or regime in self.config.disabled_regimes:
            return self.abstain("disabled in regime" if self.config.enabled else "disabled")
        missing = [f for f in self.requires if f not in fs.features]
        if missing:
            return self.abstain(f"missing features: {','.join(missing[:3])}")
        try:
            return self._evaluate(fs, regime)
        except Exception as exc:  # noqa: BLE001 - a broken strategy must not stop the bot
            self.log.warning("strategy error", extra={"error": str(exc)[:200]})
            return self.abstain(f"error: {type(exc).__name__}")

    @abstractmethod
    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal: ...

    # ------------------------------------------------------------- helpers
    def abstain(self, reason: str) -> StrategySignal:
        return StrategySignal(
            strategy=self.name, probability_up=0.5, confidence=0.0,
            reason=reason, abstain=True,
        )

    def from_drift(
        self,
        fs: FeatureSet,
        drift_sd: float,
        confidence: float,
        reason: str,
        used: dict[str, float] | None = None,
    ) -> StrategySignal:
        """Convert a drift tilt into a calibrated-scale probability."""
        z = fs.features.get("analytic_z")
        if z is None:
            return self.abstain("no analytic z-score")
        cap = self.config.max_drift_sd
        drift = max(-cap, min(cap, drift_sd))
        probability = norm_cdf(z + drift)
        return StrategySignal(
            strategy=self.name,
            probability_up=probability,
            confidence=max(0.0, min(1.0, confidence)),
            reason=reason,
            features_used=used or {},
        )

    def from_probability(
        self,
        probability: float,
        confidence: float,
        reason: str,
        used: dict[str, float] | None = None,
    ) -> StrategySignal:
        return StrategySignal(
            strategy=self.name,
            probability_up=max(0.001, min(0.999, probability)),
            confidence=max(0.0, min(1.0, confidence)),
            reason=reason,
            features_used=used or {},
        )


def squash(value: float, scale: float) -> float:
    """Bounded, smooth mapping of an unbounded signal into roughly [-1, 1]."""
    if scale <= 0:
        return 0.0
    return math.tanh(value / scale)
