"""Batched, non-blocking persistence.

Writes go onto an in-memory queue and are flushed in batches by a background
task, inside one transaction per flush.  The hot path never waits on disk,
which matters because the bot writes a feature snapshot per market per second.

SQLite specifics are confined to :class:`SqliteBackend`; swapping in
PostgreSQL or DuckDB means implementing the same three methods.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..logging_setup import get_logger
from .schema import INDEXES, SCHEMA_VERSION, TABLES, UPSERT_TABLES


class Backend(ABC):
    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def execute_many(self, statements: Sequence[tuple[str, Sequence[Any]]]) -> None: ...

    @abstractmethod
    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]: ...


class SqliteBackend(Backend):
    """SQLite behind a mutex.

    The connection is opened with ``check_same_thread=False`` because writes are
    dispatched to the asyncio executor pool, which means *different* threads
    touch it over time.  SQLite tolerates that only if the accesses are
    serialised: two threads using one connection concurrently -- in particular a
    flush still running in the pool while shutdown closes the connection --
    segfaults the interpreter rather than raising.  The lock below is what makes
    the arrangement safe, and it is cheap because every access is already a
    short batched transaction.
    """

    def __init__(self, path: Path, timeout: float = 30.0):
        self.path = Path(path)
        self.timeout = timeout
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.RLock()
        self._closed = False

    def connect(self) -> None:
        with self._lock:
            self._connect_locked()

    def _connect_locked(self) -> None:
        if self._conn is not None:
            return
        self._closed = False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self.path), timeout=self.timeout, check_same_thread=False
        )
        self._conn.row_factory = sqlite3.Row
        cursor = self._conn.cursor()
        # WAL keeps readers (the dashboard) from blocking the writer.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=10000")
        for ddl in TABLES.values():
            cursor.execute(ddl)
        for ddl in INDEXES:
            cursor.execute(ddl)
        cursor.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            if self._conn is not None:
                with contextlib.suppress(sqlite3.Error):
                    self._conn.commit()
                with contextlib.suppress(sqlite3.Error):
                    self._conn.close()
                self._conn = None

    def execute_many(self, statements: Sequence[tuple[str, Sequence[Any]]]) -> None:
        with self._lock:
            if self._closed:
                # Shutdown won the race; dropping a batch here is correct, and
                # far better than touching a closed connection.
                return
            self._connect_locked()
            assert self._conn is not None
            cursor = self._conn.cursor()
            try:
                for sql, params in statements:
                    cursor.execute(sql, params)
                self._conn.commit()
            except sqlite3.Error:
                with contextlib.suppress(sqlite3.Error):
                    self._conn.rollback()
                raise

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            if self._closed:
                return []
            self._connect_locked()
            assert self._conn is not None
            cursor = self._conn.cursor()
            cursor.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]


@dataclass
class DbStats:
    queued: int = 0
    written: int = 0
    flushes: int = 0
    errors: int = 0
    dropped: int = 0
    last_flush_at: float = 0.0
    last_error: str = ""

    def as_dict(self) -> dict:
        return {
            "queued": self.queued, "written": self.written, "flushes": self.flushes,
            "errors": self.errors, "dropped": self.dropped,
            "last_flush_at": self.last_flush_at, "last_error": self.last_error[:200],
        }


class Database:
    """Async facade over a :class:`Backend`."""

    def __init__(
        self,
        url: str,
        flush_interval: float = 2.0,
        batch_size: int = 200,
        max_queue: int = 100_000,
    ):
        self.url = url
        self.flush_interval = flush_interval
        self.batch_size = batch_size
        self.max_queue = max_queue
        self.log = get_logger("pmbot.database")
        self.stats = DbStats()
        self.backend = self._make_backend(url)
        self._queue: list[tuple[str, Sequence[Any]]] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._pending_flushes: set[asyncio.Task] = set()
        self._stop = asyncio.Event()

    @staticmethod
    def _make_backend(url: str) -> Backend:
        if url.startswith("sqlite:///"):
            return SqliteBackend(Path(url[len("sqlite:///"):]))
        if url == "sqlite:///:memory:" or url.endswith(":memory:"):
            return SqliteBackend(Path(":memory:"))
        raise ValueError(
            f"unsupported DATABASE_URL {url!r}; implement a Backend for it "
            "(the interface is three methods)"
        )

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        await asyncio.to_thread(self.backend.connect)
        self._stop.clear()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._flush_loop(), name="db-flush")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            # Let the loop notice the stop flag and finish its current flush
            # rather than cancelling mid-write; only force it if it hangs.
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._task
            self._task = None
        if self._pending_flushes:
            await asyncio.gather(*list(self._pending_flushes), return_exceptions=True)
        await self.flush()
        await asyncio.to_thread(self.backend.close)

    async def _flush_loop(self) -> None:
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=self.flush_interval)
            try:
                await self.flush()
            except Exception as exc:  # noqa: BLE001 - never kill the writer
                self.stats.errors += 1
                self.stats.last_error = str(exc)
                self.log.warning("flush failed", extra={"error": str(exc)[:200]})
            if self._stop.is_set():
                return

    # ----------------------------------------------------------------- write
    def enqueue(self, table: str, row: dict[str, Any]) -> None:
        """Queue one row.  Never raises and never blocks the caller."""
        if len(self._queue) >= self.max_queue:
            self.stats.dropped += 1
            return
        columns = list(row)
        placeholders = ", ".join("?" for _ in columns)
        verb = "INSERT OR REPLACE INTO" if table in UPSERT_TABLES else "INSERT INTO"
        sql = f"{verb} {table} ({', '.join(columns)}) VALUES ({placeholders})"
        self._queue.append((sql, [_encode(row[c]) for c in columns]))
        self.stats.queued += 1
        if len(self._queue) >= self.batch_size * 4 and not self._stop.is_set():
            # Backpressure: schedule an immediate flush rather than growing.
            # The task is tracked so shutdown can await it instead of leaving a
            # write running against a connection that is about to close.
            with contextlib.suppress(RuntimeError):
                task = asyncio.get_running_loop().create_task(self.flush())
                self._pending_flushes.add(task)
                task.add_done_callback(self._pending_flushes.discard)

    def enqueue_many(self, table: str, rows: Iterable[dict[str, Any]]) -> None:
        for row in rows:
            self.enqueue(table, row)

    async def flush(self) -> int:
        async with self._lock:
            if not self._queue:
                return 0
            batch, self._queue = self._queue, []
        try:
            await asyncio.to_thread(self.backend.execute_many, batch)
        except Exception as exc:  # noqa: BLE001
            self.stats.errors += 1
            self.stats.last_error = str(exc)
            self.log.warning(
                "batch write failed",
                extra={"rows": len(batch), "error": str(exc)[:200]},
            )
            return 0
        self.stats.written += len(batch)
        self.stats.flushes += 1
        self.stats.last_flush_at = time.time()
        return len(batch)

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        await asyncio.to_thread(self.backend.execute_many, [(sql, params)])

    # ------------------------------------------------------------------ read
    async def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.backend.query, sql, params)

    def query_sync(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        """Synchronous read, used by the dashboard's own thread."""
        return self.backend.query(sql, params)

    @property
    def pending(self) -> int:
        return len(self._queue)


def _encode(value: Any) -> Any:
    """SQLite accepts a narrow set of types; everything else becomes JSON."""
    if value is None or isinstance(value, (int, float, str, bytes)):
        return value
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (dict, list, tuple, set)):
        return json.dumps(value, default=str)
    return str(value)
