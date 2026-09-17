"""Model artifact loading and versioning.

A model directory is self-describing: the estimator, its calibrator and a
manifest recording the config, seed, dataset fingerprint and code commit that
produced it.  The bot refuses to use an artifact whose feature list does not
match the running feature engine, because a silently-shifted column order is
the worst kind of production bug.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..logging_setup import get_logger
from ..probability.calibration import Calibrator
from .models import BaseModel, EnsembleModel

log = get_logger("pmbot.ml.registry")


@dataclass
class LoadedModel:
    model: BaseModel
    calibrator: Calibrator | None
    manifest: dict[str, Any] = field(default_factory=dict)
    path: Path | None = None

    @property
    def version(self) -> str:
        kind = self.manifest.get("model_kind", self.model.kind)
        commit = str(self.manifest.get("code_commit", "unknown"))[:8]
        fingerprint = (self.manifest.get("dataset") or {}).get("fingerprint", "na")
        return f"{kind}@{commit}/{fingerprint}"

    @property
    def feature_names(self) -> list[str]:
        return self.manifest.get("feature_names") or self.model.feature_names

    @property
    def is_calibrated(self) -> bool:
        return self.calibrator is not None and self.calibrator.is_fitted

    def predict(self, features: dict[str, float]) -> float:
        raw = self.model.predict_one(features)
        if self.calibrator is not None:
            return self.calibrator.transform(raw)
        return raw

    def test_metrics(self) -> dict[str, Any]:
        return self.manifest.get("test_report") or {}


def load_model(directory: Path, expected_features: list[str] | None = None) -> LoadedModel | None:
    """Load a model directory, or ``None`` when it is absent or incompatible."""
    directory = Path(directory)
    if not directory.exists():
        log.info("no model artifact", extra={"path": str(directory)})
        return None

    manifest: dict[str, Any] = {}
    manifest_path = directory / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            log.warning("unreadable manifest", extra={"path": str(manifest_path)})

    model: BaseModel | None = None
    single = directory / "model.pkl"
    bundle = directory / "model"
    try:
        if single.exists():
            model = BaseModel.load(single)
        elif (bundle / "ensemble.json").exists():
            model = EnsembleModel.load_dir(bundle)
    except Exception as exc:  # noqa: BLE001 - a corrupt artifact must not crash startup
        log.warning("failed to load model", extra={"error": str(exc)[:200]})
        return None

    if model is None:
        log.info("model artifact incomplete", extra={"path": str(directory)})
        return None

    calibrator = Calibrator.load(directory / "calibrator.json")

    features = manifest.get("feature_names") or model.feature_names
    if expected_features is not None and features:
        missing = [f for f in features if f not in expected_features]
        if missing:
            log.warning(
                "model expects features the engine does not produce; refusing to load",
                extra={"missing": missing[:8], "n_missing": len(missing)},
            )
            return None

    loaded = LoadedModel(model=model, calibrator=calibrator, manifest=manifest, path=directory)
    log.info(
        "model loaded",
        extra={
            "version": loaded.version,
            "calibrated": loaded.is_calibrated,
            "features": len(features),
        },
    )
    return loaded
