"""Read-side queries.

Used by the dashboard, the CLI and the dataset builder.  Kept as explicit SQL
rather than an ORM so what runs against the database is exactly what is written
here -- which matters when a query is on a 2 Hz refresh loop.
"""

from __future__ import annotations

import json
from typing import Any

from .store import Database


class Repository:
    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------- sync side
    def recent_trades(self, limit: int = 30) -> list[dict[str, Any]]:
        return self.db.query_sync(
            """
            SELECT position_id, market_id, asset, outcome, size, avg_price,
                   fees_paid, opened_at, closed_at, exit_price, realized_pnl,
                   resolution, strategy, regime, entry_edge, entry_confidence,
                   entry_model_prob, entry_market_prob
            FROM positions
            WHERE closed_at IS NOT NULL
            ORDER BY closed_at DESC
            LIMIT ?
            """,
            (limit,),
        )

    def open_positions(self) -> list[dict[str, Any]]:
        return self.db.query_sync(
            """
            SELECT position_id, market_id, asset, outcome, token_id, size,
                   avg_price, fees_paid, opened_at, window_end, strategy,
                   entry_edge, entry_confidence
            FROM positions
            WHERE closed_at IS NULL
            ORDER BY opened_at DESC
            """
        )

    def pnl_curve(self, limit: int = 500) -> list[dict[str, Any]]:
        rows = self.db.query_sync(
            "SELECT ts, equity, realized_pnl, unrealized_pnl, drawdown "
            "FROM pnl_snapshots ORDER BY ts DESC LIMIT ?",
            (limit,),
        )
        return list(reversed(rows))

    def strategy_table(self) -> list[dict[str, Any]]:
        return self.db.query_sync(
            """
            SELECT strategy,
                   COUNT(*)                                    AS trades,
                   SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                   SUM(realized_pnl)                           AS pnl,
                   AVG(realized_pnl)                           AS expectancy,
                   AVG(entry_edge)                             AS avg_edge,
                   MIN(realized_pnl)                           AS worst
            FROM positions
            WHERE closed_at IS NOT NULL
            GROUP BY strategy
            ORDER BY pnl DESC
            """
        )

    def recent_opportunities(self, limit: int = 40) -> list[dict[str, Any]]:
        return self.db.query_sync(
            """
            SELECT ts, market_id, asset, outcome, decision, net_edge, required_edge,
                   confidence, model_probability, market_probability, score,
                   regime, seconds_remaining, reasons, blockers
            FROM opportunities
            ORDER BY ts DESC
            LIMIT ?
            """,
            (limit,),
        )

    def risk_events(self, limit: int = 20) -> list[dict[str, Any]]:
        return self.db.query_sync(
            "SELECT ts, kind, severity, message FROM risk_events "
            "ORDER BY ts DESC LIMIT ?",
            (limit,),
        )

    def errors(self, limit: int = 20) -> list[dict[str, Any]]:
        return self.db.query_sync(
            "SELECT ts, component, kind, message FROM errors ORDER BY ts DESC LIMIT ?",
            (limit,),
        )

    def audit_for_market(self, market_id: str) -> list[dict[str, Any]]:
        """Everything recorded about one market, for after-the-fact review."""
        return self.db.query_sync(
            "SELECT ts, kind, payload FROM audit_events WHERE market_id = ? ORDER BY ts",
            (market_id,),
        )

    # ------------------------------------------------------------ async side
    async def resolved_markets(self, limit: int = 5000) -> list[dict[str, Any]]:
        return await self.db.query(
            """
            SELECT market_id, asset, window_start, window_end, resolved_outcome,
                   strike_price, settle_price
            FROM markets
            WHERE resolved_outcome IS NOT NULL
            ORDER BY window_end DESC
            LIMIT ?
            """,
            (limit,),
        )

    async def feature_rows(
        self, market_ids: list[str] | None = None, limit: int = 200_000
    ) -> list[dict[str, Any]]:
        if market_ids:
            placeholders = ",".join("?" for _ in market_ids)
            return await self.db.query(
                f"""
                SELECT ts, market_id, asset, window_start, window_end, payload
                FROM features
                WHERE market_id IN ({placeholders})
                ORDER BY ts
                LIMIT ?
                """,
                (*market_ids, limit),
            )
        return await self.db.query(
            "SELECT ts, market_id, asset, window_start, window_end, payload "
            "FROM features ORDER BY ts LIMIT ?",
            (limit,),
        )

    async def prediction_history(self, limit: int = 20_000) -> list[dict[str, Any]]:
        return await self.db.query(
            """
            SELECT p.ts, p.market_id, p.probability_up, p.implied_up, p.confidence,
                   p.regime, p.model_version, m.resolved_outcome
            FROM predictions p
            JOIN markets m ON m.market_id = p.market_id
            WHERE m.resolved_outcome IS NOT NULL
            ORDER BY p.ts DESC
            LIMIT ?
            """,
            (limit,),
        )

    async def build_training_dataset(
        self, feature_names: list[str], limit: int = 200_000
    ):
        """Assemble a leakage-safe dataset from recorded live/paper sessions.

        Features come from the ``features`` table (written at decision time) and
        labels from ``markets.resolved_outcome`` (known only after the window
        closed), so the join itself cannot introduce look-ahead.
        """
        from ..ml.dataset import Dataset, TrainingSample

        resolved = {
            row["market_id"]: row for row in await self.resolved_markets(limit=100_000)
        }
        if not resolved:
            return Dataset([], feature_names)

        rows = await self.feature_rows(list(resolved), limit=limit)
        samples: list[TrainingSample] = []
        for row in rows:
            market = resolved.get(row["market_id"])
            if market is None or not market.get("resolved_outcome"):
                continue
            try:
                payload = json.loads(row["payload"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            window_end = row.get("window_end") or market["window_end"]
            if row["ts"] >= window_end:
                continue            # never train on an observation from after the close
            samples.append(TrainingSample(
                market_id=row["market_id"],
                asset=row["asset"],
                timestamp=row["ts"],
                window_start=row.get("window_start") or market["window_start"],
                window_end=window_end,
                features={k: float(v) for k, v in payload.items()
                          if isinstance(v, (int, float))},
                label=1 if market["resolved_outcome"] == "UP" else 0,
                market_probability_up=payload.get("implied_up"),
            ))
        return Dataset(samples, feature_names)
