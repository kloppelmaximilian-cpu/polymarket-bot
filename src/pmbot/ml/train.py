"""Walk-forward training and model selection.

The selection rule is deliberately *not* "highest score on the whole history".
For each candidate model we run purged walk-forward validation, then judge it on
three things at once:

* **Accuracy** -- out-of-fold Brier skill against the base rate.
* **Calibration** -- expected calibration error after fitting the calibrator on
  the training fold only.
* **Stability** -- the spread of fold scores.  A model that is excellent in two
  folds and useless in three is not a model, it is a coincidence.

The composite score subtracts a penalty for instability and for miscalibration,
so a slightly worse but consistent model wins.  Every run writes a manifest
(config, seed, code commit, dataset fingerprint, per-fold results) so any
reported number can be reproduced.
"""

from __future__ import annotations

import json
import platform
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..logging_setup import get_logger
from ..probability.calibration import CalibrationReport, Calibrator, evaluate
from .dataset import Dataset, PurgedWalkForwardSplit
from .models import BaseModel, EnsembleModel, available_models, build_model

log = get_logger("pmbot.ml.train")


@dataclass
class FoldResult:
    fold: int
    n_train: int
    n_val: int
    brier: float
    brier_baseline: float
    log_loss: float
    ece: float
    auc: float | None
    brier_vs_market: float | None = None
    market_brier: float | None = None

    @property
    def brier_skill(self) -> float:
        if self.brier_baseline <= 0:
            return 0.0
        return 1.0 - self.brier / self.brier_baseline


@dataclass
class ModelEvaluation:
    name: str
    kind: str
    folds: list[FoldResult] = field(default_factory=list)
    oof_probabilities: np.ndarray | None = None
    oof_labels: np.ndarray | None = None
    calibration: CalibrationReport | None = None
    importances: dict[str, float] = field(default_factory=dict)
    train_seconds: float = 0.0
    error: str | None = None

    @property
    def mean_brier_skill(self) -> float:
        values = [f.brier_skill for f in self.folds]
        return float(np.mean(values)) if values else float("-inf")

    @property
    def std_brier_skill(self) -> float:
        values = [f.brier_skill for f in self.folds]
        return float(np.std(values)) if len(values) > 1 else 0.0

    @property
    def mean_ece(self) -> float:
        values = [f.ece for f in self.folds if np.isfinite(f.ece)]
        return float(np.mean(values)) if values else 1.0

    @property
    def mean_auc(self) -> float | None:
        values = [f.auc for f in self.folds if f.auc is not None]
        return float(np.mean(values)) if values else None

    @property
    def edge_vs_market(self) -> float | None:
        """Mean Brier improvement over simply quoting the market's own price."""
        values = [f.brier_vs_market for f in self.folds if f.brier_vs_market is not None]
        return float(np.mean(values)) if values else None

    @property
    def composite_score(self) -> float:
        """Accuracy, penalised for instability and miscalibration."""
        if self.error or not self.folds:
            return float("-inf")
        return (
            self.mean_brier_skill
            - 0.5 * self.std_brier_skill
            - 0.5 * self.mean_ece
        )

    def row(self) -> dict[str, Any]:
        return {
            "model": self.name,
            "kind": self.kind,
            "folds": len(self.folds),
            "brier_skill": round(self.mean_brier_skill, 5),
            "brier_skill_std": round(self.std_brier_skill, 5),
            "ece": round(self.mean_ece, 5),
            "auc": round(self.mean_auc, 4) if self.mean_auc is not None else None,
            "vs_market": round(self.edge_vs_market, 5)
            if self.edge_vs_market is not None else None,
            "composite": round(self.composite_score, 5),
            "train_s": round(self.train_seconds, 2),
            "error": self.error,
        }


def code_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5
        )
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def evaluate_model(
    model_kind: str,
    dataset: Dataset,
    n_splits: int = 5,
    embargo_seconds: float = 900.0,
    calibration_method: str = "isotonic",
    min_calibration_samples: int = 300,
    sample_weight_halflife: float | None = None,
    params: dict[str, Any] | None = None,
) -> ModelEvaluation:
    """Purged walk-forward evaluation of one model kind."""
    evaluation = ModelEvaluation(name=model_kind, kind=model_kind)
    X, y, timestamps, window_ends = dataset.matrices()
    if len(y) == 0:
        evaluation.error = "no labelled samples"
        return evaluation

    market_probs = dataset.market_probabilities()
    splitter = PurgedWalkForwardSplit(n_splits=n_splits, embargo_seconds=embargo_seconds)

    oof_p: list[float] = []
    oof_y: list[int] = []
    started = time.time()

    try:
        splits = list(splitter.split(window_ends))
    except ValueError as exc:
        evaluation.error = str(exc)
        return evaluation

    for fold_index, (train_idx, val_idx) in enumerate(splits):
        try:
            model = build_model(model_kind, **(params or {}))
            weights = None
            if sample_weight_halflife:
                age = timestamps[train_idx].max() - timestamps[train_idx]
                weights = np.exp(-np.log(2.0) * age / sample_weight_halflife)

            model.fit(X[train_idx], y[train_idx], dataset.feature_names, weights)
            raw_train = model.predict_proba(X[train_idx])
            raw_val = model.predict_proba(X[val_idx])

            # The calibrator only ever sees training-fold outcomes.
            calibrator = Calibrator(calibration_method, min_calibration_samples)
            calibrator.fit(raw_train, y[train_idx])
            calibrated = calibrator.transform_many(raw_val)

            report = evaluate(calibrated, y[val_idx])
            market_brier = None
            vs_market = None
            fold_market = market_probs[val_idx] if len(market_probs) else np.array([])
            if len(fold_market) and np.isfinite(fold_market).any():
                mask = np.isfinite(fold_market)
                if mask.sum() > 10:
                    from ..probability.calibration import brier_score

                    market_brier = brier_score(fold_market[mask], y[val_idx][mask])
                    model_brier = brier_score(calibrated[mask], y[val_idx][mask])
                    vs_market = market_brier - model_brier

            evaluation.folds.append(FoldResult(
                fold=fold_index,
                n_train=len(train_idx),
                n_val=len(val_idx),
                brier=report.brier,
                brier_baseline=report.brier_baseline,
                log_loss=report.log_loss,
                ece=report.ece,
                auc=report.auc,
                brier_vs_market=vs_market,
                market_brier=market_brier,
            ))
            oof_p.extend(calibrated.tolist())
            oof_y.extend(y[val_idx].tolist())
            if fold_index == len(splits) - 1:
                evaluation.importances = model.importances()
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "fold failed",
                extra={"model": model_kind, "fold": fold_index, "error": str(exc)[:200]},
            )
            continue

    evaluation.train_seconds = time.time() - started
    if oof_p:
        evaluation.oof_probabilities = np.array(oof_p)
        evaluation.oof_labels = np.array(oof_y)
        evaluation.calibration = evaluate(evaluation.oof_probabilities, evaluation.oof_labels)
    if not evaluation.folds:
        evaluation.error = evaluation.error or "all folds failed"
    return evaluation


def benchmark(
    dataset: Dataset,
    kinds: list[str] | None = None,
    n_splits: int = 5,
    embargo_seconds: float = 900.0,
    calibration_method: str = "isotonic",
    min_calibration_samples: int = 300,
    sample_weight_halflife: float | None = None,
) -> list[ModelEvaluation]:
    """Evaluate every candidate model, best composite score first."""
    kinds = kinds or available_models()
    results: list[ModelEvaluation] = []
    for kind in kinds:
        log.info("evaluating model", extra={"kind": kind, "samples": len(dataset.labelled)})
        results.append(evaluate_model(
            kind, dataset, n_splits, embargo_seconds, calibration_method,
            min_calibration_samples, sample_weight_halflife,
        ))
    results.sort(key=lambda r: r.composite_score, reverse=True)
    return results


def format_table(results: list[ModelEvaluation]) -> str:
    """The model-selection table, as plain text for logs and reports."""
    headers = ["model", "folds", "brier_skill", "±std", "ece", "auc", "vs_market",
               "composite", "train_s"]
    rows = []
    for result in results:
        row = result.row()
        rows.append([
            row["model"], str(row["folds"]),
            f"{row['brier_skill']:+.4f}" if row["brier_skill"] > -1e30 else "n/a",
            f"{row['brier_skill_std']:.4f}",
            f"{row['ece']:.4f}",
            f"{row['auc']:.3f}" if row["auc"] is not None else "n/a",
            f"{row['vs_market']:+.5f}" if row["vs_market"] is not None else "n/a",
            f"{row['composite']:+.4f}" if row["composite"] > -1e30 else "n/a",
            f"{row['train_s']:.1f}",
        ])
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h)
              for i, h in enumerate(headers)]
    line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
    sep = "  ".join("-" * w for w in widths)
    body = "\n".join("  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in rows)
    return f"{line}\n{sep}\n{body}"


def train_final(
    dataset: Dataset,
    kind: str,
    output_dir: Path,
    calibration_method: str = "isotonic",
    min_calibration_samples: int = 300,
    holdout_fraction: float = 0.2,
    embargo_seconds: float = 900.0,
    seed: int = 42,
    params: dict[str, Any] | None = None,
    extra_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fit the selected model on train, calibrate, and score a held-out tail.

    The holdout is never used for any fitting decision -- it exists purely so the
    reported number is one the model has not been tuned against.
    """
    np.random.seed(seed)
    X, y, timestamps, window_ends = dataset.matrices()
    if len(y) == 0:
        raise ValueError("dataset has no labelled samples")

    splitter = PurgedWalkForwardSplit(embargo_seconds=embargo_seconds)
    train_idx, test_idx = splitter.holdout(window_ends, holdout_fraction)

    if kind == "ensemble":
        model: BaseModel = EnsembleModel([build_model(k) for k in available_models()])
    else:
        model = build_model(kind, **(params or {}))
    model.fit(X[train_idx], y[train_idx], dataset.feature_names)

    raw_train = model.predict_proba(X[train_idx])
    calibrator = Calibrator(calibration_method, min_calibration_samples)
    calibrator.fit(raw_train, y[train_idx])

    raw_test = model.predict_proba(X[test_idx])
    calibrated_test = calibrator.transform_many(raw_test)
    test_report = evaluate(calibrated_test, y[test_idx])
    uncalibrated_report = evaluate(raw_test, y[test_idx])

    market = dataset.market_probabilities()
    market_report = None
    if len(market):
        mask = np.isfinite(market[test_idx])
        if mask.sum() > 10:
            market_report = evaluate(market[test_idx][mask], y[test_idx][mask]).as_dict()

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(model, EnsembleModel):
        model.save(output_dir / "model")
    else:
        model.save(output_dir / "model.pkl")
    calibrator.save(output_dir / "calibrator.json")

    manifest = {
        "created_at": time.time(),
        "model_kind": kind,
        "params": params or {},
        "seed": seed,
        "code_commit": code_commit(),
        "python": platform.python_version(),
        "feature_names": dataset.feature_names,
        "dataset": dataset.describe(),
        "n_train": int(len(train_idx)),
        "n_test": int(len(test_idx)),
        "holdout_fraction": holdout_fraction,
        "embargo_seconds": embargo_seconds,
        "calibration_method": calibration_method,
        "calibrator_fitted": calibrator.is_fitted,
        "test_report": test_report.as_dict(),
        "test_report_uncalibrated": uncalibrated_report.as_dict(),
        "market_report": market_report,
        "importances": dict(list(model.importances().items())[:40]),
    }
    if extra_manifest:
        manifest.update(extra_manifest)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    return manifest
