"""Model zoo.

One interface over logistic regression, random forests, gradient boosting,
LightGBM and XGBoost, plus a simple averaging ensemble.  Optional backends are
imported lazily and report themselves unavailable rather than crashing the
process, so the bot runs on a minimal install.

Defaults are deliberately conservative -- shallow trees, strong regularisation,
early stopping where supported.  With a few thousand samples from a handful of
days of five-minute windows, the failure mode is always overfitting, never
underfitting.
"""

from __future__ import annotations

import json
import pickle
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class ModelSpec:
    name: str
    kind: str
    params: dict[str, Any] = field(default_factory=dict)


class BaseModel(ABC):
    kind = "base"

    def __init__(self, name: str | None = None, **params: Any):
        self.name = name or self.kind
        self.params = params
        self.model: Any = None
        self.feature_names: list[str] = []
        self.medians: np.ndarray | None = None
        self.is_fitted = False

    # ------------------------------------------------------------------ API
    @staticmethod
    def available() -> bool:
        return True

    @abstractmethod
    def _build(self) -> Any: ...

    def fit(
        self,
        X: np.ndarray,
        y: np.ndarray,
        feature_names: list[str],
        sample_weight: np.ndarray | None = None,
    ) -> BaseModel:
        from .dataset import impute

        X, self.medians = impute(X)
        self.feature_names = list(feature_names)
        self.model = self._build()
        self._fit_estimator(X, y, sample_weight)
        self.is_fitted = True
        return self

    def _fit_estimator(
        self, X: np.ndarray, y: np.ndarray, sample_weight: np.ndarray | None
    ) -> None:
        """Fit, routing sample weights through whichever API the backend uses."""
        if sample_weight is None:
            self.model.fit(X, y)
            return
        for kwargs in self._weight_kwargs(sample_weight):
            try:
                self.model.fit(X, y, **kwargs)
                return
            except (TypeError, ValueError):
                continue
        self.model.fit(X, y)

    def _weight_kwargs(self, sample_weight: np.ndarray) -> list[dict[str, Any]]:
        return [{"sample_weight": sample_weight}]

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """P(label == 1) for each row."""
        from .dataset import impute

        if not self.is_fitted:
            raise RuntimeError(f"{self.name} is not fitted")
        X, _ = impute(X, self.medians)
        proba = self.model.predict_proba(X)
        return np.asarray(proba)[:, 1]

    def predict_one(self, features: dict[str, float]) -> float:
        row = np.array(
            [[features.get(name, np.nan) for name in self.feature_names]], dtype=float
        )
        return float(self.predict_proba(row)[0])

    def importances(self) -> dict[str, float]:
        if not self.is_fitted:
            return {}
        raw = getattr(self.model, "feature_importances_", None)
        if raw is None:
            coefs = getattr(self.model, "coef_", None)
            if coefs is None:
                return {}
            raw = np.abs(np.asarray(coefs).ravel())
        raw = np.asarray(raw, dtype=float)
        total = raw.sum()
        if total <= 0:
            return {}
        return {
            name: float(value / total)
            for name, value in sorted(
                zip(self.feature_names, raw, strict=False), key=lambda kv: -kv[1]
            )
        }

    # ------------------------------------------------------------ persistence
    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            pickle.dump(
                {
                    "kind": self.kind, "name": self.name, "params": self.params,
                    "model": self.model, "feature_names": self.feature_names,
                    "medians": self.medians, "is_fitted": self.is_fitted,
                },
                handle,
            )

    @classmethod
    def load(cls, path: Path) -> BaseModel:
        with Path(path).open("rb") as handle:
            payload = pickle.load(handle)
        model = build_model(payload["kind"], payload["name"], **payload.get("params", {}))
        model.model = payload["model"]
        model.feature_names = payload["feature_names"]
        model.medians = payload.get("medians")
        model.is_fitted = payload.get("is_fitted", True)
        return model


class LogisticModel(BaseModel):
    """Baseline.  Anything more complex has to beat this out of sample."""

    kind = "logistic"

    def _build(self) -> Any:
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler

        return Pipeline([
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(
                C=self.params.get("C", 0.1),
                max_iter=self.params.get("max_iter", 2000),
                solver="lbfgs",
            )),
        ])

    def _weight_kwargs(self, sample_weight):
        # Inside a Pipeline, weights must be routed to the named step.
        return [{"clf__sample_weight": sample_weight}]

    def importances(self) -> dict[str, float]:
        if not self.is_fitted:
            return {}
        clf = self.model.named_steps["clf"]
        raw = np.abs(clf.coef_.ravel())
        total = raw.sum()
        if total <= 0:
            return {}
        return {
            name: float(v / total)
            for name, v in sorted(zip(self.feature_names, raw, strict=False), key=lambda kv: -kv[1])
        }


class RandomForestModel(BaseModel):
    kind = "random_forest"

    def _build(self) -> Any:
        from sklearn.ensemble import RandomForestClassifier

        return RandomForestClassifier(
            n_estimators=self.params.get("n_estimators", 300),
            max_depth=self.params.get("max_depth", 6),
            min_samples_leaf=self.params.get("min_samples_leaf", 40),
            max_features=self.params.get("max_features", "sqrt"),
            n_jobs=self.params.get("n_jobs", -1),
            random_state=self.params.get("random_state", 42),
            class_weight=self.params.get("class_weight"),
        )


class GradientBoostingModel(BaseModel):
    kind = "gradient_boosting"

    def _build(self) -> Any:
        from sklearn.ensemble import HistGradientBoostingClassifier

        return HistGradientBoostingClassifier(
            max_depth=self.params.get("max_depth", 4),
            learning_rate=self.params.get("learning_rate", 0.05),
            max_iter=self.params.get("max_iter", 300),
            min_samples_leaf=self.params.get("min_samples_leaf", 40),
            l2_regularization=self.params.get("l2_regularization", 1.0),
            early_stopping=self.params.get("early_stopping", True),
            validation_fraction=self.params.get("validation_fraction", 0.15),
            random_state=self.params.get("random_state", 42),
        )


class LightGBMModel(BaseModel):
    kind = "lightgbm"

    @staticmethod
    def available() -> bool:
        try:
            import lightgbm  # noqa: F401
        except ImportError:
            return False
        return True

    def _build(self) -> Any:
        import lightgbm as lgb

        return lgb.LGBMClassifier(
            n_estimators=self.params.get("n_estimators", 400),
            learning_rate=self.params.get("learning_rate", 0.03),
            num_leaves=self.params.get("num_leaves", 15),
            max_depth=self.params.get("max_depth", 5),
            min_child_samples=self.params.get("min_child_samples", 40),
            subsample=self.params.get("subsample", 0.8),
            subsample_freq=self.params.get("subsample_freq", 1),
            colsample_bytree=self.params.get("colsample_bytree", 0.7),
            reg_alpha=self.params.get("reg_alpha", 0.1),
            reg_lambda=self.params.get("reg_lambda", 1.0),
            random_state=self.params.get("random_state", 42),
            n_jobs=self.params.get("n_jobs", -1),
            verbosity=-1,
        )


class XGBoostModel(BaseModel):
    kind = "xgboost"

    @staticmethod
    def available() -> bool:
        try:
            import xgboost  # noqa: F401
        except ImportError:
            return False
        return True

    def _build(self) -> Any:
        import xgboost as xgb

        return xgb.XGBClassifier(
            n_estimators=self.params.get("n_estimators", 400),
            learning_rate=self.params.get("learning_rate", 0.03),
            max_depth=self.params.get("max_depth", 4),
            min_child_weight=self.params.get("min_child_weight", 20),
            subsample=self.params.get("subsample", 0.8),
            colsample_bytree=self.params.get("colsample_bytree", 0.7),
            reg_alpha=self.params.get("reg_alpha", 0.1),
            reg_lambda=self.params.get("reg_lambda", 2.0),
            random_state=self.params.get("random_state", 42),
            n_jobs=self.params.get("n_jobs", -1),
            eval_metric="logloss",
            tree_method="hist",
        )


class EnsembleModel(BaseModel):
    """Equal-weight probability average over several fitted models.

    Averaging probabilities (rather than stacking) keeps the ensemble
    interpretable and avoids fitting yet another layer on the same small
    sample, which is where stacking usually goes wrong here.
    """

    kind = "ensemble"

    def __init__(self, members: list[BaseModel], name: str = "ensemble", **params: Any):
        super().__init__(name, **params)
        self.members = members

    def _build(self) -> Any:
        return None

    def fit(self, X, y, feature_names, sample_weight=None) -> EnsembleModel:
        self.feature_names = list(feature_names)
        for member in self.members:
            member.fit(X, y, feature_names, sample_weight)
        self.is_fitted = True
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if not self.members:
            raise RuntimeError("ensemble has no members")
        stacked = np.vstack([m.predict_proba(X) for m in self.members])
        return stacked.mean(axis=0)

    def importances(self) -> dict[str, float]:
        totals: dict[str, float] = {}
        for member in self.members:
            for name, value in member.importances().items():
                totals[name] = totals.get(name, 0.0) + value
        n = max(len(self.members), 1)
        return {
            name: value / n
            for name, value in sorted(totals.items(), key=lambda kv: -kv[1])
        }

    def save(self, path: Path) -> None:
        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)
        manifest = {"kind": self.kind, "name": self.name, "members": []}
        for i, member in enumerate(self.members):
            filename = f"member_{i}_{member.kind}.pkl"
            member.save(path / filename)
            manifest["members"].append(filename)
        (path / "ensemble.json").write_text(json.dumps(manifest, indent=2))

    @classmethod
    def load_dir(cls, path: Path) -> EnsembleModel:
        path = Path(path)
        manifest = json.loads((path / "ensemble.json").read_text())
        members = [BaseModel.load(path / f) for f in manifest["members"]]
        ensemble = cls(members, manifest.get("name", "ensemble"))
        ensemble.is_fitted = True
        ensemble.feature_names = members[0].feature_names if members else []
        return ensemble


MODEL_REGISTRY: dict[str, type[BaseModel]] = {
    "logistic": LogisticModel,
    "random_forest": RandomForestModel,
    "gradient_boosting": GradientBoostingModel,
    "lightgbm": LightGBMModel,
    "xgboost": XGBoostModel,
}


def build_model(kind: str, name: str | None = None, **params: Any) -> BaseModel:
    cls = MODEL_REGISTRY.get(kind)
    if cls is None:
        raise ValueError(f"unknown model kind: {kind}")
    return cls(name=name, **params)


def available_models() -> list[str]:
    return [kind for kind, cls in MODEL_REGISTRY.items() if cls.available()]
