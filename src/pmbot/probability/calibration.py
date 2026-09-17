"""Probability calibration and calibration diagnostics.

A model that says 0.70 must win about 70% of the time, or every downstream edge
calculation is wrong in a way no amount of risk management can fix.  This module
provides the two standard mappings (isotonic regression and Platt scaling), the
reliability diagnostics needed to decide whether to trust them, and a guard that
refuses to apply a calibrator fitted on too few samples.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np

Method = Literal["isotonic", "platt", "none"]


@dataclass
class CalibrationReport:
    n_samples: int
    brier: float
    brier_baseline: float
    log_loss: float
    ece: float                 # expected calibration error
    mce: float                 # maximum calibration error
    bins: list[dict[str, float]] = field(default_factory=list)
    auc: float | None = None
    ece_noise_floor: float = float("nan")

    @property
    def brier_skill(self) -> float:
        """Skill vs always predicting the base rate.  >0 means informative."""
        if self.brier_baseline <= 0:
            return 0.0
        return 1.0 - self.brier / self.brier_baseline

    @property
    def ece_excess(self) -> float:
        """ECE above what finite-sample binning noise alone would produce.

        A raw ECE is almost uninterpretable on its own: with 50 samples in a
        bin, a *perfectly* calibrated model still shows a gap of about 0.05
        purely from sampling.  Only the excess over that floor is evidence of
        real miscalibration.
        """
        if self.ece != self.ece or self.ece_noise_floor != self.ece_noise_floor:
            return float("nan")
        return self.ece - self.ece_noise_floor

    @property
    def is_well_calibrated(self) -> bool:
        excess = self.ece_excess
        return excess == excess and excess < 0.02

    def as_dict(self) -> dict:
        return {
            "n_samples": self.n_samples,
            "brier": self.brier,
            "brier_baseline": self.brier_baseline,
            "brier_skill": self.brier_skill,
            "log_loss": self.log_loss,
            "ece": self.ece,
            "ece_noise_floor": self.ece_noise_floor,
            "ece_excess": self.ece_excess,
            "mce": self.mce,
            "auc": self.auc,
            "bins": self.bins,
        }


def brier_score(probabilities: Sequence[float], outcomes: Sequence[int]) -> float:
    p = np.asarray(probabilities, dtype=float)
    y = np.asarray(outcomes, dtype=float)
    if len(p) == 0:
        return float("nan")
    return float(np.mean((p - y) ** 2))


def log_loss(probabilities: Sequence[float], outcomes: Sequence[int], eps: float = 1e-12) -> float:
    p = np.clip(np.asarray(probabilities, dtype=float), eps, 1 - eps)
    y = np.asarray(outcomes, dtype=float)
    if len(p) == 0:
        return float("nan")
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc_score(probabilities: Sequence[float], outcomes: Sequence[int]) -> float | None:
    """Rank-based AUC (Mann-Whitney), tie-aware."""
    p = np.asarray(probabilities, dtype=float)
    y = np.asarray(outcomes, dtype=int)
    pos, neg = int((y == 1).sum()), int((y == 0).sum())
    if pos == 0 or neg == 0:
        return None
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(len(p), dtype=float)
    sorted_p = p[order]
    i = 0
    while i < len(p):
        j = i
        while j + 1 < len(p) and sorted_p[j + 1] == sorted_p[i]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        ranks[order[i : j + 1]] = average
        i = j + 1
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2.0) / (pos * neg))


def ece_noise_floor(bins: Sequence[dict[str, float]], n_total: int) -> float:
    """Expected ECE for a *perfectly* calibrated model at this sample size.

    Within a bin holding ``m`` observations with true probability ``p``, the
    observed frequency has standard deviation ``sqrt(p(1-p)/m)`` and the
    expected absolute deviation of a mean-zero normal is ``sqrt(2/pi)`` times
    its standard deviation.  Weighting by bin occupancy gives the floor.
    """
    if not bins or n_total <= 0:
        return float("nan")
    factor = math.sqrt(2.0 / math.pi)
    total = 0.0
    for row in bins:
        m = row.get("count", 0)
        if not m:
            continue
        p = min(max(row.get("predicted", 0.5), 1e-6), 1 - 1e-6)
        total += (m / n_total) * factor * math.sqrt(p * (1 - p) / m)
    return total


def reliability_bins(
    probabilities: Sequence[float], outcomes: Sequence[int], n_bins: int = 10
) -> tuple[list[dict[str, float]], float, float]:
    """Reliability curve plus expected/maximum calibration error."""
    p = np.asarray(probabilities, dtype=float)
    y = np.asarray(outcomes, dtype=float)
    if len(p) == 0:
        return [], float("nan"), float("nan")

    edges = np.linspace(0.0, 1.0, n_bins + 1)
    bins: list[dict[str, float]] = []
    ece = 0.0
    mce = 0.0
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < n_bins - 1 else (p >= lo) & (p <= hi)
        count = int(mask.sum())
        if count == 0:
            continue
        predicted = float(p[mask].mean())
        observed = float(y[mask].mean())
        gap = abs(predicted - observed)
        ece += (count / len(p)) * gap
        mce = max(mce, gap)
        bins.append({
            "lo": float(lo), "hi": float(hi), "count": count,
            "predicted": predicted, "observed": observed, "gap": gap,
        })
    return bins, ece, mce


def evaluate(
    probabilities: Sequence[float], outcomes: Sequence[int], n_bins: int = 10
) -> CalibrationReport:
    p = np.asarray(probabilities, dtype=float)
    y = np.asarray(outcomes, dtype=int)
    base_rate = float(y.mean()) if len(y) else 0.5
    bins, ece, mce = reliability_bins(p, y, n_bins)
    return CalibrationReport(
        n_samples=len(p),
        brier=brier_score(p, y),
        brier_baseline=brier_score(np.full(len(p), base_rate), y) if len(p) else float("nan"),
        log_loss=log_loss(p, y),
        ece=ece,
        mce=mce,
        bins=bins,
        auc=auc_score(p, y),
        ece_noise_floor=ece_noise_floor(bins, len(p)),
    )


class Calibrator:
    """Maps raw model probabilities onto calibrated ones.

    Falls back to the identity mapping -- explicitly, and visibly via
    :attr:`is_fitted` -- whenever there is not enough data to fit safely.  A
    badly fitted calibrator is worse than none at all.
    """

    def __init__(self, method: Method = "isotonic", min_samples: int = 500):
        self.method: Method = method
        self.min_samples = min_samples
        self.is_fitted = False
        self.n_samples = 0
        self.report: CalibrationReport | None = None
        self._x: np.ndarray | None = None      # isotonic knots
        self._y: np.ndarray | None = None
        self._a: float = 1.0                   # platt slope
        self._b: float = 0.0                   # platt intercept

    # ------------------------------------------------------------------ fit
    def fit(self, probabilities: Sequence[float], outcomes: Sequence[int]) -> Calibrator:
        p = np.clip(np.asarray(probabilities, dtype=float), 1e-6, 1 - 1e-6)
        y = np.asarray(outcomes, dtype=float)
        if len(p) != len(y):
            raise ValueError("probabilities and outcomes must be the same length")

        self.n_samples = len(p)
        self.report = evaluate(p, y.astype(int))

        if self.method == "none" or len(p) < self.min_samples:
            self.is_fitted = False
            return self
        if len(np.unique(y)) < 2:
            self.is_fitted = False
            return self

        if self.method == "isotonic":
            self._fit_isotonic(p, y)
        else:
            self._fit_platt(p, y)
        self.is_fitted = True
        return self

    def _fit_isotonic(self, p: np.ndarray, y: np.ndarray) -> None:
        from sklearn.isotonic import IsotonicRegression

        model = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
        model.fit(p, y)
        # Store as a lookup table so the calibrator serialises to plain JSON and
        # does not pin us to a scikit-learn version at inference time.
        grid = np.linspace(0.0, 1.0, 201)
        self._x = grid
        self._y = np.clip(model.predict(grid), 0.0, 1.0)
        # Enforce monotonicity after clipping.
        self._y = np.maximum.accumulate(self._y)

    def _fit_platt(self, p: np.ndarray, y: np.ndarray) -> None:
        from sklearn.linear_model import LogisticRegression

        logit = np.log(p / (1 - p)).reshape(-1, 1)
        model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        model.fit(logit, y)
        self._a = float(model.coef_[0][0])
        self._b = float(model.intercept_[0])

    # -------------------------------------------------------------- predict
    def transform(self, probability: float) -> float:
        if not self.is_fitted:
            return float(probability)
        p = min(max(float(probability), 1e-6), 1 - 1e-6)
        if self.method == "isotonic" and self._x is not None and self._y is not None:
            return float(np.interp(p, self._x, self._y))
        logit = math.log(p / (1 - p))
        return float(1.0 / (1.0 + math.exp(-(self._a * logit + self._b))))

    def transform_many(self, probabilities: Sequence[float]) -> np.ndarray:
        return np.array([self.transform(p) for p in probabilities])

    # ------------------------------------------------------------ persistence
    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "min_samples": self.min_samples,
            "is_fitted": self.is_fitted,
            "n_samples": self.n_samples,
            "x": self._x.tolist() if self._x is not None else None,
            "y": self._y.tolist() if self._y is not None else None,
            "a": self._a,
            "b": self._b,
            "report": self.report.as_dict() if self.report else None,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> Calibrator:
        cal = cls(payload.get("method", "isotonic"), payload.get("min_samples", 500))
        cal.is_fitted = bool(payload.get("is_fitted", False))
        cal.n_samples = int(payload.get("n_samples", 0))
        cal._x = np.asarray(payload["x"]) if payload.get("x") else None
        cal._y = np.asarray(payload["y"]) if payload.get("y") else None
        cal._a = float(payload.get("a", 1.0))
        cal._b = float(payload.get("b", 0.0))
        return cal

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2))

    @classmethod
    def load(cls, path: Path) -> Calibrator | None:
        path = Path(path)
        if not path.exists():
            return None
        try:
            return cls.from_dict(json.loads(path.read_text()))
        except (json.JSONDecodeError, KeyError, ValueError):
            return None
