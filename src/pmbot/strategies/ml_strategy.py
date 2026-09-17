"""The ML strategy: a trained model as one more voice in the ensemble.

Two deliberate restraints:

* It **abstains** when no artifact is loaded, when the model was not
  calibrated, or when too many of its input features are missing.  A model
  extrapolating on median-imputed garbage is worse than silence.
* Its confidence is capped by the out-of-sample skill recorded in the model's
  own manifest, so a model that barely beat the base rate in validation cannot
  shout down the analytic anchor in production.
"""

from __future__ import annotations

from ..core.types import Regime, StrategySignal
from ..features.engine import FeatureSet
from ..ml.registry import LoadedModel
from .base import Strategy, StrategyConfig


class MLStrategy(Strategy):
    name = "ml"

    def __init__(
        self,
        loaded: LoadedModel | None = None,
        config: StrategyConfig | None = None,
        max_missing_fraction: float = 0.25,
        require_calibration: bool = True,
    ):
        super().__init__(config)
        self.loaded = loaded
        self.max_missing_fraction = max_missing_fraction
        self.require_calibration = require_calibration

    @property
    def is_ready(self) -> bool:
        if self.loaded is None:
            return False
        return not (self.require_calibration and not self.loaded.is_calibrated)

    def _skill_cap(self) -> float:
        """Confidence ceiling derived from validated out-of-sample skill."""
        if self.loaded is None:
            return 0.0
        metrics = self.loaded.test_metrics()
        skill = metrics.get("brier_skill")
        if skill is None:
            return 0.4
        # skill of 0 -> no confidence; 0.10 -> full confidence.
        return max(0.0, min(1.0, float(skill) / 0.10))

    def _evaluate(self, fs: FeatureSet, regime: Regime) -> StrategySignal:
        if not self.is_ready:
            reason = "no model loaded" if self.loaded is None else "model not calibrated"
            return self.abstain(reason)

        assert self.loaded is not None
        names = self.loaded.feature_names
        if not names:
            return self.abstain("model has no feature list")

        missing = [name for name in names if name not in fs.features]
        if len(missing) / len(names) > self.max_missing_fraction:
            return self.abstain(
                f"{len(missing)}/{len(names)} features missing"
            )

        probability = self.loaded.predict(fs.features)

        cap = self._skill_cap()
        confidence = (
            (0.45 + 0.35 * (1.0 - len(missing) / len(names)))
            * fs.features.get("data_quality", 0.0)
        )
        confidence = min(confidence, cap)

        return self.from_probability(
            probability, confidence,
            f"model {self.loaded.version} ({len(missing)} feats imputed)",
            {"missing": float(len(missing)), "skill_cap": cap},
        )
