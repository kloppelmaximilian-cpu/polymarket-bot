"""The prediction engine: features in, calibrated probability out.

Pipeline for one market at one instant:

1. :class:`~pmbot.features.engine.FeatureEngine` builds the vector.
2. The regime detector classifies the market.
3. Every enabled strategy produces a signal (or abstains).
4. The :class:`~pmbot.strategies.ensemble.MetaModel` fuses them in log-odds.
5. The ML view (if any) is blended in, also in log-odds.
6. A calibrator maps the result onto realised frequencies.
7. Uncertainty is widened for data-quality problems, so downstream edge tests
   automatically demand more when the inputs are worse.

Step 7 is what keeps the system honest: a probability without an error bar
cannot be compared against a market price safely.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..core.types import Market, Prediction, Regime, StrategySignal
from ..features.engine import FeatureEngine, FeatureSet
from ..logging_setup import get_logger
from ..ml.registry import LoadedModel
from ..strategies.base import Strategy
from ..strategies.ensemble import MetaModel, from_logit, to_logit
from ..strategies.ml_strategy import MLStrategy
from ..strategies.regime import RegimeDetector, RegimeState
from .anchor import AnchoredProbability, RelativeSkillTracker, anchor_to_market
from .calibration import Calibrator


@dataclass
class PredictionResult:
    prediction: Prediction
    feature_set: FeatureSet
    regime_state: RegimeState
    signals: list[StrategySignal]
    anchor: AnchoredProbability | None = None


class PredictionEngine:
    def __init__(
        self,
        features: FeatureEngine,
        strategies: list[Strategy],
        meta: MetaModel,
        regime_detector: RegimeDetector | None = None,
        calibrator: Calibrator | None = None,
        ml_strategy: MLStrategy | None = None,
        ml_blend_weight: float = 0.5,
        probability_floor: float = 0.02,
        probability_cap: float = 0.98,
        market_anchor_weight: float = 0.35,
        adaptive_anchor: bool = True,
        anchor_weight_uncertainty: float = 0.10,
        skill_tracker: RelativeSkillTracker | None = None,
    ):
        self.features = features
        self.strategies = strategies
        self.meta = meta
        self.regime_detector = regime_detector or RegimeDetector()
        self.calibrator = calibrator
        self.ml_strategy = ml_strategy
        self.ml_blend_weight = ml_blend_weight
        self.floor = probability_floor
        self.cap = probability_cap
        self.anchor_weight_uncertainty = anchor_weight_uncertainty
        self.adaptive_anchor = adaptive_anchor
        self.skill = skill_tracker or RelativeSkillTracker(
            prior_weight=market_anchor_weight
        )
        self.log = get_logger("pmbot.probability")

    # ------------------------------------------------------------------ API
    def predict(self, market: Market, now: float) -> PredictionResult | None:
        fs = self.features.compute(market, now)
        if fs is None:
            return None

        regime_state = self.regime_detector.detect(fs)
        regime = regime_state.regime

        signals = [s.evaluate(fs, regime) for s in self.strategies]

        ml_probability: float | None = None
        if self.ml_strategy is not None:
            ml_signal = self.ml_strategy.evaluate(fs, regime)
            signals.append(ml_signal)
            if not ml_signal.abstain:
                ml_probability = ml_signal.probability_up

        meta_result = self.meta.combine(signals, regime)
        probability = meta_result.probability_up
        uncertainty = meta_result.uncertainty
        confidence = meta_result.confidence

        # The ML view is already inside the ensemble; this second blend lets the
        # operator dial its overall influence without rewriting the weights.
        if ml_probability is not None and self.ml_blend_weight > 0:
            w = min(max(self.ml_blend_weight, 0.0), 1.0)
            probability = from_logit(
                (1 - w) * to_logit(probability) + w * to_logit(ml_probability)
            )
            # Disagreement between the two views is genuine extra uncertainty.
            uncertainty = max(uncertainty, abs(ml_probability - meta_result.probability_up) / 2.0)

        model_only_probability = probability

        calibrated = False
        if self.calibrator is not None and self.calibrator.is_fitted:
            probability = self.calibrator.transform(probability)
            calibrated = True

        # Anchor to the market's own de-vigged price.  This is what keeps the
        # trade gate from selecting the markets where *our* error is largest.
        implied = fs.features.get("implied_up")
        anchor_weight = (
            self.skill.weight() if self.adaptive_anchor else self.skill.prior_weight
        )
        anchor = anchor_to_market(
            probability, implied, anchor_weight, self.anchor_weight_uncertainty
        )
        probability = anchor.probability
        uncertainty = max(uncertainty, 0.0) + anchor.disagreement_uncertainty

        probability = min(max(probability, self.floor), self.cap)

        # Widen the error bar when the inputs are poor, and floor it so the
        # engine never claims perfect knowledge.
        quality = fs.features.get("data_quality", 0.0)
        uncertainty = max(uncertainty, 0.01)
        uncertainty += 0.06 * (1.0 - quality)
        if not regime_state.is_tradable:
            uncertainty += 0.05
        if not calibrated:
            uncertainty += 0.02
        uncertainty = min(uncertainty, 0.5)

        confidence *= quality
        if not regime_state.is_tradable:
            confidence *= 0.4

        prediction = Prediction(
            market_id=market.market_id,
            asset=market.asset,
            timestamp=now,
            probability_up=probability,
            probability_down=1.0 - probability,
            confidence=max(0.0, min(1.0, confidence)),
            uncertainty=uncertainty,
            regime=regime,
            signals=signals,
            features=fs.features,
            analytic_probability_up=fs.context.analytic_probability_up,
            ml_probability_up=ml_probability,
            calibrated=calibrated,
            unanchored_probability_up=model_only_probability,
            anchor_weight=anchor.model_weight,
            model_version=(
                self.ml_strategy.loaded.version
                if self.ml_strategy is not None and self.ml_strategy.loaded is not None
                else "analytic-only"
            ),
        )
        return PredictionResult(prediction, fs, regime_state, signals, anchor)

    # -------------------------------------------------------------- learning
    def record_outcome(
        self,
        signals: list[StrategySignal],
        regime: Regime,
        resolved_up: bool,
        model_probability: float | None = None,
        market_probability: float | None = None,
    ) -> None:
        """Feed a realised resolution back into the adaptive weights.

        Passing both probabilities also updates the relative-skill tracker that
        drives the market anchor, so the bot learns how much to trust itself
        against the market.
        """
        self.meta.tracker.record(signals, regime, resolved_up)
        if model_probability is not None:
            self.skill.record(model_probability, market_probability, resolved_up)

    def load_calibrator(self, path: Path) -> bool:
        calibrator = Calibrator.load(path)
        if calibrator is None:
            return False
        self.calibrator = calibrator
        self.log.info(
            "calibrator loaded",
            extra={"fitted": calibrator.is_fitted, "n": calibrator.n_samples},
        )
        return calibrator.is_fitted

    def attach_model(self, loaded: LoadedModel | None) -> None:
        if self.ml_strategy is not None:
            self.ml_strategy.loaded = loaded
