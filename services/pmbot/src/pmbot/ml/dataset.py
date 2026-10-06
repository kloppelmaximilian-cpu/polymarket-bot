"""Training-set construction with explicit leakage controls.

A training sample is one feature vector observed at time ``t`` inside a
five-minute window, labelled with how that window actually resolved.  Two
properties have to hold or the whole exercise is worthless:

**No look-ahead.**  Every feature is produced by the same
:class:`~pmbot.features.engine.FeatureEngine` used live, from observations
timestamped at or before ``t``.  The label is only known after ``window_end``.

**No leakage across splits.**  Samples drawn from the same window are nearly
identical and share a label, so a random train/test split would put near-copies
on both sides and report a fantasy score.  :class:`PurgedWalkForwardSplit`
therefore splits on time, keeps whole windows together, and inserts an embargo
gap so a window adjacent to the boundary cannot influence the next fold.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class TrainingSample:
    market_id: str
    asset: str
    timestamp: float
    window_start: float
    window_end: float
    features: dict[str, float]
    label: int | None = None            # 1 = resolved UP
    market_probability_up: float | None = None
    meta: dict[str, float] = field(default_factory=dict)

    @property
    def is_labelled(self) -> bool:
        return self.label is not None

    def horizon(self) -> float:
        return self.window_end - self.timestamp


@dataclass
class Dataset:
    samples: list[TrainingSample]
    feature_names: list[str]

    def __len__(self) -> int:
        return len(self.samples)

    @property
    def labelled(self) -> Dataset:
        return Dataset([s for s in self.samples if s.is_labelled], self.feature_names)

    def matrices(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """``(X, y, timestamps, window_ids)`` for the labelled samples."""
        rows = [s for s in self.samples if s.is_labelled]
        if not rows:
            empty = np.empty((0, len(self.feature_names)))
            return empty, np.array([]), np.array([]), np.array([])
        X = np.array(
            [[s.features.get(name, np.nan) for name in self.feature_names] for s in rows],
            dtype=float,
        )
        y = np.array([s.label for s in rows], dtype=int)
        t = np.array([s.timestamp for s in rows], dtype=float)
        w = np.array([s.window_end for s in rows], dtype=float)
        return X, y, t, w

    def market_probabilities(self) -> np.ndarray:
        rows = [s for s in self.samples if s.is_labelled]
        return np.array(
            [s.market_probability_up if s.market_probability_up is not None else np.nan
             for s in rows],
            dtype=float,
        )

    def fingerprint(self) -> str:
        """Stable content hash so a backtest can name the exact dataset used."""
        digest = hashlib.sha256()
        digest.update(json.dumps(sorted(self.feature_names)).encode())
        for sample in sorted(self.samples, key=lambda s: (s.timestamp, s.market_id)):
            digest.update(
                f"{sample.market_id}|{sample.timestamp:.3f}|{sample.label}".encode()
            )
        return digest.hexdigest()[:16]

    def describe(self) -> dict:
        rows = [s for s in self.samples if s.is_labelled]
        if not rows:
            return {"n": 0}
        labels = np.array([s.label for s in rows])
        times = np.array([s.timestamp for s in rows])
        return {
            "n": len(rows),
            "n_windows": len({s.market_id for s in rows}),
            "assets": sorted({s.asset for s in rows}),
            "base_rate_up": float(labels.mean()),
            "start": float(times.min()),
            "end": float(times.max()),
            "span_hours": float((times.max() - times.min()) / 3600.0),
            "features": len(self.feature_names),
            "fingerprint": self.fingerprint(),
        }

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "feature_names": self.feature_names,
            "samples": [
                {
                    "market_id": s.market_id, "asset": s.asset,
                    "timestamp": s.timestamp, "window_start": s.window_start,
                    "window_end": s.window_end, "features": s.features,
                    "label": s.label, "market_probability_up": s.market_probability_up,
                    "meta": s.meta,
                }
                for s in self.samples
            ],
        }
        path.write_text(json.dumps(payload))

    @classmethod
    def load(cls, path: Path) -> Dataset:
        payload = json.loads(Path(path).read_text())
        samples = [TrainingSample(**row) for row in payload["samples"]]
        return cls(samples, payload["feature_names"])


class PurgedWalkForwardSplit:
    """Expanding- or rolling-window splits with a purge/embargo gap.

    ``n_splits`` consecutive folds over time.  For fold *i* the training set is
    everything before the fold's validation block (minus an embargo), and the
    validation set is the block itself.  Windows are never split across the
    boundary because the split key is ``window_end``.
    """

    def __init__(
        self,
        n_splits: int = 5,
        embargo_seconds: float = 900.0,
        expanding: bool = True,
        min_train_fraction: float = 0.3,
    ):
        if n_splits < 2:
            raise ValueError("n_splits must be >= 2")
        self.n_splits = n_splits
        self.embargo = embargo_seconds
        self.expanding = expanding
        self.min_train_fraction = min_train_fraction

    def split(
        self, window_ends: Sequence[float]
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        w = np.asarray(window_ends, dtype=float)
        if len(w) == 0:
            return
        unique = np.unique(w)
        if len(unique) < self.n_splits + 1:
            raise ValueError(
                f"need at least {self.n_splits + 1} distinct windows, got {len(unique)}"
            )

        start_index = max(int(len(unique) * self.min_train_fraction), 1)
        boundaries = np.linspace(start_index, len(unique), self.n_splits + 1).astype(int)

        for i in range(self.n_splits):
            val_lo, val_hi = boundaries[i], boundaries[i + 1]
            if val_hi <= val_lo:
                continue
            val_windows = unique[val_lo:val_hi]
            val_start = val_windows[0]

            train_mask = w < (val_start - self.embargo)
            if self.expanding:
                pass
            else:
                span = val_windows[-1] - val_start
                lower = val_start - self.embargo - max(span * 3, 3600.0)
                train_mask &= w >= lower
            val_mask = np.isin(w, val_windows)

            train_idx = np.flatnonzero(train_mask)
            val_idx = np.flatnonzero(val_mask)
            if len(train_idx) == 0 or len(val_idx) == 0:
                continue
            yield train_idx, val_idx

    def holdout(
        self, window_ends: Sequence[float], test_fraction: float = 0.2
    ) -> tuple[np.ndarray, np.ndarray]:
        """A single final train/test cut with the same embargo discipline."""
        w = np.asarray(window_ends, dtype=float)
        unique = np.unique(w)
        if len(unique) < 4:
            raise ValueError("not enough distinct windows for a holdout split")
        cut = unique[int(len(unique) * (1 - test_fraction))]
        train = np.flatnonzero(w < cut - self.embargo)
        test = np.flatnonzero(w >= cut)
        return train, test


def impute(X: np.ndarray, medians: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Median-impute missing features.

    The medians must come from the *training* fold only; passing them in for the
    validation fold is what stops the imputer itself leaking future information.
    """
    if medians is None:
        import warnings

        with warnings.catch_warnings():
            # An all-NaN column is expected (a feature that was never observed);
            # it falls back to zero below rather than propagating a NaN.
            warnings.simplefilter("ignore", RuntimeWarning)
            medians = np.nanmedian(X, axis=0) if X.size else np.zeros(X.shape[1])
        medians = np.where(np.isfinite(medians), medians, 0.0)
    out = np.where(np.isfinite(X), X, medians)
    return out, medians
