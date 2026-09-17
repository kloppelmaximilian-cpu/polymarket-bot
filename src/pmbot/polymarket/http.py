"""Shared async HTTP plumbing for the Polymarket APIs.

Rate limiting, bounded retries with jittered backoff, and a clear distinction
between *retryable* (5xx, 429, timeouts) and *terminal* (4xx) failures.  All
errors are surfaced as :class:`ApiError` so callers never have to know which
HTTP library is underneath.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any

import httpx

from ..logging_setup import get_logger

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body[:500]

    @property
    def is_retryable(self) -> bool:
        return self.status is None or self.status in RETRYABLE_STATUS


class HostUnreachable(ApiError):
    """The circuit breaker is open: this host is not answering at all.

    Raised immediately, without a network attempt. When a host is unreachable
    -- blocked egress, DNS failure, an outage -- retrying each of a dozen
    endpoints with exponential backoff turns a two-second diagnosis into a
    four-minute hang, and hammers a service that may simply be down.
    """

    @property
    def is_retryable(self) -> bool:
        return False


class RateLimiter:
    """Simple token bucket; keeps us well inside published request budgets."""

    def __init__(self, rate_per_sec: float, burst: int | None = None):
        self.rate = max(rate_per_sec, 0.1)
        self.capacity = float(burst if burst is not None else max(rate_per_sec, 1.0))
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, tokens: float = 1.0) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(
                    self.capacity, self._tokens + (now - self._last) * self.rate
                )
                self._last = now
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return
                await asyncio.sleep((tokens - self._tokens) / self.rate)


class HttpClient:
    """Thin async JSON client with retries and rate limiting."""

    def __init__(
        self,
        base_url: str,
        timeout: float = 10.0,
        rate_per_sec: float = 8.0,
        max_retries: int = 3,
        name: str = "http",
        breaker_threshold: int = 3,
        breaker_cooldown: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.limiter = RateLimiter(rate_per_sec)
        self.log = get_logger(f"pmbot.http.{name}")
        self.name = name
        self._client: httpx.AsyncClient | None = None
        self.requests = 0
        self.errors = 0
        #: consecutive transport failures before the breaker opens
        self.breaker_threshold = breaker_threshold
        self.breaker_cooldown = breaker_cooldown
        self._transport_failures = 0
        self._breaker_open_until = 0.0

    @property
    def is_reachable(self) -> bool:
        return time.monotonic() >= self._breaker_open_until

    def _note_transport_failure(self, detail: str) -> None:
        self._transport_failures += 1
        if self._transport_failures >= self.breaker_threshold:
            self._breaker_open_until = time.monotonic() + self.breaker_cooldown
            self.log.warning(
                "host unreachable, pausing requests",
                extra={
                    "host": self.base_url, "failures": self._transport_failures,
                    "cooldown": self.breaker_cooldown, "detail": detail[:160],
                },
            )

    def _note_success(self) -> None:
        self._transport_failures = 0
        self._breaker_open_until = 0.0

    async def __aenter__(self) -> HttpClient:
        await self.start()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout),
                headers={"Accept": "application/json", "User-Agent": "pmbot/1.0"},
                follow_redirects=True,
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        headers: dict[str, str] | None = None,
        content: str | None = None,
    ) -> Any:
        if not self.is_reachable:
            raise HostUnreachable(
                f"{self.base_url} is unreachable "
                f"({self._transport_failures} consecutive transport failures); "
                f"not retrying for {self.breaker_cooldown:.0f}s",
                None,
            )

        await self.start()
        assert self._client is not None
        url = path if path.startswith("http") else f"{self.base_url}{path}"

        last: ApiError | None = None
        for attempt in range(self.max_retries + 1):
            await self.limiter.acquire()
            self.requests += 1
            try:
                response = await self._client.request(
                    method, url, params=params, json=json_body,
                    headers=headers, content=content,
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = ApiError(f"{type(exc).__name__}: {exc}", None)
                self._note_transport_failure(str(exc))
                if not self.is_reachable:
                    self.errors += 1
                    raise HostUnreachable(
                        f"{self.base_url} is unreachable: {last}", None
                    ) from exc
            else:
                self._note_success()
                if response.status_code == 200:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise ApiError(
                            f"non-JSON response: {exc}", response.status_code,
                            response.text,
                        ) from exc
                last = ApiError(
                    f"HTTP {response.status_code} for {method} {url}",
                    response.status_code,
                    response.text,
                )

            self.errors += 1
            if not last.is_retryable or attempt >= self.max_retries:
                break
            delay = min(2.0 ** attempt, 8.0) * (0.5 + random.random())
            self.log.warning(
                "request failed, retrying",
                extra={"url": url, "attempt": attempt, "error": str(last)[:200],
                       "delay": round(delay, 2)},
            )
            await asyncio.sleep(delay)

        assert last is not None
        raise last

    async def get(self, path: str, params: dict[str, Any] | None = None, **kw) -> Any:
        return await self.request("GET", path, params=params, **kw)

    async def post(self, path: str, json_body: Any = None, **kw) -> Any:
        return await self.request("POST", path, json_body=json_body, **kw)
