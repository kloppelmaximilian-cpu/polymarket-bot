"""Meta-model: fusing strategy signals into one probability.

Three decisions define this module.

**Combine in log-odds, not probability.**  Averaging 0.95 and 0.55 in
probability space gives 0.75, which throws away how *strong* the first view is.
Averaging log-odds respects the geometry of probability and keeps the result
invariant to which outcome we happen to call "UP".

**Weights are a product of four independent factors**: the configured prior,
the regime's preference, the strategy's own confidence right now, and its
recent realised accuracy.  Each is bounded, so no single factor can run away.

**Adaptation is slow and logged.**  Weights move on an EWMA of realised
Brier score with a long half-life and hard bounds.  Fast adaptation on
five-minute outcomes is indistinguishable from fitting noise.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..core.types import Outcome, Regime, StrategySignal
from ..logging_setup import get_logger
from .regime import regime_weight

LOGIT_CLAMP = 6.0          # ~0.0025 .. 0.9975


def to_logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return max(-LOGIT_CLAMP, min(LOGIT_CLAMP, math.log(p / (1 - p))))


def from_logit(z: float) -> float:
    z = max(-LOGIT_CLAMP, min(LOGIT_CLAMP, z))
    return 1.0 / (1.0 + math.exp(-z))


@dataclass
class StrategyScore:
    """Rolling performance of one strategy, used for adaptive weighting."""

    strategy: str
    n: int = 0
    ewma_brier: float = 0.25          # start at the coin-flip Brier score
    ewma_baseline: float = 0.25
    wins: int = 0
    losses: int = 0

    @property
    def skill(self) -> float:
        """Brier skill vs a coin flip, in [-1, 1]."""
        if self.ewma_baseline <= 0:
            return 0.0
        return max(-1.0, min(1.0, 1.0 - self.ewma_brier / self.ewma_baseline))

    def update(self, probability_up: float, resolved_up: bool, halflife: float) -> None:
        outcome = 1.0 if resolved_up else 0.0
        brier = (probability_up - outcome) ** 2
        baseline = (0.5 - outcome) ** 2
        alpha = 1.0 - math.exp(-math.log(2.0) / max(halflife, 1.0))
        self.ewma_brier = (1 - alpha) * self.ewma_brier + alpha * brier
        self.ewma_baseline = (1 - alpha) * self.ewma_baseline + alpha * baseline
        self.n += 1
        predicted_up = probability_up > 0.5
        if predicted_up == resolved_up:
            self.wins += 1
        else:
            self.losses += 1

    def as_dict(self) -> dict:
        return {
            "strategy": self.strategy, "n": self.n,
            "ewma_brier": self.ewma_brier, "skill": self.skill,
            "wins": self.wins, "losses": self.losses,
        }


@dataclass
class MetaResult:
    probability_up: float
    confidence: float
    uncertainty: float
    agreement: float
    contributions: dict[str, float] = field(default_factory=dict)
    weights: dict[str, float] = field(default_factory=dict)
    active: list[str] = field(default_factory=list)
    abstained: list[str] = field(default_factory=list)

    @property
    def direction(self) -> Outcome:
        return Outcome.UP if self.probability_up >= 0.5 else Outcome.DOWN


class StrategyPerformanceTracker:
    """Per-strategy (and per-regime) realised accuracy."""

    def __init__(self, halflife: float = 200.0, min_weight: float = 0.2, max_weight: float = 2.0):
        self.halflife = halflife
        self.min_weight = min_weight
        self.max_weight = max_weight
        self.scores: dict[str, StrategyScore] = {}
        self.by_regime: dict[tuple[str, str], StrategyScore] = {}
        self.log = get_logger("pmbot.ensemble.tracker")

    def score(self, strategy: str) -> StrategyScore:
        score = self.scores.get(strategy)
        if score is None:
            score = StrategyScore(strategy)
            self.scores[strategy] = score
        return score

    def regime_score(self, strategy: str, regime: Regime) -> StrategyScore:
        key = (strategy, regime.value)
        score = self.by_regime.get(key)
        if score is None:
            score = StrategyScore(strategy)
            self.by_regime[key] = score
        return score

    def record(
        self,
        signals: list[StrategySignal],
        regime: Regime,
        resolved_up: bool,
    ) -> None:
        """Attribute one realised outcome back to every contributing strategy."""
        for signal in signals:
            if signal.abstain:
                continue
            self.score(signal.strategy).update(
                signal.probability_up, resolved_up, self.halflife
            )
            self.regime_score(signal.strategy, regime).update(
                signal.probability_up, resolved_up, self.halflife
            )

    def performance_weight(self, strategy: str, regime: Regime) -> float:
        """Map realised skill onto a bounded multiplier around 1.0."""
        overall = self.score(strategy)
        in_regime = self.regime_score(strategy, regime)

        # Shrink toward 1.0 until there is real evidence.
        def shrunk(score: StrategyScore, prior_n: float) -> float:
            confidence = score.n / (score.n + prior_n)
            return 1.0 + confidence * score.skill

        weight = 0.6 * shrunk(overall, 40.0) + 0.4 * shrunk(in_regime, 25.0)
        return max(self.min_weight, min(self.max_weight, weight))

    def snapshot(self) -> dict:
        return {
            "overall": {k: v.as_dict() for k, v in self.scores.items()},
            "by_regime": {f"{k[0]}|{k[1]}": v.as_dict() for k, v in self.by_regime.items()},
        }

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.snapshot(), indent=2))

    def load(self, path: Path) -> bool:
        path = Path(path)
        if not path.exists():
            return False
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            return False
        for name, row in (payload.get("overall") or {}).items():
            score = StrategyScore(name)
            score.n = int(row.get("n", 0))
            score.ewma_brier = float(row.get("ewma_brier", 0.25))
            score.wins = int(row.get("wins", 0))
            score.losses = int(row.get("losses", 0))
            self.scores[name] = score
        for key, row in (payload.get("by_regime") or {}).items():
            if "|" not in key:
                continue
            strategy, regime = key.split("|", 1)
            score = StrategyScore(strategy)
            score.n = int(row.get("n", 0))
            score.ewma_brier = float(row.get("ewma_brier", 0.25))
            self.by_regime[(strategy, regime)] = score
        return True


class MetaModel:
    """Weighted log-odds fusion of strategy signals."""

    def __init__(
        self,
        base_weights: dict[str, float] | None = None,
        tracker: StrategyPerformanceTracker | None = None,
        adaptive: bool = True,
        anchor_strategy: str = "fair_value",
        anchor_floor: float = 0.25,
    ):
        self.base_weights = base_weights or {}
        self.tracker = tracker or StrategyPerformanceTracker()
        self.adaptive = adaptive
        self.anchor_strategy = anchor_strategy
        self.anchor_floor = anchor_floor
        self.log = get_logger("pmbot.ensemble")

    def combine(self, signals: list[StrategySignal], regime: Regime) -> MetaResult:
        active = [s for s in signals if not s.abstain and s.confidence > 0]
        abstained = [s.strategy for s in signals if s.abstain or s.confidence <= 0]

        if not active:
            return MetaResult(
                probability_up=0.5, confidence=0.0, uncertainty=0.5, agreement=0.0,
                abstained=abstained,
            )

        weights: dict[str, float] = {}
        for signal in active:
            base = self.base_weights.get(signal.strategy, 1.0)
            regime_multiplier = regime_weight(regime, signal.strategy)
            performance = (
                self.tracker.performance_weight(signal.strategy, regime)
                if self.adaptive else 1.0
            )
            weight = base * regime_multiplier * performance * signal.confidence
            # The analytic anchor always retains a floor weight, so the ensemble
            # cannot be dragged away from fair value by a chorus of weak signals.
            if signal.strategy == self.anchor_strategy:
                weight = max(weight, self.anchor_floor * base)
            weights[signal.strategy] = max(weight, 0.0)

        total = sum(weights.values())
        if total <= 0:
            return MetaResult(
                probability_up=0.5, confidence=0.0, uncertainty=0.5, agreement=0.0,
                abstained=abstained,
            )

        logits = np.array([to_logit(s.probability_up) for s in active])
        w = np.array([weights[s.strategy] for s in active])
        w = w / w.sum()

        mean_logit = float(np.dot(w, logits))
        probability = from_logit(mean_logit)

        # Dispersion of views -> model uncertainty, expressed in probability
        # units via the logistic derivative at the combined estimate.
        variance = float(np.dot(w, (logits - mean_logit) ** 2))
        logit_sd = math.sqrt(max(variance, 0.0))
        slope = probability * (1.0 - probability)
        uncertainty = min(0.5, logit_sd * slope)

        # Agreement: weighted share of the majority direction.
        up_weight = float(sum(wi for wi, s in zip(w, active) if s.probability_up > 0.5))
        agreement = max(up_weight, 1.0 - up_weight)

        confidence = float(np.dot(w, np.array([s.confidence for s in active])))
        confidence *= 0.5 + 0.5 * agreement        # disagreement costs confidence
        n_effective = 1.0 / float(np.sum(w ** 2))  # effective number of sources
        confidence *= min(1.0, 0.55 + 0.15 * n_effective)

        return MetaResult(
            probability_up=probability,
            confidence=max(0.0, min(1.0, confidence)),
            uncertainty=uncertainty,
            agreement=agreement,
            contributions={s.strategy: float(wi) for wi, s in zip(w, active)},
            weights=weights,
            active=[s.strategy for s in active],
            abstained=abstained,
        )
