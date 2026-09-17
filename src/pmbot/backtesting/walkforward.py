"""Walk-forward backtesting.

The session is cut into consecutive time slices.  For slice *k*:

1. Training data is the feature/label samples harvested from slices ``0..k-1``
   only -- and only from windows that had already *resolved* before slice *k*
   began, with an embargo gap so a window straddling the boundary contributes
   to neither side.
2. A model is fitted and calibrated on that data alone.
3. Slice *k* is then replayed with that model attached.  Its results are
   out-of-sample by construction.
4. Repeat, expanding (or rolling) the training window.

This is the only honest way to report a number here.  Training on the whole
history and then reporting performance on that same history measures how well
the model memorised, which on a few hundred five-minute windows is close to
perfect and completely meaningless.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..config import Settings
from ..logging_setup import get_logger
from ..ml.dataset import Dataset
from ..ml.models import BaseModel, build_model
from ..ml.registry import LoadedModel
from ..probability.calibration import CalibrationReport, Calibrator, evaluate
from .engine import BacktestConfig, BacktestEngine
from .metrics import PerformanceReport, TradeRecord, evaluate_trades
from .replay import ReplaySession

log = get_logger("pmbot.walkforward")


@dataclass
class SliceResult:
    index: int
    start: float
    end: float
    n_train_samples: int
    n_train_windows: int
    model_kind: str | None
    calibrated: bool
    report: PerformanceReport
    trades: list[TradeRecord]
    calibration: CalibrationReport | None
    diagnostics: dict[str, Any] = field(default_factory=dict)

    def row(self) -> dict[str, Any]:
        return {
            "slice": self.index,
            "hours": round((self.end - self.start) / 3600.0, 2),
            "train_samples": self.n_train_samples,
            "train_windows": self.n_train_windows,
            "model": self.model_kind or "analytic-only",
            "calibrated": self.calibrated,
            "trades": self.report.trades,
            "win_rate": round(self.report.win_rate, 4),
            "pnl": round(self.report.total_pnl, 2),
            "expectancy_per_dollar": round(self.report.expectancy_per_dollar, 5),
            "max_drawdown": round(self.report.max_drawdown, 2),
            "brier": round(self.report.brier, 5) if self.report.brier == self.report.brier else None,
            "brier_skill": (
                round(self.report.brier_skill, 5)
                if self.report.brier_skill == self.report.brier_skill else None
            ),
            "oos_brier_skill": (
                round(self.calibration.brier_skill, 5) if self.calibration else None
            ),
            "oos_ece_excess": (
                round(self.calibration.ece_excess, 5) if self.calibration else None
            ),
        }


@dataclass
class WalkForwardResult:
    slices: list[SliceResult]
    combined: PerformanceReport
    combined_calibration: CalibrationReport | None
    manifest: dict[str, Any] = field(default_factory=dict)

    MIN_TRADES_PER_SCORED_SLICE = 5
    MIN_SCORED_SLICES = 3

    @property
    def scored_slices(self) -> list[SliceResult]:
        """Slices that traded often enough for their expectancy to mean anything."""
        return [
            s for s in self.slices
            if s.report.trades >= self.MIN_TRADES_PER_SCORED_SLICE
        ]

    @property
    def is_stable(self) -> bool:
        """Positive expectancy in the clear majority of out-of-sample slices.

        False also when there is simply not enough evidence -- the caller gets
        no credit for a run that never traded.  Use :attr:`stability` when the
        difference between "unstable" and "undecidable" matters.
        """
        return self.stability == "stable"

    @property
    def stability(self) -> str:
        """``stable`` | ``unstable`` | ``insufficient evidence``.

        Separated from :attr:`is_stable` because a walk-forward that produced
        two trades has not shown instability, it has shown nothing, and
        reporting that as a plain failure invites exactly the wrong reaction
        (retune until the flag turns green).
        """
        scored = self.scored_slices
        if len(scored) < self.MIN_SCORED_SLICES:
            return "insufficient evidence"
        positive = sum(1 for s in scored if s.report.expectancy_per_dollar > 0)
        return "stable" if positive / len(scored) >= 0.6 else "unstable"

    def stability_detail(self) -> str:
        """One line naming why the verdict came out the way it did."""
        scored = self.scored_slices
        if len(scored) < self.MIN_SCORED_SLICES:
            return (
                f"only {len(scored)} of {len(self.slices)} slice(s) reached "
                f"{self.MIN_TRADES_PER_SCORED_SLICE} trades; "
                f"{self.MIN_SCORED_SLICES} needed to judge stability"
            )
        positive = sum(1 for s in scored if s.report.expectancy_per_dollar > 0)
        return (
            f"{positive} of {len(scored)} scored slice(s) had positive "
            f"expectancy (60% needed)"
        )

    def table(self) -> str:
        headers = [
            "slice", "hours", "trainN", "model", "cal", "trades", "win%",
            "pnl", "exp/$", "maxDD", "oosSkill", "eceExc",
        ]
        rows = []
        for result in self.slices:
            row = result.row()
            rows.append([
                str(row["slice"]), f"{row['hours']:.2f}", str(row["train_samples"]),
                str(row["model"])[:16], "yes" if row["calibrated"] else "no",
                str(row["trades"]), f"{row['win_rate']:.1%}",
                f"{row['pnl']:+.2f}", f"{row['expectancy_per_dollar']:+.5f}",
                f"{row['max_drawdown']:.2f}",
                f"{row['oos_brier_skill']:+.4f}" if row["oos_brier_skill"] is not None else "n/a",
                f"{row['oos_ece_excess']:+.4f}" if row["oos_ece_excess"] is not None else "n/a",
            ])
        widths = [
            max(len(h), *(len(r[i]) for r in rows)) if rows else len(h)
            for i, h in enumerate(headers)
        ]
        header_line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
        separator = "  ".join("-" * w for w in widths)
        body = "\n".join(
            "  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in rows
        )
        return f"{header_line}\n{separator}\n{body}"

    def save(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "manifest": self.manifest,
            "is_stable": self.is_stable,
            "stability": self.stability,
            "stability_detail": self.stability_detail(),
            "slices": [s.row() for s in self.slices],
            "combined": self.combined.as_dict(),
            "combined_calibration": (
                self.combined_calibration.as_dict() if self.combined_calibration else None
            ),
            "by_strategy": self.combined.by_strategy,
            "by_regime": self.combined.by_regime,
        }, indent=2, default=str))
        return path


class _InlineModel(LoadedModel):
    """A freshly fitted model wrapped in the runtime's loader interface."""

    def __init__(self, model: BaseModel, calibrator: Calibrator, skill: float, tag: str):
        super().__init__(
            model=model, calibrator=calibrator,
            manifest={
                "model_kind": model.kind,
                "feature_names": model.feature_names,
                "code_commit": tag,
                "test_report": {"brier_skill": skill},
                "dataset": {"fingerprint": tag},
            },
        )


def split_session(session: ReplaySession, n_slices: int) -> list[tuple[float, float]]:
    """Equal-duration time slices covering the session."""
    if n_slices < 2:
        raise ValueError("n_slices must be >= 2")
    start, end = session.start, session.end
    if end <= start:
        raise ValueError("session has no duration")
    edges = np.linspace(start, end, n_slices + 1)
    return [(float(edges[i]), float(edges[i + 1])) for i in range(n_slices)]


def _sub_session(session: ReplaySession, start: float, end: float, warmup: float) -> ReplaySession:
    """A view of the session covering ``[start-warmup, end)``.

    The warmup prefix exists so the volatility estimator, price history and
    strike registry are primed when the slice's first decision is made -- it is
    *input* data, not extra trading time: markets are filtered to those whose
    window falls inside the slice proper.
    """
    lo = start - warmup
    events = [e for e in session.events if lo <= e.ts < end]
    markets = [
        m for m in session.markets
        if start <= m.window_start and m.window_end <= end
    ]
    truth = {m.market_id: session.truth[m.market_id] for m in markets if m.market_id in session.truth}
    return ReplaySession(
        markets=markets, events=events, truth=truth,
        label=f"{session.label}-slice", meta=dict(session.meta),
        synthetic=session.synthetic,
    )


def run_walkforward(
    settings: Settings,
    session: ReplaySession,
    n_slices: int = 4,
    model_kind: str | None = "logistic",
    calibration_method: str = "isotonic",
    min_train_samples: int = 400,
    min_calibration_samples: int = 200,
    embargo_seconds: float = 600.0,
    warmup_seconds: float = 900.0,
    expanding: bool = True,
    decision_interval: float = 1.0,
    label: str = "walkforward",
    seed: int = 42,
) -> WalkForwardResult:
    slices = split_session(session, n_slices)
    accumulated: Dataset | None = None
    results: list[SliceResult] = []
    all_trades: list[TradeRecord] = []
    oos_probabilities: list[float] = []
    oos_labels: list[int] = []

    for index, (start, end) in enumerate(slices):
        model: LoadedModel | None = None
        calibrator: Calibrator | None = None
        model_tag: str | None = None

        if accumulated is not None and model_kind:
            # Only windows that resolved strictly before this slice began (minus
            # the embargo) may inform the model used inside it.
            usable = [
                s for s in accumulated.samples
                if s.is_labelled and s.window_end < start - embargo_seconds
            ]
            if len(usable) >= min_train_samples:
                train = Dataset(usable, accumulated.feature_names)
                X, y, _, _ = train.matrices()
                if len(np.unique(y)) >= 2:
                    estimator = build_model(model_kind)
                    estimator.fit(X, y, train.feature_names)
                    raw = estimator.predict_proba(X)
                    calibrator = Calibrator(calibration_method, min_calibration_samples)
                    calibrator.fit(raw, y)
                    in_sample = evaluate(calibrator.transform_many(raw), y)
                    model = _InlineModel(
                        estimator, calibrator, in_sample.brier_skill,
                        f"wf{index}-{train.fingerprint()}",
                    )
                    model_tag = model_kind
                    log.info(
                        "walk-forward slice model fitted",
                        extra={
                            "slice": index, "train_samples": len(usable),
                            "in_sample_skill": round(in_sample.brier_skill, 4),
                        },
                    )

        slice_settings = settings.model_copy(update={
            "ml_enabled": model is not None,
            "enabled_strategies": (
                list(settings.enabled_strategies)
                if model is None or "ml" in settings.enabled_strategies
                else [*settings.enabled_strategies, "ml"]
            ),
        })
        sub = _sub_session(session, start, end, warmup_seconds)
        if not sub.markets:
            continue

        engine = BacktestEngine(
            slice_settings, sub,
            BacktestConfig(
                decision_interval=decision_interval,
                label=f"{label}-s{index}", seed=seed + index,
            ),
            model=model, calibrator=calibrator,
        )
        result = engine.run()

        slice_calibration = None
        labelled = [s for s in result.dataset.samples if s.is_labelled]
        if model is not None and labelled:
            probabilities = [model.predict(s.features) for s in labelled]
            slice_calibration = evaluate(
                probabilities, [int(s.label or 0) for s in labelled]
            )
            oos_probabilities.extend(probabilities)
            oos_labels.extend(int(s.label or 0) for s in labelled)

        results.append(SliceResult(
            index=index, start=start, end=end,
            n_train_samples=len(
                [s for s in (accumulated.samples if accumulated else [])
                 if s.is_labelled and s.window_end < start - embargo_seconds]
            ),
            n_train_windows=len({
                s.market_id for s in (accumulated.samples if accumulated else [])
                if s.is_labelled and s.window_end < start - embargo_seconds
            }),
            model_kind=model_tag, calibrated=bool(calibrator and calibrator.is_fitted),
            report=result.report, trades=result.trades,
            calibration=slice_calibration,
            diagnostics={
                k: v for k, v in result.diagnostics.items()
                if k in ("evaluations", "tradable", "orders", "top_blockers")
            },
        ))
        all_trades.extend(result.trades)

        # Grow (or roll) the training pool with this slice's harvested samples.
        new_samples = [s for s in result.dataset.samples if s.is_labelled]
        if accumulated is None:
            accumulated = Dataset(new_samples, result.dataset.feature_names)
        elif expanding:
            accumulated = Dataset(
                accumulated.samples + new_samples, accumulated.feature_names
            )
        else:
            accumulated = Dataset(new_samples, accumulated.feature_names)

    combined = evaluate_trades(all_trades, settings.bankroll)
    combined_calibration = (
        evaluate(oos_probabilities, oos_labels) if oos_probabilities else None
    )
    from ..ml.train import code_commit

    return WalkForwardResult(
        slices=results, combined=combined,
        combined_calibration=combined_calibration,
        manifest={
            "label": label, "n_slices": n_slices, "model_kind": model_kind,
            "calibration_method": calibration_method,
            "embargo_seconds": embargo_seconds, "warmup_seconds": warmup_seconds,
            "expanding": expanding, "seed": seed,
            "code_commit": code_commit(),
            "session": session.describe(),
            "config": settings.redacted_dict(),
        },
    )


@dataclass
class SeedSweepResult:
    """Several independent walk-forwards, reported together.

    One walk-forward over a few hundred five-minute windows yields twenty to
    forty trades.  At that count the P&L is dominated by which side of a
    handful of coin flips landed, so a single run -- ours included -- cannot
    distinguish a working strategy from a lucky seed.  Reporting the spread is
    the only defensible way to quote these numbers.
    """

    runs: list[tuple[int, WalkForwardResult]]
    label: str = "seed sweep"

    @property
    def pooled_trades(self) -> list[TradeRecord]:
        return [t for _, run in self.runs for s in run.slices for t in s.trades]

    @property
    def pooled(self) -> PerformanceReport:
        """Aggregate of every trade from every seed.

        Path-dependent fields (drawdown, streaks, the equity curve) are
        meaningless here -- concatenating independent worlds is not a path --
        so :meth:`summary` prints only the fields that survive pooling.
        """
        return evaluate_trades(self.pooled_trades)

    @property
    def seeds_profitable(self) -> int:
        return sum(1 for _, r in self.runs if r.combined.total_pnl > 0)

    def summary(self) -> str:
        pooled = self.pooled
        pnls = sorted(r.combined.total_pnl for _, r in self.runs)
        n = len(self.runs)
        median = (
            pnls[n // 2] if n % 2 else (pnls[n // 2 - 1] + pnls[n // 2]) / 2.0
        ) if pnls else float("nan")
        lines = [
            f"seeds                 {n}",
            f"seeds profitable      {self.seeds_profitable}/{n}",
            f"P&L      worst {pnls[0]:+.2f}   median {median:+.2f}   "
            f"best {pnls[-1]:+.2f}" if pnls else "P&L      n/a",
            "",
            "pooled over every seed (path-dependent fields omitted: the seeds",
            "are independent worlds, so their concatenation is not a path)",
            f"trades                {pooled.trades}",
            f"win rate              {pooled.win_rate:.2%} "
            f"({pooled.wins}W/{pooled.losses}L)",
            f"total P&L             {pooled.total_pnl:+.2f}",
            f"expectancy/$ staked   {pooled.expectancy_per_dollar:+.4f}",
            f"profit factor         {pooled.profit_factor:.3f}",
            f"avg edge at entry     {pooled.avg_edge:+.4f}",
            f"realised - expected   {pooled.realised_vs_expected_edge:+.4f}",
        ]
        return "\n".join(lines)

    def table(self) -> str:
        headers = ["seed", "trades", "win%", "pnl", "exp/$", "pf", "stability"]
        rows = [
            [
                str(seed), str(r.combined.trades), f"{r.combined.win_rate:.1%}",
                f"{r.combined.total_pnl:+.2f}",
                f"{r.combined.expectancy_per_dollar:+.5f}",
                f"{r.combined.profit_factor:.3f}", r.stability,
            ]
            for seed, r in self.runs
        ]
        widths = [
            max(len(h), *(len(row[i]) for row in rows)) if rows else len(h)
            for i, h in enumerate(headers)
        ]
        header_line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
        separator = "  ".join("-" * w for w in widths)
        body = "\n".join(
            "  ".join(c.ljust(w) for c, w in zip(row, widths)) for row in rows
        )
        return f"{header_line}\n{separator}\n{body}"

    def as_dict(self) -> dict[str, Any]:
        pooled = self.pooled
        return {
            "label": self.label,
            "seeds": [seed for seed, _ in self.runs],
            "seeds_profitable": self.seeds_profitable,
            "per_seed": [
                {"seed": seed, **r.combined.as_dict()} for seed, r in self.runs
            ],
            "pooled": {
                "trades": pooled.trades,
                "win_rate": pooled.win_rate,
                "total_pnl": pooled.total_pnl,
                "expectancy_per_dollar": pooled.expectancy_per_dollar,
                "profit_factor": pooled.profit_factor,
                "avg_edge": pooled.avg_edge,
                "realised_vs_expected_edge": pooled.realised_vs_expected_edge,
            },
        }

    def save(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.as_dict(), indent=2, default=str))
        return path
