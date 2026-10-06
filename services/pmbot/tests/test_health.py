"""System health and self-monitoring."""

from __future__ import annotations

from pmbot.core.health import HealthLevel, HealthMonitor
from pmbot.core.types import FeedHealth, FeedStatus


def feeds(online=3, degraded=0, offline=0) -> list[FeedHealth]:
    out = []
    for i in range(online):
        out.append(FeedHealth(f"on{i}", FeedStatus.ONLINE, score=1.0))
    for i in range(degraded):
        out.append(FeedHealth(f"deg{i}", FeedStatus.DEGRADED, score=0.5))
    for i in range(offline):
        out.append(FeedHealth(f"off{i}", FeedStatus.OFFLINE, score=0.0))
    return out


def polymarket(status=FeedStatus.ONLINE, score=1.0, detail="connected") -> FeedHealth:
    return FeedHealth("polymarket", status, score=score, detail=detail)


class TestComponentHealth:
    def test_all_good(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1000.0)
        assert health.level is HealthLevel.OK
        assert health.should_pause is False
        assert health.size_multiplier == 1.0
        assert health.score > 0.9

    def test_too_few_feeds_pauses(self):
        monitor = HealthMonitor(min_healthy_exchanges=3)
        health = monitor.evaluate(feeds(online=1), polymarket(), {"BTC": True}, 1000.0)
        assert health.level is HealthLevel.CRITICAL
        assert health.should_pause is True
        assert any("healthy reference feeds" in i for i in health.issues)

    def test_polymarket_offline_pauses(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        health = monitor.evaluate(
            feeds(), polymarket(FeedStatus.OFFLINE, 0.0, "stale 40s"),
            {"BTC": True}, 1000.0,
        )
        assert health.should_pause is True
        assert any("websocket offline" in i for i in health.issues)

    def test_polymarket_degraded_halves_size(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        health = monitor.evaluate(
            feeds(), polymarket(FeedStatus.DEGRADED, 0.4, "stale 8s"),
            {"BTC": True}, 1000.0,
        )
        assert health.level is HealthLevel.DEGRADED
        assert health.size_multiplier == 0.5
        assert health.should_pause is False

    def test_unhealthy_composite_degrades(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        health = monitor.evaluate(
            feeds(), polymarket(), {"BTC": True, "ETH": False}, 1000.0
        )
        assert health.level is HealthLevel.DEGRADED
        assert any("ETH" in i for i in health.issues)

    def test_database_errors_degrade(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        health = monitor.evaluate(
            feeds(), polymarket(), {"BTC": True}, 1000.0, db_errors=5
        )
        assert health.level is HealthLevel.DEGRADED


class TestExecutionHealth:
    def test_repeated_failures_pause_trading(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        for i in range(6):
            monitor.record_execution_failure(1000.0 + i)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1010.0)
        assert health.should_pause is True
        assert any("execution failures" in i for i in health.issues)

    def test_a_few_failures_only_reduce_size(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        for i in range(3):
            monitor.record_execution_failure(1000.0 + i)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1010.0)
        assert health.should_pause is False
        assert health.size_multiplier == 0.5

    def test_old_failures_age_out(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        for i in range(6):
            monitor.record_execution_failure(1000.0 + i)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 2000.0)
        assert health.should_pause is False

    def test_api_errors_degrade_at_volume(self):
        monitor = HealthMonitor(min_healthy_exchanges=2)
        for i in range(25):
            monitor.record_api_error(1000.0 + i)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1030.0)
        assert health.level is HealthLevel.DEGRADED


class TestModelDegradation:
    def test_a_good_model_stays_ok(self):
        monitor = HealthMonitor(min_healthy_exchanges=2, min_degradation_samples=40)
        for i in range(60):
            up = i % 10 < 7
            monitor.record_prediction_outcome(0.7 if up else 0.3, up)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1000.0)
        assert health.level is HealthLevel.OK
        assert health.detail["prediction_skill"] > 0

    def test_an_anti_predictive_model_pauses_trading(self):
        """A model can be mechanically healthy while having stopped predicting;
        that failure is the expensive one."""
        monitor = HealthMonitor(min_healthy_exchanges=2, min_degradation_samples=40)
        for i in range(60):
            up = i % 10 < 7
            monitor.record_prediction_outcome(0.3 if up else 0.7, up)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1000.0)
        assert health.should_pause is True
        assert any("degradation" in i for i in health.issues)
        assert health.detail["prediction_skill"] < 0

    def test_too_few_samples_does_not_trip_the_wire(self):
        monitor = HealthMonitor(min_healthy_exchanges=2, min_degradation_samples=100)
        for i in range(20):
            monitor.record_prediction_outcome(0.9, False)
        health = monitor.evaluate(feeds(), polymarket(), {"BTC": True}, 1000.0)
        assert health.should_pause is False

    def test_skill_is_measured_against_the_base_rate(self):
        monitor = HealthMonitor()
        for i in range(50):
            monitor.record_prediction_outcome(0.5, i % 2 == 0)
        skill, samples = monitor.prediction_skill()
        assert samples == 50
        assert abs(skill) < 0.05          # uninformative but not harmful

    def test_no_samples_gives_neutral_skill(self):
        assert HealthMonitor().prediction_skill() == (0.0, 0)

    def test_window_is_bounded(self):
        monitor = HealthMonitor(degradation_window=30)
        for i in range(200):
            monitor.record_prediction_outcome(0.6, True)
        _, samples = monitor.prediction_skill()
        assert samples == 30
