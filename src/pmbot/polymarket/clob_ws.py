"""Polymarket CLOB market-channel WebSocket.

Subscribes by token id, keeps the local order books in sync, and surfaces the
events the strategy layer needs (trades, tick-size changes, resolutions).

Operational notes baked in:

* ``PING`` must be sent every 10s as *text*; missing it drops the connection.
* ``custom_feature_enabled: true`` is required for ``best_bid_ask``,
  ``new_market`` and ``market_resolved`` events.
* ``tick_size_change`` must be honoured -- quoting against a stale tick size
  gets orders rejected.
* Subscriptions can be modified in place with ``operation: subscribe/unsubscribe``
  as markets roll over every five minutes, which avoids a reconnect storm.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import time
from collections.abc import Callable
from typing import Any

from ..core.types import FeedHealth, FeedStatus, Side
from ..logging_setup import get_logger
from ..orderbook.book import OrderBookManager
from .parsers import as_float, parse_book

EventHandler = Callable[[str, dict[str, Any]], None]


class PolymarketMarketFeed:
    """Resilient market-data websocket client."""

    name = "polymarket"

    def __init__(
        self,
        book_manager: OrderBookManager,
        url: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
        ping_interval: float = 10.0,
        stale_after: float = 5.0,
        reconnect_base: float = 1.0,
        reconnect_max: float = 30.0,
        on_event: EventHandler | None = None,
    ):
        self.books = book_manager
        self.url = url
        self.ping_interval = ping_interval
        self.stale_after = stale_after
        self.reconnect_base = reconnect_base
        self.reconnect_max = reconnect_max
        self.on_event = on_event
        self.log = get_logger("pmbot.polymarket.ws")

        self.health = FeedHealth(name=self.name)
        self.tokens: set[str] = set()
        self.resolved: dict[str, str] = {}      # condition_id -> winning token id

        self._ws: Any = None
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._pending_ops: asyncio.Queue[tuple[str, list[str]]] = asyncio.Queue()
        self._msg_times: list[float] = []
        self._parse_errors = 0

    # -------------------------------------------------------------- control
    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self.run(), name="pm-market-ws")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.health.status = FeedStatus.OFFLINE

    async def set_tokens(self, token_ids: set[str]) -> None:
        """Reconcile the subscription set with the markets we now track."""
        add = token_ids - self.tokens
        remove = self.tokens - token_ids
        self.tokens = set(token_ids)
        if add:
            await self._pending_ops.put(("subscribe", sorted(add)))
        if remove:
            await self._pending_ops.put(("unsubscribe", sorted(remove)))
            self.books.drop(sorted(remove))

    # ----------------------------------------------------------------- loop
    async def run(self) -> None:
        import websockets

        attempt = 0
        while not self._stop.is_set():
            try:
                async with websockets.connect(
                    self.url, ping_interval=None, close_timeout=5,
                    max_queue=4096, open_timeout=15,
                ) as ws:
                    self._ws = ws
                    attempt = 0
                    self.health.status = FeedStatus.ONLINE
                    self.health.detail = "connected"
                    self.log.info("connected", extra={"tokens": len(self.tokens)})

                    if self.tokens:
                        await ws.send(json.dumps({
                            "type": "market",
                            "assets_ids": sorted(self.tokens),
                            "custom_feature_enabled": True,
                        }))

                    pinger = asyncio.create_task(self._ping_loop(ws))
                    ops = asyncio.create_task(self._ops_loop(ws))
                    try:
                        await self._read_loop(ws)
                    finally:
                        for task in (pinger, ops):
                            task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await task
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.health.errors += 1
                self.health.status = FeedStatus.OFFLINE
                self.health.detail = f"{type(exc).__name__}: {exc}"[:200]
                self.log.warning("ws connection failed", extra={"error": str(exc)[:200]})
            finally:
                self._ws = None

            if self._stop.is_set():
                break
            self.health.reconnects += 1
            delay = min(self.reconnect_base * (2 ** attempt), self.reconnect_max)
            delay *= 0.5 + random.random()
            attempt = min(attempt + 1, 10)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

        self.health.status = FeedStatus.OFFLINE

    async def _ping_loop(self, ws: Any) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(self.ping_interval)
            try:
                await ws.send("PING")
            except Exception:  # noqa: BLE001
                return

    async def _ops_loop(self, ws: Any) -> None:
        """Apply queued subscribe/unsubscribe operations without reconnecting."""
        while not self._stop.is_set():
            operation, tokens = await self._pending_ops.get()
            if not tokens:
                continue
            payload: dict[str, Any] = {
                "assets_ids": tokens,
                "operation": operation,
            }
            if operation == "subscribe":
                payload["custom_feature_enabled"] = True
            try:
                await ws.send(json.dumps(payload))
                self.log.info(
                    "subscription updated",
                    extra={"operation": operation, "count": len(tokens)},
                )
            except Exception:  # noqa: BLE001
                # Re-queue so the next connection picks it up.
                await self._pending_ops.put((operation, tokens))
                return

    async def _read_loop(self, ws: Any) -> None:
        async for raw in ws:
            if self._stop.is_set():
                return
            self._note_message()
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8", errors="ignore")
            if isinstance(raw, str):
                text = raw.strip()
                if text.upper() in ("PONG", "PING", ""):
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    continue
            else:
                continue

            payloads = message if isinstance(message, list) else [message]
            for payload in payloads:
                if isinstance(payload, dict):
                    self._handle(payload)

    # ------------------------------------------------------------ handlers
    def _handle(self, message: dict[str, Any]) -> None:
        event_type = message.get("event_type") or message.get("type")
        if not event_type:
            return
        try:
            handler = getattr(self, f"_on_{event_type}", None)
            if handler is not None:
                handler(message)
        except Exception as exc:  # noqa: BLE001 - one bad message is not fatal
            self._parse_errors += 1
            if self._parse_errors <= 5 or self._parse_errors % 200 == 0:
                self.log.warning(
                    "ws handler error",
                    extra={"event_type": event_type, "error": str(exc)[:200]},
                )
            return
        if self.on_event is not None:
            self.on_event(str(event_type), message)

    def _on_book(self, message: dict[str, Any]) -> None:
        snap = parse_book(message)
        if snap.token_id:
            self.books.apply_book_event(snap)

    def _on_price_change(self, message: dict[str, Any]) -> None:
        changes = message.get("price_changes")
        if not isinstance(changes, list):
            # Older single-change shape
            changes = [message]
        for change in changes:
            if not isinstance(change, dict):
                continue
            token_id = change.get("asset_id") or message.get("asset_id")
            price = as_float(change.get("price"))
            size = as_float(change.get("size"), 0.0)
            side = str(change.get("side") or "").upper()
            if not token_id or price is None or side not in ("BUY", "SELL"):
                continue
            self.books.apply_price_change(str(token_id), side, price, size or 0.0)

            book = self.books.get(str(token_id))
            if book is not None:
                book.best_bid_hint = as_float(change.get("best_bid"))
                book.best_ask_hint = as_float(change.get("best_ask"))

    def _on_last_trade_price(self, message: dict[str, Any]) -> None:
        token_id = message.get("asset_id")
        price = as_float(message.get("price"))
        if not token_id or price is None:
            return
        size = as_float(message.get("size"), 0.0) or 0.0
        raw_side = str(message.get("side") or "").upper()
        side = Side.BUY if raw_side == "BUY" else (Side.SELL if raw_side == "SELL" else None)
        ts_raw = as_float(message.get("timestamp"), 0.0) or 0.0
        ts = ts_raw / 1000.0 if ts_raw > 1e11 else (ts_raw or time.time())
        self.books.record_trade(str(token_id), price, size, side, ts)

    def _on_tick_size_change(self, message: dict[str, Any]) -> None:
        token_id = message.get("asset_id")
        new_tick = as_float(message.get("new_tick_size"))
        if not token_id or new_tick is None:
            return
        book = self.books.ensure(str(token_id))
        book.set_tick_size(new_tick)
        self.log.info(
            "tick size changed",
            extra={"token_id": str(token_id)[:16],
                   "old": message.get("old_tick_size"), "new": new_tick},
        )

    def _on_best_bid_ask(self, message: dict[str, Any]) -> None:
        token_id = message.get("asset_id")
        if not token_id:
            return
        book = self.books.ensure(str(token_id))
        book.best_bid_hint = as_float(message.get("best_bid"))
        book.best_ask_hint = as_float(message.get("best_ask"))

    def _on_market_resolved(self, message: dict[str, Any]) -> None:
        condition_id = str(message.get("market") or message.get("condition_id") or "")
        winner = message.get("winning_asset_id") or message.get("winning_outcome")
        if condition_id and winner:
            self.resolved[condition_id] = str(winner)
            self.log.info(
                "market resolved",
                extra={"condition_id": condition_id[:20], "winner": str(winner)[:24]},
            )

    def _on_new_market(self, message: dict[str, Any]) -> None:
        self.log.info(
            "new market announced",
            extra={"question": str(message.get("question", ""))[:80]},
        )

    # --------------------------------------------------------------- health
    def _note_message(self) -> None:
        now = time.time()
        self.health.messages += 1
        self.health.last_message_at = now
        self._msg_times.append(now)
        if len(self._msg_times) > 200:
            del self._msg_times[:-200]
        if len(self._msg_times) >= 2:
            span = self._msg_times[-1] - self._msg_times[0]
            if span > 0:
                self.health.messages_per_sec = (len(self._msg_times) - 1) / span

    def update_health(self, now: float | None = None) -> FeedHealth:
        now = time.time() if now is None else now
        age = now - self.health.last_message_at if self.health.last_message_at else 1e9
        if self.health.status is not FeedStatus.OFFLINE:
            if age > self.stale_after * 4:
                self.health.status = FeedStatus.OFFLINE
                self.health.detail = f"stale {age:.1f}s"
            elif age > self.stale_after:
                self.health.status = FeedStatus.DEGRADED
                self.health.detail = f"stale {age:.1f}s"
            elif self.health.detail.startswith("stale"):
                self.health.detail = "connected"
        freshness = max(0.0, 1.0 - age / max(self.stale_after * 4, 1e-9))
        self.health.score = 0.0 if self.health.status is FeedStatus.OFFLINE else round(freshness, 4)
        return self.health
