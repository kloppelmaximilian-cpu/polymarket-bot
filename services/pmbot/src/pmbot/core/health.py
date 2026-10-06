"""System-wide health and self-monitoring.

Two distinct things are tracked:

* **Component health** -- is each feed, the database and the venue working?
  Aggregated into a single score the risk engine can act on.
* **Performance degradation** -- is the *model* still working?  A model can be
  perfectly healthy mechanically while having stopped predicting anything, and
  that failure is much more expensive.

Degradation is measured as the rolling Brier skill of recent predictions against
their realised outcomes.  When it turns negative with enough samples behind it,
the bot reduces size and eventually pauses.  The thresholds are deliberately
slow: five-minute outcomes are noisy and a reactive tripwire would fire
constantly.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import Enum

from ..logging_setup import get_logger
from .types import FeedHealth, FeedStatus


class HealthLevel(str, Enum):
    OK = "OK"
    DEGRADED = "DEGRADED"
    CRITICAL = "CRITICAL"


@dataclass
class SystemHealth:
    level: HealthLevel = HealthLevel.OK
    score: float = 1.0
    issues: list[str] = field(default_factory=list)
    size_multiplier: float = 1.0
    should_pause: bool = False
    detail: dict[str, float] = field(default_factory=dict)


class HealthMonitor:
    def __init__(
        self,
        min_healthy_exchanges: int = 2,
        degradation_window: int = 120,
        min_degradation_samples: int = 40,
        degradation_pause_skill: float = -0.06,
        degradation_warn_skill: float = -0.01,
    ):
        self.min_healthy_exchanges = min_healthy_exchanges
        self.min_degradation_samples = min_degradation_samples
        self.pause_skill = degradation_pause_skill
        self.warn_skill = degradation_warn_skill
        self.log = get_logger("pmbot.health")
        self._outcomes: deque[tuple[float, int]] = deque(maxlen=degradation_window)
        self._execution_failures: deque[float] = deque(maxlen=50)
        self._api_errors: deque[float] = deque(maxlen=100)

    # ------------------------------------------------------------- recording
    def record_prediction_outcome(self, probability_up: float, resolved_up: bool) -> None:
        self._outcomes.append((probability_up, 1 if resolved_up else 0))

    def record_execution_failure(self, now: float) -> None:
        self._execution_failures.append(now)

    def record_api_error(self, now: float) -> None:
        self._api_errors.append(now)

    # -------------------------------------------------------------- metrics
    def prediction_skill(self) -> tuple[float, int]:
        """Rolling Brier skill of recent predictions, and the sample count."""
        if len(self._outcomes) < 5:
            return 0.0, len(self._outcomes)
        brier = sum((p - y) ** 2 for p, y in self._outcomes) / len(self._outcomes)
        base_rate = sum(y for _, y in self._outcomes) / len(self._outcomes)
        baseline = sum((base_rate - y) ** 2 for _, y in self._outcomes) / len(self._outcomes)
        if baseline <= 1e-9:
            return 0.0, len(self._outcomes)
        return 1.0 - brier / baseline, len(self._outcomes)

    def recent_rate(self, series: deque[float], now: float, window: float) -> int:
        return sum(1 for ts in series if now - ts <= window)

    # ------------------------------------------------------------- aggregate
    def evaluate(
        self,
        feeds: list[FeedHealth],
        polymarket: FeedHealth | None,
        composite_healthy: dict[str, bool],
        now: float,
        db_errors: int = 0,
    ) -> SystemHealth:
        issues: list[str] = []
        detail: dict[str, float] = {}
        level = HealthLevel.OK
        size_multiplier = 1.0
        should_pause = False

        healthy_feeds = [f for f in feeds if f.status is FeedStatus.ONLINE]
        detail["healthy_exchanges"] = float(len(healthy_feeds))
        if len(healthy_feeds) < self.min_healthy_exchanges:
            issues.append(
                f"only {len(healthy_feeds)} healthy reference feeds "
                f"(need {self.min_healthy_exchanges})"
            )
            level = HealthLevel.CRITICAL
            should_pause = True

        if polymarket is not None:
            detail["polymarket_score"] = polymarket.score
            if polymarket.status is FeedStatus.OFFLINE:
                issues.append("Polymarket websocket offline")
                level = HealthLevel.CRITICAL
                should_pause = True
            elif polymarket.status is FeedStatus.DEGRADED:
                issues.append(f"Polymarket websocket degraded ({polymarket.detail})")
                level = max(level, HealthLevel.DEGRADED, key=_rank)
                size_multiplier = min(size_multiplier, 0.5)

        unhealthy_assets = [a for a, ok in composite_healthy.items() if not ok]
        if unhealthy_assets:
            issues.append(f"composite price unhealthy for {', '.join(unhealthy_assets)}")
            level = max(level, HealthLevel.DEGRADED, key=_rank)

        exec_failures = self.recent_rate(self._execution_failures, now, 300.0)
        detail["execution_failures_5m"] = float(exec_failures)
        if exec_failures >= 5:
            issues.append(f"{exec_failures} execution failures in 5 minutes")
            level = HealthLevel.CRITICAL
            should_pause = True
        elif exec_failures >= 3:
            issues.append(f"{exec_failures} execution failures in 5 minutes")
            level = max(level, HealthLevel.DEGRADED, key=_rank)
            size_multiplier = min(size_multiplier, 0.5)

        api_errors = self.recent_rate(self._api_errors, now, 300.0)
        detail["api_errors_5m"] = float(api_errors)
        if api_errors >= 20:
            issues.append(f"{api_errors} API errors in 5 minutes")
            level = max(level, HealthLevel.DEGRADED, key=_rank)
            size_multiplier = min(size_multiplier, 0.5)

        if db_errors > 0:
            issues.append(f"{db_errors} database errors")
            level = max(level, HealthLevel.DEGRADED, key=_rank)

        skill, samples = self.prediction_skill()
        detail["prediction_skill"] = skill
        detail["prediction_samples"] = float(samples)
        if samples >= self.min_degradation_samples:
            if skill <= self.pause_skill:
                issues.append(
                    f"model degradation: Brier skill {skill:+.3f} over {samples} outcomes"
                )
                level = HealthLevel.CRITICAL
                should_pause = True
            elif skill <= self.warn_skill:
                issues.append(
                    f"model underperforming: Brier skill {skill:+.3f} over {samples}"
                )
                level = max(level, HealthLevel.DEGRADED, key=_rank)
                size_multiplier = min(size_multiplier, 0.5)

        score = 1.0
        score -= 0.3 * (1.0 - min(len(healthy_feeds) / max(self.min_healthy_exchanges, 1), 1.0))
        if polymarket is not None:
            score -= 0.3 * (1.0 - polymarket.score)
        score -= 0.1 * min(exec_failures / 5.0, 1.0)
        score -= 0.1 * min(api_errors / 20.0, 1.0)
        if samples >= self.min_degradation_samples:
            score -= 0.2 * min(max(-skill, 0.0) / 0.1, 1.0)
        score = max(0.0, min(1.0, score))

        return SystemHealth(
            level=level, score=score, issues=issues,
            size_multiplier=size_multiplier, should_pause=should_pause, detail=detail,
        )


_RANKS = {HealthLevel.OK: 0, HealthLevel.DEGRADED: 1, HealthLevel.CRITICAL: 2}


def _rank(level: HealthLevel) -> int:
    return _RANKS[level]
