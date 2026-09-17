"""Market anchoring: treating the market's own price as a prior.

The problem this solves is the single most expensive failure mode of a
prediction-market bot, and this project's own walk-forward run demonstrated it
before the fix: the trade gate selects the markets where the model and the
market disagree most, and a *large* disagreement is far more often produced by
model error than by market error.  The result is a model with genuine average
skill that loses money, because the subset it chooses to trade is precisely the
subset where it is wrong.

The fix is Bayesian rather than a patch.  Both the model and the market are
noisy estimates of the same log-odds.  With error variances ``sigma_model^2``
and ``sigma_market^2``, the precision-weighted combination is

    logit(p) = w * logit(p_model) + (1 - w) * logit(p_market)
    w        = sigma_market^2 / (sigma_model^2 + sigma_market^2)

Two consequences follow, both desirable:

* **The realised edge is shrunk by ``w``.**  A 17-point raw disagreement becomes
  a 6-point posterior deviation at ``w = 0.35``.  Only disagreements large
  relative to our own error survive as tradable.
* **Disagreement itself becomes uncertainty.**  When the two sources conflict
  sharply, at least one is badly wrong, so the error bar must widen.  That
  raises the edge bar exactly when a naive bot would be most excited.

``w`` should be *measured*, not guessed.  :class:`RelativeSkillTracker` keeps a
rolling estimate of each source's Brier score against realised outcomes and
derives ``w`` from them, shrunk toward a conservative prior until enough
outcomes have accumulated.  With no data, the default assumes the market is
somewhat better than the model -- which, for a liquid market, is the right
prior to start from.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..logging_setup import get_logger

LOGIT_CLAMP = 6.0


def _to_logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return max(-LOGIT_CLAMP, min(LOGIT_CLAMP, math.log(p / (1 - p))))


def _from_logit(z: float) -> float:
    z = max(-LOGIT_CLAMP, min(LOGIT_CLAMP, z))
    return 1.0 / (1.0 + math.exp(-z))


@dataclass(frozen=True, slots=True)
class AnchoredProbability:
    probability: float
    model_weight: float
    raw_model_probability: float
    market_probability: float
    logit_gap: float
    disagreement_uncertainty: float

    @property
    def shrinkage(self) -> float:
        """How much of the raw disagreement was discarded, in probability terms."""
        raw = self.raw_model_probability - self.market_probability
        posterior = self.probability - self.market_probability
        if abs(raw) < 1e-12:
            return 0.0
        return 1.0 - posterior / raw


def anchor_to_market(
    model_probability: float,
    market_probability: float | None,
    model_weight: float,
    weight_uncertainty: float = 0.10,
) -> AnchoredProbability:
    """Blend a model probability toward the market's implied probability.

    ``model_weight`` of 1.0 ignores the market entirely (appropriate only when
    the market's price is unavailable or known to be stale); 0.0 defers to the
    market completely.

    ``weight_uncertainty`` is the standard error of ``model_weight`` itself, and
    it is the *only* extra uncertainty this blend adds.  That distinction
    matters: charging the full disagreement as uncertainty on top of shrinking
    the point estimate double-counts, and the two terms then cancel so exactly
    that the bot never trades at all.  Combining two independent estimates
    *reduces* variance; what remains genuinely unknown is how much to trust each
    one, which contributes ``weight_uncertainty * |logit gap|`` in log-odds.
    """
    weight = min(max(model_weight, 0.0), 1.0)
    if market_probability is None:
        return AnchoredProbability(
            probability=model_probability, model_weight=1.0,
            raw_model_probability=model_probability,
            market_probability=float("nan"), logit_gap=0.0,
            disagreement_uncertainty=0.0,
        )

    model_logit = _to_logit(model_probability)
    market_logit = _to_logit(market_probability)
    gap = model_logit - market_logit
    blended = weight * model_logit + (1.0 - weight) * market_logit
    probability = _from_logit(blended)

    # Uncertainty about the blend weight, mapped into probability units through
    # the local slope of the logistic.
    slope = probability * (1.0 - probability)
    uncertainty = min(max(weight_uncertainty, 0.0), 1.0) * abs(gap) * slope

    return AnchoredProbability(
        probability=probability,
        model_weight=weight,
        raw_model_probability=model_probability,
        market_probability=market_probability,
        logit_gap=gap,
        disagreement_uncertainty=uncertainty,
    )


@dataclass
class SkillScore:
    n: int = 0
    ewma_brier: float = 0.25
    ewma_base: float = 0.25          # Brier of always predicting the base rate
    ewma_outcome: float = 0.5

    def update(self, probability: float, outcome_up: bool, halflife: float) -> None:
        target = 1.0 if outcome_up else 0.0
        alpha = 1.0 - math.exp(-math.log(2.0) / max(halflife, 1.0))
        self.ewma_brier = (1 - alpha) * self.ewma_brier + alpha * (probability - target) ** 2
        self.ewma_outcome = (1 - alpha) * self.ewma_outcome + alpha * target
        base = self.ewma_outcome
        self.ewma_base = (1 - alpha) * self.ewma_base + alpha * (base - target) ** 2
        self.n += 1

    @property
    def skill(self) -> float:
        """Brier skill against the rolling base rate; 0 means uninformative."""
        if self.ewma_base <= 1e-9:
            return 0.0
        return 1.0 - self.ewma_brier / self.ewma_base

    def as_dict(self) -> dict:
        return {
            "n": self.n,
            "ewma_brier": self.ewma_brier,
            "skill": self.skill,
        }


def fit_anchor_weight(
    model_probabilities,
    market_probabilities,
    outcomes,
    min_samples: int = 300,
    default: float = 0.35,
    min_weight: float = 0.10,
    max_weight: float = 0.80,
) -> tuple[float, dict]:
    """Estimate the optimal model weight offline by logistic stacking.

    Regressing the realised outcome on both sources' log-odds recovers the
    combination that actually minimises log loss -- which is exactly the
    quantity :func:`anchor_to_market` needs, rather than a proxy for it.  The
    fitted coefficients are normalised to a single weight so the online path
    stays a one-parameter blend, and the result is clamped because a fit on a
    few hundred windows is not worth full authority.

    Returns ``(weight, diagnostics)``.
    """
    import numpy as np

    model = np.asarray(list(model_probabilities), dtype=float)
    market = np.asarray(list(market_probabilities), dtype=float)
    y = np.asarray(list(outcomes), dtype=int)
    mask = np.isfinite(model) & np.isfinite(market) & np.isfinite(y)
    model, market, y = model[mask], market[mask], y[mask]

    diagnostics: dict = {"n": int(len(y)), "fitted": False, "default": default}
    if len(y) < min_samples or len(np.unique(y)) < 2:
        diagnostics["reason"] = f"only {len(y)} usable samples"
        return default, diagnostics

    from sklearn.linear_model import LogisticRegression

    features = np.column_stack([
        [_to_logit(p) for p in model],
        [_to_logit(p) for p in market],
    ])
    fit = LogisticRegression(C=1e4, solver="lbfgs", max_iter=2000)
    fit.fit(features, y)
    coef_model, coef_market = (float(c) for c in fit.coef_[0])

    total = coef_model + coef_market
    if total <= 1e-9:
        diagnostics["reason"] = "degenerate coefficients"
        return default, diagnostics

    weight = min(max(coef_model / total, min_weight), max_weight)
    diagnostics.update({
        "fitted": True,
        "coef_model": coef_model,
        "coef_market": coef_market,
        "raw_weight": coef_model / total,
        "weight": weight,
        "intercept": float(fit.intercept_[0]),
    })
    return weight, diagnostics


class RelativeSkillTracker:
    """Rolling comparison of model accuracy against the market's own price.

    Both sources are scored on the same resolved windows, so the comparison is
    apples to apples.  The derived model weight is shrunk toward
    ``prior_weight`` in proportion to how little evidence there is, and clamped,
    so a lucky run of twenty windows cannot hand the model full authority.
    """

    def __init__(
        self,
        prior_weight: float = 0.35,
        halflife: float = 300.0,
        min_weight: float = 0.10,
        max_weight: float = 0.80,
        prior_strength: float = 150.0,
    ):
        self.prior_weight = min(max(prior_weight, 0.0), 1.0)
        self.halflife = halflife
        self.min_weight = min_weight
        self.max_weight = max_weight
        self.prior_strength = prior_strength
        self.model = SkillScore()
        self.market = SkillScore()
        self.log = get_logger("pmbot.anchor")

    def record(
        self,
        model_probability: float,
        market_probability: float | None,
        outcome_up: bool,
    ) -> None:
        self.model.update(model_probability, outcome_up, self.halflife)
        if market_probability is not None:
            self.market.update(market_probability, outcome_up, self.halflife)

    @property
    def measured_weight(self) -> float:
        """Online estimate of the model's share, from the skill difference.

        Brier scores are dominated by irreducible outcome variance, so their
        *ratio* barely moves even when one source is clearly better; the skill
        difference is far more discriminating.  A skill advantage of 0.10
        (substantial on a five-minute binary) shifts the weight by 0.30.

        This is an explicit heuristic for the online path.  When enough resolved
        windows have accumulated, :func:`fit_anchor_weight` estimates the same
        quantity properly by logistic stacking, and that value should be fed in
        as ``prior_weight``.
        """
        advantage = self.model.skill - self.market.skill
        return min(max(0.5 + 3.0 * advantage, 0.0), 1.0)

    def weight(self) -> float:
        """The weight to actually use: measured, shrunk toward the prior."""
        if self.market.n == 0 or self.model.n == 0:
            return self.prior_weight
        evidence = min(self.model.n, self.market.n)
        confidence = evidence / (evidence + self.prior_strength)
        blended = (
            confidence * self.measured_weight + (1 - confidence) * self.prior_weight
        )
        return min(max(blended, self.min_weight), self.max_weight)

    def snapshot(self) -> dict:
        return {
            "model": self.model.as_dict(),
            "market": self.market.as_dict(),
            "measured_weight": round(self.measured_weight, 4)
            if self.market.n and self.model.n else None,
            "applied_weight": round(self.weight(), 4),
            "prior_weight": self.prior_weight,
        }
