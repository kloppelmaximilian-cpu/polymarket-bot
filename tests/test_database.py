"""Persistence layer."""

from __future__ import annotations

import asyncio
import json

import pytest

from pmbot.database.repo import Repository
from pmbot.database.schema import INDEXES, TABLES
from pmbot.database.store import Database, _encode


@pytest.fixture
async def db(tmp_path):
    database = Database(f"sqlite:///{tmp_path}/t.db", flush_interval=0.05, batch_size=10)
    await database.start()
    yield database
    await database.stop()


class TestSchema:
    def test_every_required_table_declared(self):
        for name in (
            "markets", "market_states", "book_snapshots", "public_trades",
            "features", "predictions", "signals", "opportunities", "orders",
            "fills", "positions", "pnl_snapshots", "strategy_performance",
            "model_performance", "risk_events", "feed_health", "errors",
            "audit_events", "backtest_runs",
        ):
            assert name in TABLES

    def test_indexes_declared(self):
        assert any("idx_features_market_ts" in ddl for ddl in INDEXES)


class TestStore:
    def test_unsupported_url_rejected(self):
        with pytest.raises(ValueError, match="unsupported"):
            Database("postgres://localhost/db")

    def test_encoder_handles_python_types(self):
        assert _encode(None) is None
        assert _encode(1.5) == 1.5
        assert _encode(True) == 1
        assert json.loads(_encode({"a": [1, 2]})) == {"a": [1, 2]}
        assert isinstance(_encode(object()), str)

    async def test_write_and_read(self, db):
        db.enqueue("risk_events", {
            "ts": 1.0, "kind": "pause", "severity": "critical",
            "message": "test", "detail": {"a": 1},
        })
        assert await db.flush() == 1
        rows = await db.query("SELECT * FROM risk_events")
        assert rows[0]["kind"] == "pause"
        assert json.loads(rows[0]["detail"]) == {"a": 1}

    async def test_upsert_replaces_by_primary_key(self, db):
        base = {
            "market_id": "m1", "condition_id": "0x1", "asset": "BTC",
            "window_start": 1.0, "window_end": 301.0, "up_token_id": "u",
            "down_token_id": "d", "discovered_at": 0.0,
        }
        db.enqueue("markets", {**base, "slug": "first"})
        await db.flush()
        db.enqueue("markets", {**base, "slug": "second"})
        await db.flush()
        rows = await db.query("SELECT slug FROM markets")
        assert len(rows) == 1
        assert rows[0]["slug"] == "second"

    async def test_batched_writes(self, db):
        for i in range(50):
            db.enqueue("features", {
                "ts": float(i), "market_id": "m1", "asset": "BTC",
                "payload": {"x": i},
            })
        await db.flush()
        assert (await db.query("SELECT COUNT(*) c FROM features"))[0]["c"] == 50

    async def test_queue_is_bounded(self, tmp_path):
        database = Database(f"sqlite:///{tmp_path}/t.db", max_queue=5)
        for i in range(20):
            database.enqueue("errors", {"ts": float(i), "component": "x"})
        assert database.stats.dropped > 0
        assert database.pending <= 5

    async def test_enqueue_never_raises(self, db):
        db.enqueue("errors", {"ts": 1.0, "component": "x", "detail": object()})
        await db.flush()

    async def test_bad_sql_is_caught_not_raised(self, db):
        db._queue.append(("INSERT INTO nonexistent VALUES (?)", [1]))
        assert await db.flush() == 0
        assert db.stats.errors >= 1


class TestRepository:
    async def _seed(self, db):
        db.enqueue("markets", {
            "market_id": "m1", "condition_id": "0x1", "asset": "BTC",
            "window_start": 1000.0, "window_end": 1300.0, "up_token_id": "u",
            "down_token_id": "d", "discovered_at": 0.0,
            "resolved_outcome": "UP", "resolved_at": 1301.0,
        })
        db.enqueue("positions", {
            "position_id": "m1:UP", "market_id": "m1", "asset": "BTC",
            "outcome": "UP", "token_id": "u", "size": 40.0, "avg_price": 0.5,
            "fees_paid": 0.35, "opened_at": 1100.0, "window_end": 1300.0,
            "strategy": "momentum", "entry_edge": 0.03, "entry_confidence": 0.7,
            "closed_at": 1301.0, "exit_price": 1.0, "realized_pnl": 19.65,
            "resolution": "UP",
        })
        for i in range(5):
            db.enqueue("features", {
                "ts": 1100.0 + i * 10, "market_id": "m1", "asset": "BTC",
                "window_start": 1000.0, "window_end": 1300.0,
                "payload": {"analytic_up": 0.6 + i * 0.01, "implied_up": 0.55},
            })
        db.enqueue("pnl_snapshots", {"ts": 1300.0, "equity": 1019.65, "drawdown": 0.0})
        await db.flush()

    async def test_recent_trades(self, db):
        await self._seed(db)
        rows = Repository(db).recent_trades()
        assert rows[0]["realized_pnl"] == pytest.approx(19.65)

    async def test_strategy_table(self, db):
        await self._seed(db)
        rows = Repository(db).strategy_table()
        assert rows[0]["strategy"] == "momentum"
        assert rows[0]["trades"] == 1

    async def test_pnl_curve(self, db):
        await self._seed(db)
        assert Repository(db).pnl_curve()[0]["equity"] == pytest.approx(1019.65)

    async def test_builds_a_leakage_safe_training_dataset(self, db):
        await self._seed(db)
        dataset = await Repository(db).build_training_dataset(
            ["analytic_up", "implied_up"]
        )
        labelled = dataset.labelled
        assert len(labelled) == 5
        assert all(s.label == 1 for s in labelled.samples)
        assert all(s.timestamp < s.window_end for s in labelled.samples)
        assert labelled.samples[0].market_probability_up == pytest.approx(0.55)

    async def test_samples_after_the_close_are_excluded(self, db):
        await self._seed(db)
        db.enqueue("features", {
            "ts": 1400.0, "market_id": "m1", "asset": "BTC",
            "window_start": 1000.0, "window_end": 1300.0,
            "payload": {"analytic_up": 1.0},
        })
        await db.flush()
        dataset = await Repository(db).build_training_dataset(["analytic_up"])
        assert all(s.timestamp < 1300.0 for s in dataset.labelled.samples)

    async def test_unresolved_markets_are_not_labelled(self, db):
        db.enqueue("markets", {
            "market_id": "m2", "condition_id": "0x2", "asset": "ETH",
            "window_start": 1000.0, "window_end": 1300.0, "up_token_id": "u2",
            "down_token_id": "d2", "discovered_at": 0.0,
        })
        db.enqueue("features", {
            "ts": 1100.0, "market_id": "m2", "asset": "ETH",
            "window_start": 1000.0, "window_end": 1300.0, "payload": {"analytic_up": 0.6},
        })
        await db.flush()
        dataset = await Repository(db).build_training_dataset(["analytic_up"])
        assert len(dataset.labelled) == 0


class TestConcurrencySafety:
    """A flush running in the executor pool must never race shutdown.

    SQLite with ``check_same_thread=False`` segfaults the interpreter -- it does
    not raise -- if one thread uses a connection while another closes it.  This
    happened for real: the flush loop's in-flight write overlapped
    ``stop()``'s close.
    """

    async def test_shutdown_during_heavy_writing(self, tmp_path):
        database = Database(
            f"sqlite:///{tmp_path}/t.db", flush_interval=0.01, batch_size=5
        )
        await database.start()
        for i in range(5_000):
            database.enqueue("features", {
                "ts": float(i), "market_id": "m1", "asset": "BTC",
                "payload": {"x": i},
            })
        # Stop while the flush loop and backpressure tasks are mid-write.
        await database.stop()
        assert database.stats.errors == 0

    async def test_repeated_start_stop_cycles(self, tmp_path):
        for _ in range(5):
            database = Database(f"sqlite:///{tmp_path}/t.db", flush_interval=0.01)
            await database.start()
            for i in range(200):
                database.enqueue("errors", {"ts": float(i), "component": "x"})
            await database.stop()

    async def test_writes_after_close_are_dropped_not_fatal(self, tmp_path):
        database = Database(f"sqlite:///{tmp_path}/t.db")
        await database.start()
        await database.stop()
        # Writing straight into the closed backend must be a no-op.
        await asyncio.to_thread(
            database.backend.execute_many,
            [("INSERT INTO errors (ts, component) VALUES (?, ?)", [1.0, "x"])],
        )
        assert database.backend.query("SELECT 1") == []

    async def test_concurrent_queries_and_writes(self, tmp_path):
        database = Database(f"sqlite:///{tmp_path}/t.db", flush_interval=0.01)
        await database.start()

        async def writer():
            for i in range(500):
                database.enqueue("errors", {"ts": float(i), "component": "w"})
                if i % 50 == 0:
                    await database.flush()

        async def reader():
            for _ in range(50):
                await database.query("SELECT COUNT(*) c FROM errors")
                await asyncio.sleep(0)

        await asyncio.gather(writer(), reader(), reader())
        await database.stop()
        assert database.stats.errors == 0
