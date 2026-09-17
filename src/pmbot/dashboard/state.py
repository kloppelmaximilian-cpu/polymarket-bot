"""Dashboard data source.

The dashboard is a *separate process* from the bot.  It reads the state snapshot
the runner publishes atomically (``data/state.json``) and queries the database
directly for history.  Nothing about the dashboard can block, slow or crash the
trading loop -- which is the whole reason it is not an in-process widget.

If the snapshot is missing or stale the dashboard says so rather than showing
plausible-looking stale numbers.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

STALE_AFTER = 8.0


@dataclass
class DashboardState:
    connected: bool = False
    stale: bool = False
    age: float = 0.0
    error: str = ""
    payload: dict[str, Any] = field(default_factory=dict)

    # ---------------------------------------------------------------- access
    def get(self, key: str, default: Any = None) -> Any:
        return self.payload.get(key, default)

    @property
    def mode(self) -> str:
        return str(self.payload.get("mode", "unknown")).upper()

    @property
    def is_live(self) -> bool:
        return bool(self.payload.get("live_armed", False))

    @property
    def risk(self) -> dict[str, Any]:
        return self.payload.get("risk", {}) or {}

    @property
    def stats(self) -> dict[str, Any]:
        return self.payload.get("stats", {}) or {}

    @property
    def health(self) -> dict[str, Any]:
        return self.payload.get("health", {}) or {}

    @property
    def markets(self) -> list[dict[str, Any]]:
        return self.payload.get("markets", []) or []

    @property
    def signals(self) -> list[dict[str, Any]]:
        return self.payload.get("signals", []) or []

    @property
    def positions(self) -> list[dict[str, Any]]:
        return self.payload.get("positions", []) or []

    @property
    def trades(self) -> list[dict[str, Any]]:
        return self.payload.get("trades", []) or []

    @property
    def feeds(self) -> list[dict[str, Any]]:
        return self.payload.get("feeds", []) or []

    @property
    def alerts(self) -> list[dict[str, Any]]:
        return self.payload.get("alerts", []) or []

    @property
    def strategy_rows(self) -> list[dict[str, Any]]:
        """Merge probability-skill tracking with realised P&L per strategy."""
        performance = self.payload.get("strategy_performance", {}) or {}
        pnl = self.payload.get("strategy_pnl", {}) or {}
        names = sorted(set(performance) | set(pnl))
        rows = []
        for name in names:
            perf = performance.get(name, {})
            money = pnl.get(name, {})
            rows.append({
                "strategy": name,
                "signals": perf.get("n", 0),
                "skill": perf.get("skill", 0.0),
                "brier": perf.get("ewma_brier", float("nan")),
                "trades": money.get("trades", 0),
                "win_rate": money.get("win_rate", 0.0),
                "pnl": money.get("pnl", 0.0),
                "expectancy": money.get("expectancy", 0.0),
                "avg_edge": money.get("avg_edge", 0.0),
                "max_dd": money.get("max_dd", 0.0),
            })
        rows.sort(key=lambda r: (-r["trades"], -r["signals"]))
        return rows

    def warnings(self) -> list[str]:
        """Everything the operator should be told about right now."""
        out: list[str] = []
        if not self.connected:
            out.append(f"bot state unavailable: {self.error or 'no snapshot found'}")
            return out
        if self.stale:
            out.append(f"state snapshot is {self.age:.0f}s old - is the bot running?")
        for issue in self.health.get("issues", []) or []:
            out.append(issue)
        risk = self.risk
        if risk.get("trading_paused"):
            out.append(f"TRADING PAUSED: {risk.get('pause_reason', 'unknown')}")
        drawdown = risk.get("drawdown", 0.0) or 0.0
        if drawdown > 0.10:
            out.append(f"drawdown {drawdown:.1%}")
        for feed in self.feeds:
            if feed.get("status") == "OFFLINE":
                out.append(f"feed offline: {feed.get('name')}")
            elif feed.get("status") == "DEGRADED":
                out.append(f"feed degraded: {feed.get('name')} ({feed.get('detail', '')})")
        for market in self.markets:
            spread = market.get("spread")
            if spread is not None and spread > 0.05:
                out.append(f"wide spread {spread:.3f} on {market.get('asset')}")
            liquidity = market.get("liquidity")
            if liquidity is not None and 0 < liquidity < 100:
                out.append(f"thin book ${liquidity:.0f} on {market.get('asset')}")
        multiplier = self.health.get("size_multiplier", 1.0)
        if multiplier is not None and multiplier < 1.0:
            out.append(f"size reduced to {multiplier:.0%} by self-monitoring")
        # Deduplicate, preserving order.
        seen: set[str] = set()
        unique = []
        for item in out:
            if item not in seen:
                seen.add(item)
                unique.append(item)
        return unique[:8]


class StateReader:
    def __init__(self, path: Path, stale_after: float = STALE_AFTER):
        self.path = Path(path)
        self.stale_after = stale_after

    def read(self) -> DashboardState:
        if not self.path.exists():
            return DashboardState(
                connected=False,
                error=f"{self.path} not found - start the bot first",
            )
        try:
            raw = self.path.read_text()
            payload = json.loads(raw)
        except (OSError, json.JSONDecodeError) as exc:
            return DashboardState(connected=False, error=f"{type(exc).__name__}: {exc}")

        ts = float(payload.get("ts", 0.0) or 0.0)
        age = max(time.time() - ts, 0.0) if ts else float("inf")
        return DashboardState(
            connected=True,
            stale=age > self.stale_after,
            age=age,
            payload=payload,
        )
