"""ML layer: leakage controls, model zoo, calibration, anchoring."""

from __future__ import annotations

import math

import numpy as np
import pytest

from pmbot.ml.dataset import (
    Dataset,
    PurgedWalkForwardSplit,
    TrainingSample,
    impute,
)
from pmbot.ml.models import (
    EnsembleModel,
    available_models,
    build_model,
)
from pmbot.ml.registry import load_model
from pmbot.ml.train import benchmark, evaluate_model, format_table, train_final
from pmbot.probability.anchor import (
    RelativeSkillTracker,
    anchor_to_market,
    fit_anchor_weight,
)
from pmbot.probability.calibration import (
    Calibrator,
    auc_score,
    brier_score,
    ece_noise_floor,
    evaluate,
    log_loss,
    reliability_bins,
)

FEATURES = ["a", "b", "c", "d"]


def synthetic_dataset(n_windows=300, per_window=10, seed=3, signal=1.2) -> Dataset:
    rng = np.random.default_rng(seed)
    samples = []
    t0 = 1_760_000_000.0
    for w in range(n_windows):
        window_end = t0 + w * 300
        latent = rng.normal()
        label = int(rng.uniform() < 1 / (1 + math.exp(-signal * latent)))
        for k in range(per_window):
            samples.append(TrainingSample(
                market_id=f"m{w}", asset="BTC", timestamp=window_end - 300 + k * 25,
                window_start=window_end - 300, window_end=window_end,
                features={
                    "a": latent + rng.normal() * 0.3, "b": rng.normal(),
                    "c": latent * 0.5 + rng.normal() * 0.8, "d": rng.normal(),
                },
                label=label,
                market_probability_up=float(np.clip(0.5 + 0.22 * latent, 0.02, 0.98)),
            ))
    return Dataset(samples, FEATURES)


class TestDataset:
    def test_describe(self):
        info = synthetic_dataset(n_windows=20).labelled.describe()
        assert info["n"] == 200
        assert info["n_windows"] == 20
        assert 0.0 < info["base_rate_up"] < 1.0
        assert len(info["fingerprint"]) == 16

    def test_fingerprint_is_content_addressed(self):
        first = synthetic_dataset(n_windows=10, seed=1)
        same = synthetic_dataset(n_windows=10, seed=1)
        different = synthetic_dataset(n_windows=10, seed=2)
        assert first.fingerprint() == same.fingerprint()
        assert first.fingerprint() != different.fingerprint()

    def test_matrices_shape(self):
        dataset = synthetic_dataset(n_windows=10)
        X, y, t, w = dataset.matrices()
        assert X.shape == (100, 4)
        assert len(y) == len(t) == len(w) == 100

    def test_round_trip(self, tmp_path):
        dataset = synthetic_dataset(n_windows=5)
        path = tmp_path / "ds.json"
        dataset.save(path)
        assert len(Dataset.load(path)) == len(dataset)

    def test_unlabelled_samples_excluded(self):
        dataset = synthetic_dataset(n_windows=5)
        dataset.samples.append(TrainingSample(
            "mX", "BTC", 1.0, 0.0, 300.0, {"a": 1.0}, None
        ))
        assert len(dataset.labelled) == len(dataset) - 1


class TestPurgedSplit:
    def test_no_window_appears_on_both_sides(self):
        window_ends = np.repeat(np.arange(60) * 300.0 + 1e9, 10)
        splitter = PurgedWalkForwardSplit(n_splits=5, embargo_seconds=900)
        folds = list(splitter.split(window_ends))
        assert len(folds) == 5
        for train, val in folds:
            assert not (set(window_ends[train]) & set(window_ends[val]))

    def test_embargo_gap_is_respected(self):
        window_ends = np.repeat(np.arange(60) * 300.0 + 1e9, 10)
        splitter = PurgedWalkForwardSplit(n_splits=4, embargo_seconds=1800)
        for train, val in splitter.split(window_ends):
            assert window_ends[val].min() - window_ends[train].max() >= 1800

    def test_training_data_is_always_in_the_past(self):
        window_ends = np.repeat(np.arange(60) * 300.0 + 1e9, 10)
        for train, val in PurgedWalkForwardSplit(n_splits=4).split(window_ends):
            assert window_ends[train].max() < window_ends[val].min()

    def test_expanding_window_grows(self):
        window_ends = np.repeat(np.arange(60) * 300.0 + 1e9, 10)
        sizes = [
            len(train)
            for train, _ in PurgedWalkForwardSplit(n_splits=4, expanding=True).split(
                window_ends
            )
        ]
        assert sizes == sorted(sizes)

    def test_rolling_window_does_not_grow_without_bound(self):
        window_ends = np.repeat(np.arange(120) * 300.0 + 1e9, 5)
        sizes = [
            len(train)
            for train, _ in PurgedWalkForwardSplit(
                n_splits=4, expanding=False, embargo_seconds=600
            ).split(window_ends)
        ]
        assert max(sizes) < len(window_ends)

    def test_holdout_has_a_gap(self):
        window_ends = np.repeat(np.arange(60) * 300.0 + 1e9, 10)
        train, test = PurgedWalkForwardSplit(embargo_seconds=900).holdout(window_ends)
        assert window_ends[test].min() - window_ends[train].max() >= 900

    def test_rejects_too_few_windows(self):
        with pytest.raises(ValueError):
            list(PurgedWalkForwardSplit(n_splits=5).split([1.0, 2.0]))

    def test_rejects_a_single_split(self):
        with pytest.raises(ValueError):
            PurgedWalkForwardSplit(n_splits=1)


class TestImputation:
    def test_medians_from_training_only(self):
        train = np.array([[1.0, 10.0], [3.0, 30.0], [5.0, 50.0]])
        _, medians = impute(train)
        assert medians.tolist() == [3.0, 30.0]
        validation = np.array([[np.nan, np.nan]])
        imputed, _ = impute(validation, medians)
        assert imputed.tolist() == [[3.0, 30.0]]

    def test_all_nan_column_becomes_zero(self):
        imputed, medians = impute(np.array([[np.nan], [np.nan]]))
        assert medians.tolist() == [0.0]
        assert imputed.tolist() == [[0.0], [0.0]]


class TestModels:
    @pytest.mark.parametrize("kind", available_models())
    def test_fit_and_predict(self, kind):
        dataset = synthetic_dataset(n_windows=100)
        X, y, _, _ = dataset.matrices()
        model = build_model(kind)
        model.fit(X[:700], y[:700], FEATURES)
        probabilities = model.predict_proba(X[700:])
        assert len(probabilities) == len(X) - 700
        assert ((probabilities >= 0) & (probabilities <= 1)).all()

    @pytest.mark.parametrize("kind", available_models())
    def test_beats_the_base_rate_on_a_learnable_problem(self, kind):
        dataset = synthetic_dataset(n_windows=200)
        X, y, _, _ = dataset.matrices()
        model = build_model(kind).fit(X[:1400], y[:1400], FEATURES)
        report = evaluate(model.predict_proba(X[1400:]), y[1400:])
        assert report.brier_skill > 0.0, kind

    @pytest.mark.parametrize("kind", available_models())
    def test_single_row_prediction_matches_batch(self, kind):
        dataset = synthetic_dataset(n_windows=60)
        X, y, _, _ = dataset.matrices()
        model = build_model(kind).fit(X, y, FEATURES)
        row = {name: X[0][i] for i, name in enumerate(FEATURES)}
        assert model.predict_one(row) == pytest.approx(model.predict_proba(X[:1])[0])

    @pytest.mark.parametrize("kind", available_models())
    def test_save_and_load(self, kind, tmp_path):
        from pmbot.ml.models import BaseModel

        dataset = synthetic_dataset(n_windows=40)
        X, y, _, _ = dataset.matrices()
        model = build_model(kind).fit(X, y, FEATURES)
        path = tmp_path / f"{kind}.pkl"
        model.save(path)
        restored = BaseModel.load(path)
        assert np.allclose(restored.predict_proba(X[:20]), model.predict_proba(X[:20]))

    def test_unfitted_model_refuses_to_predict(self):
        with pytest.raises(RuntimeError, match="not fitted"):
            build_model("logistic").predict_proba(np.zeros((1, 4)))

    def test_unknown_model_kind(self):
        with pytest.raises(ValueError, match="unknown model"):
            build_model("telepathy")

    def test_importances_sum_to_one(self):
        dataset = synthetic_dataset(n_windows=60)
        X, y, _, _ = dataset.matrices()
        model = build_model("logistic").fit(X, y, FEATURES)
        importances = model.importances()
        assert sum(importances.values()) == pytest.approx(1.0)
        assert importances["a"] > importances["b"]     # 'a' carries the signal

    def test_ensemble_averages_members(self, tmp_path):
        dataset = synthetic_dataset(n_windows=60)
        X, y, _, _ = dataset.matrices()
        ensemble = EnsembleModel([build_model(k) for k in available_models()])
        ensemble.fit(X, y, FEATURES)
        predictions = ensemble.predict_proba(X[:10])
        members = np.vstack([m.predict_proba(X[:10]) for m in ensemble.members])
        assert np.allclose(predictions, members.mean(axis=0))
        ensemble.save(tmp_path / "ens")
        restored = EnsembleModel.load_dir(tmp_path / "ens")
        assert np.allclose(restored.predict_proba(X[:10]), predictions)


class TestTraining:
    def test_walk_forward_evaluation(self):
        dataset = synthetic_dataset(n_windows=200).labelled
        result = evaluate_model("logistic", dataset, n_splits=4,
                                min_calibration_samples=100)
        assert result.error is None
        assert len(result.folds) == 4
        assert result.mean_brier_skill > 0
        assert result.oof_probabilities is not None

    def test_benchmark_ranks_by_composite_score(self):
        dataset = synthetic_dataset(n_windows=150).labelled
        results = benchmark(dataset, kinds=["logistic", "random_forest"],
                            n_splits=3, min_calibration_samples=100)
        scores = [r.composite_score for r in results]
        assert scores == sorted(scores, reverse=True)
        assert "brier_skill" in format_table(results)

    def test_composite_penalises_instability_and_miscalibration(self):
        dataset = synthetic_dataset(n_windows=150).labelled
        result = evaluate_model("logistic", dataset, n_splits=3,
                                min_calibration_samples=100)
        assert result.composite_score <= result.mean_brier_skill

    def test_vs_market_metric_is_computed(self):
        dataset = synthetic_dataset(n_windows=150).labelled
        result = evaluate_model("logistic", dataset, n_splits=3,
                                min_calibration_samples=100)
        assert result.edge_vs_market is not None

    def test_train_final_writes_a_full_manifest(self, tmp_path):
        dataset = synthetic_dataset(n_windows=200).labelled
        manifest = train_final(dataset, "logistic", tmp_path / "model",
                               min_calibration_samples=100)
        for key in ("model_kind", "seed", "code_commit", "feature_names",
                    "dataset", "test_report", "importances"):
            assert key in manifest
        assert (tmp_path / "model" / "model.pkl").exists()
        assert (tmp_path / "model" / "calibrator.json").exists()
        assert (tmp_path / "model" / "manifest.json").exists()

    def test_loaded_model_round_trips(self, tmp_path):
        dataset = synthetic_dataset(n_windows=200).labelled
        train_final(dataset, "logistic", tmp_path / "model",
                    min_calibration_samples=100)
        loaded = load_model(tmp_path / "model", FEATURES)
        assert loaded is not None
        assert loaded.is_calibrated
        assert 0.0 <= loaded.predict({"a": 0.5, "b": 0.0, "c": 0.2, "d": 0.0}) <= 1.0
        assert "logistic" in loaded.version

    def test_model_with_unknown_features_is_refused(self, tmp_path):
        """A silently-shifted feature list is the worst kind of production bug."""
        dataset = synthetic_dataset(n_windows=200).labelled
        train_final(dataset, "logistic", tmp_path / "model",
                    min_calibration_samples=100)
        assert load_model(tmp_path / "model", ["totally", "different"]) is None

    def test_missing_artifact_returns_none(self, tmp_path):
        assert load_model(tmp_path / "nope") is None

    def test_empty_dataset_reports_an_error(self):
        result = evaluate_model("logistic", Dataset([], FEATURES))
        assert result.error is not None


class TestCalibrationMetrics:
    def test_brier_and_log_loss(self):
        assert brier_score([1.0, 0.0], [1, 0]) == 0.0
        assert brier_score([0.0, 1.0], [1, 0]) == 1.0
        assert log_loss([0.5, 0.5], [1, 0]) == pytest.approx(math.log(2))

    def test_auc(self):
        assert auc_score([0.9, 0.1], [1, 0]) == 1.0
        assert auc_score([0.1, 0.9], [1, 0]) == 0.0
        assert auc_score([0.5, 0.5], [1, 0]) == 0.5
        assert auc_score([0.5, 0.5], [1, 1]) is None

    def test_reliability_bins_partition_the_data(self):
        probabilities = np.linspace(0.01, 0.99, 500)
        outcomes = (np.random.default_rng(0).uniform(size=500) < probabilities).astype(int)
        bins, ece, mce = reliability_bins(probabilities, outcomes, n_bins=10)
        assert sum(b["count"] for b in bins) == 500
        assert 0 <= ece <= mce <= 1

    def test_ece_noise_floor_matches_a_calibrated_model(self):
        rng = np.random.default_rng(0)
        for n in (500, 5000):
            probabilities = rng.uniform(0.05, 0.95, n)
            outcomes = (rng.uniform(size=n) < probabilities).astype(int)
            report = evaluate(probabilities, outcomes)
            assert abs(report.ece_excess) < 0.03, n
            assert report.is_well_calibrated

    def test_real_miscalibration_shows_excess(self):
        rng = np.random.default_rng(0)
        true = rng.uniform(0.05, 0.95, 4000)
        outcomes = (rng.uniform(size=4000) < true).astype(int)
        overconfident = np.clip(0.5 + (true - 0.5) * 1.8, 0.01, 0.99)
        report = evaluate(overconfident, outcomes)
        assert report.ece_excess > 0.05
        assert not report.is_well_calibrated

    def test_floor_shrinks_with_sample_size(self):
        rng = np.random.default_rng(0)
        floors = []
        for n in (200, 2000, 20000):
            probabilities = rng.uniform(0.05, 0.95, n)
            outcomes = (rng.uniform(size=n) < probabilities).astype(int)
            bins, _, _ = reliability_bins(probabilities, outcomes)
            floors.append(ece_noise_floor(bins, n))
        assert floors == sorted(floors, reverse=True)


class TestCalibrator:
    @pytest.fixture
    def miscalibrated(self):
        rng = np.random.default_rng(1)
        true = rng.uniform(0.05, 0.95, 6000)
        outcomes = (rng.uniform(size=6000) < true).astype(int)
        raw = np.clip(0.5 + (true - 0.5) * 1.7, 0.01, 0.99)
        return raw, outcomes

    @pytest.mark.parametrize("method", ["isotonic", "platt"])
    def test_improves_out_of_sample_calibration(self, method, miscalibrated):
        raw, outcomes = miscalibrated
        calibrator = Calibrator(method, min_samples=500).fit(raw[:3000], outcomes[:3000])
        before = evaluate(raw[3000:], outcomes[3000:])
        after = evaluate(calibrator.transform_many(raw[3000:]), outcomes[3000:])
        assert after.ece < before.ece
        assert after.brier <= before.brier

    def test_refuses_to_fit_on_too_little_data(self, miscalibrated):
        raw, outcomes = miscalibrated
        calibrator = Calibrator("isotonic", min_samples=10_000).fit(raw[:100], outcomes[:100])
        assert calibrator.is_fitted is False
        assert calibrator.transform(0.77) == 0.77          # identity

    def test_method_none_is_identity(self, miscalibrated):
        raw, outcomes = miscalibrated
        calibrator = Calibrator("none").fit(raw, outcomes)
        assert calibrator.transform(0.31) == 0.31

    def test_single_class_cannot_be_fitted(self):
        calibrator = Calibrator("isotonic", min_samples=10).fit([0.5] * 100, [1] * 100)
        assert calibrator.is_fitted is False

    def test_isotonic_output_is_monotone(self, miscalibrated):
        raw, outcomes = miscalibrated
        calibrator = Calibrator("isotonic", min_samples=500).fit(raw, outcomes)
        grid = np.linspace(0.01, 0.99, 50)
        mapped = calibrator.transform_many(grid)
        assert list(mapped) == sorted(mapped)

    def test_round_trip(self, tmp_path, miscalibrated):
        raw, outcomes = miscalibrated
        calibrator = Calibrator("isotonic", min_samples=500).fit(raw, outcomes)
        path = tmp_path / "cal.json"
        calibrator.save(path)
        restored = Calibrator.load(path)
        assert restored.transform(0.7) == pytest.approx(calibrator.transform(0.7))

    def test_load_missing_or_corrupt(self, tmp_path):
        assert Calibrator.load(tmp_path / "nope.json") is None
        bad = tmp_path / "bad.json"
        bad.write_text("{not json")
        assert Calibrator.load(bad) is None


class TestAnchoring:
    def test_shrinks_toward_the_market(self):
        result = anchor_to_market(0.90, 0.55, 0.35)
        assert 0.55 < result.probability < 0.90
        assert result.shrinkage > 0.4

    def test_weight_one_ignores_the_market(self):
        assert anchor_to_market(0.90, 0.55, 1.0).probability == pytest.approx(0.90)

    def test_weight_zero_defers_entirely(self):
        assert anchor_to_market(0.90, 0.55, 0.0).probability == pytest.approx(0.55)

    def test_no_market_price_means_no_anchoring(self):
        result = anchor_to_market(0.80, None, 0.35)
        assert result.probability == 0.80
        assert result.model_weight == 1.0

    def test_larger_disagreement_adds_more_uncertainty(self):
        small = anchor_to_market(0.57, 0.55, 0.35)
        large = anchor_to_market(0.90, 0.55, 0.35)
        assert large.disagreement_uncertainty > small.disagreement_uncertainty

    def test_uncertainty_does_not_swamp_the_edge(self):
        """Charging the whole disagreement would cancel the shrunk edge and stop
        all trading; only weight uncertainty may be charged."""
        result = anchor_to_market(0.75, 0.58, 0.35, weight_uncertainty=0.10)
        edge = result.probability - result.market_probability
        assert result.disagreement_uncertainty < edge

    def test_symmetric_in_direction(self):
        up = anchor_to_market(0.75, 0.55, 0.4)
        down = anchor_to_market(0.25, 0.45, 0.4)
        assert up.probability - 0.55 == pytest.approx(0.45 - down.probability, abs=1e-9)

    def test_tracker_starts_at_the_prior(self):
        assert RelativeSkillTracker(prior_weight=0.4).weight() == pytest.approx(0.4)

    def test_tracker_is_bounded(self):
        tracker = RelativeSkillTracker(prior_weight=0.35, min_weight=0.1, max_weight=0.8,
                                       prior_strength=10)
        for _ in range(500):
            tracker.record(0.99, 0.5, True)
        assert 0.1 <= tracker.weight() <= 0.8

    def test_tracker_favours_the_better_source(self):
        good_model = RelativeSkillTracker(prior_strength=50)
        good_market = RelativeSkillTracker(prior_strength=50)
        rng = np.random.default_rng(0)
        for _ in range(600):
            up = bool(rng.uniform() < 0.6)
            good_model.record(0.75 if up else 0.25, 0.52 if up else 0.48, up)
            good_market.record(0.52 if up else 0.48, 0.75 if up else 0.25, up)
        assert good_model.weight() > good_market.weight()

    def test_offline_fit_recovers_the_better_source(self):
        rng = np.random.default_rng(0)
        n = 4000
        latent = rng.normal(size=n)
        y = (rng.uniform(size=n) < 1 / (1 + np.exp(-latent))).astype(int)
        sharp = 1 / (1 + np.exp(-(latent + rng.normal(0, 0.2, n))))
        blunt = 1 / (1 + np.exp(-(latent + rng.normal(0, 1.5, n))))
        model_better, _ = fit_anchor_weight(sharp, blunt, y)
        market_better, _ = fit_anchor_weight(blunt, sharp, y)
        assert model_better > market_better

    def test_offline_fit_needs_enough_data(self):
        weight, diagnostics = fit_anchor_weight([0.5] * 10, [0.5] * 10, [1] * 10)
        assert diagnostics["fitted"] is False
        assert weight == 0.35
