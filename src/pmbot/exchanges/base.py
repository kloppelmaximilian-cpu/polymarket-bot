"""Reference-exchange WebSocket feed framework.

One class per exchange, each supplying only the three things that actually
differ: the URL, the subscription payload and the message parser.  Everything
operationally hard -- reconnect with backoff, heartbeats, stale detection,
duplicate suppression, timestamp sanity, health scoring -- lives here so it is
implemented (and tested) exactly once.

The feeds never raise into the event loop: a parser bug on one exchange must
not be able to take the bot down, so parse errors are counted, logged and
swallowed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import time
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import Awaitable, Callable, Iterable, Sequence
from typing import Any

from ..core.clock import Clock, default_clock
from ..core.types import FeedHealth, FeedStatus, Tick
from ..logging_setup import get_logger

TickHandler = Callable[[Tick], Awaitable[None] | None]

# Anything outside this band relative to local time is treated as a bad
# timestamp: either our clock or theirs is wrong, and we must not feed it into
# the volatility estimator.
MAX_TIMESTAMP_FUTURE_SKEW = 5.0
MAX_TIMESTAMP_PAST_SKEW = 60.0


class ExchangeFeed(ABC):
    """Base class for a resilient market-data WebSocket feed."""

    name: str = "abstract"
    #: canonical asset -> exchange-specific symbol
    symbol_map: dict[str, str] = {}
    heartbeat_interval: float = 20.0
    #: some venues require a text ping rather than a protocol-level one
    text_ping: str | None = None
    json_ping: dict[str, Any] | None = None

    def __init__(
        self,
        assets: Sequence[str],
        on_tick: TickHandler | None = None,
        clock: Clock | None = None,
        stale_after: float = 3.0,
        reconnect_base: float = 1.0,
        reconnect_max: float = 30.0,
    ):
        self.assets = [a.upper() for a in assets if a.upper() in self.symbol_map]
        self.on_tick = on_tick
        self.clock = clock or default_clock()
        self.stale_after = stale_after
        self.reconnect_base = reconnect_base
        self.reconnect_max = reconnect_max

        self.health = FeedHealth(name=self.name)
        self.log = get_logger(f"pmbot.exchange.{self.name}")

        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._seen: deque[int] = deque(maxlen=4096)
        self._seen_set: set[int] = set()
        self._msg_times: deque[float] = deque(maxlen=200)
        self._parse_errors = 0
        self._last_prices: dict[str, float] = {}

    # ------------------------------------------------------- subclass hooks
    @property
    @abstractmethod
    def url(self) -> str: ...

    @abstractmethod
    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        """Payloads sent immediately after the socket opens."""

    @abstractmethod
    def parse(self, message: Any) -> list[Tick]:
        """Turn one raw WS message into zero or more normalised ticks."""

    def asset_for_symbol(self, symbol: str) -> str | None:
        want = symbol.upper().replace("-", "").replace("/", "").replace("_", "")
        for asset, sym in self.symbol_map.items():
            if asset not in self.assets:
                continue
            if sym.upper().replace("-", "").replace("/", "").replace("_", "") == want:
                return asset
        return None

    # -------------------------------------------------------------- control
    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self.run(), name=f"feed-{self.name}")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.health.status = FeedStatus.OFFLINE
        self.health.detail = "stopped"

    async def run(self) -> None:
        """Connect/subscribe/read loop with exponential backoff and jitter."""
        import websockets

        attempt = 0
        while not self._stop.is_set():
            try:
                self.log.info("connecting", extra={"url": self.url})
                async with websockets.connect(
                    self.url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                    max_queue=2048,
                    open_timeout=15,
                ) as ws:
                    attempt = 0
                    self.health.status = FeedStatus.ONLINE
                    self.health.detail = "connected"
                    for payload in self.subscribe_messages():
                        await ws.send(
                            payload if isinstance(payload, str) else json.dumps(payload)
                        )
                    hb = asyncio.create_task(self._heartbeat(ws))
                    try:
                        await self._read_loop(ws)
                    finally:
                        hb.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await hb
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - never kill the loop
                self.health.errors += 1
                self.health.status = FeedStatus.OFFLINE
                self.health.detail = f"{type(exc).__name__}: {exc}"[:200]
                self.log.warning(
                    "connection failed", extra={"error": str(exc)[:200], "attempt": attempt}
                )

            if self._stop.is_set():
                break
            self.health.reconnects += 1
            delay = min(self.reconnect_base * (2 ** attempt), self.reconnect_max)
            delay *= 0.5 + random.random()          # jitter: avoid lockstep storms
            attempt = min(attempt + 1, 10)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

        self.health.status = FeedStatus.OFFLINE

    async def _read_loop(self, ws: Any) -> None:
        async for raw in ws:
            if self._stop.is_set():
                return
            self._note_message()
            if isinstance(raw, (bytes, bytearray)):
                try:
                    raw = raw.decode("utf-8")
                except UnicodeDecodeError:
                    continue
            if self._is_pong(raw):
                continue
            try:
                message = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                continue
            try:
                ticks = self.parse(message)
            except Exception as exc:  # noqa: BLE001
                self._parse_errors += 1
                if self._parse_errors <= 5 or self._parse_errors % 500 == 0:
                    self.log.warning(
                        "parse error",
                        extra={"error": str(exc)[:200], "count": self._parse_errors},
                    )
                continue
            for tick in ticks:
                await self._emit(tick)

    def _is_pong(self, raw: Any) -> bool:
        return isinstance(raw, str) and raw.strip().lower() in {"pong", "ping"}

    async def _heartbeat(self, ws: Any) -> None:
        if self.text_ping is None and self.json_ping is None:
            return
        while not self._stop.is_set():
            await asyncio.sleep(self.heartbeat_interval)
            try:
                payload = self.text_ping or json.dumps(self.json_ping)
                await ws.send(payload)
            except Exception:  # noqa: BLE001 - read loop will notice the drop
                return

    # ---------------------------------------------------------- tick intake
    async def _emit(self, tick: Tick) -> None:
        if not self._validate(tick):
            return
        key = hash((tick.exchange, tick.symbol, round(tick.timestamp, 3),
                    tick.price, tick.size, tick.is_trade))
        if key in self._seen_set:
            return
        if len(self._seen) == self._seen.maxlen:
            self._seen_set.discard(self._seen[0])
        self._seen.append(key)
        self._seen_set.add(key)

        self._last_prices[tick.asset] = tick.price
        self.health.latency_ms = tick.latency * 1000.0
        self.health.clock_drift_ms = (tick.received_at - tick.timestamp) * 1000.0

        if self.on_tick is None:
            return
        result = self.on_tick(tick)
        if asyncio.iscoroutine(result):
            await result

    def _validate(self, tick: Tick) -> bool:
        if tick.price <= 0 or tick.price != tick.price:      # NaN guard
            return False
        now = tick.received_at
        if tick.timestamp > now + MAX_TIMESTAMP_FUTURE_SKEW:
            return False
        if tick.timestamp < now - MAX_TIMESTAMP_PAST_SKEW:
            return False
        # Reject absurd single-tick jumps (>10%): almost always a bad parse or a
        # wrong-symbol message, never a real 5-minute-horizon move.
        prev = self._last_prices.get(tick.asset)
        if prev is not None and prev > 0 and abs(tick.price / prev - 1.0) > 0.10:
            self.log.warning(
                "outlier tick rejected",
                extra={"asset": tick.asset, "price": tick.price, "prev": prev},
            )
            return False
        return True

    def _note_message(self) -> None:
        now = self.clock.time()
        self.health.messages += 1
        self.health.last_message_at = now
        self._msg_times.append(now)
        if len(self._msg_times) >= 2:
            span = self._msg_times[-1] - self._msg_times[0]
            if span > 0:
                self.health.messages_per_sec = (len(self._msg_times) - 1) / span

    # --------------------------------------------------------------- health
    def update_health(self, now: float | None = None) -> FeedHealth:
        now = self.clock.time() if now is None else now
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

        # Score in [0,1]: freshness dominates, latency and errors shave it down.
        freshness = max(0.0, 1.0 - age / max(self.stale_after * 4, 1e-9))
        latency_pen = min(self.health.latency_ms / 2000.0, 1.0)
        error_pen = min(self.health.errors / 20.0, 1.0)
        score = max(0.0, freshness * (1.0 - 0.3 * latency_pen) * (1.0 - 0.3 * error_pen))
        if self.health.status is FeedStatus.OFFLINE:
            score = 0.0
        self.health.score = round(score, 4)
        return self.health

    @property
    def is_healthy(self) -> bool:
        return self.update_health().status is FeedStatus.ONLINE

    def last_price(self, asset: str) -> float | None:
        return self._last_prices.get(asset.upper())


def make_tick(
    exchange: str,
    asset: str,
    symbol: str,
    price: float,
    size: float = 0.0,
    exchange_ts: float | None = None,
    bid: float | None = None,
    ask: float | None = None,
    is_trade: bool = True,
) -> Tick:
    now = time.time()
    return Tick(
        exchange=exchange,
        symbol=symbol,
        asset=asset,
        price=float(price),
        size=float(size or 0.0),
        timestamp=float(exchange_ts) if exchange_ts else now,
        received_at=now,
        bid=bid,
        ask=ask,
        is_trade=is_trade,
    )
