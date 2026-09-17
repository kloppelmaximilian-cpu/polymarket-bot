"""Gamma API client (market metadata and discovery).

Gamma is the read-only, cacheable metadata surface:
``https://gamma-api.polymarket.com``.  The 5-minute crypto markets are *not*
reliably returned by ``/markets?active=true`` (they carry a hide-from-new tag),
so discovery goes through ``/events`` filtered by the recurring **series**.
"""

from __future__ import annotations

from typing import Any

from ..logging_setup import get_logger
from .http import ApiError, HttpClient


class GammaClient:
    def __init__(self, base_url: str = "https://gamma-api.polymarket.com",
                 timeout: float = 10.0, rate_per_sec: float = 6.0):
        self.http = HttpClient(base_url, timeout=timeout,
                               rate_per_sec=rate_per_sec, name="gamma")
        self.log = get_logger("pmbot.gamma")

    async def close(self) -> None:
        await self.http.close()

    @staticmethod
    def _as_list(payload: Any) -> list[dict[str, Any]]:
        """Gamma returns either a bare list or ``{data: [...]}``."""
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict):
            for key in ("data", "events", "markets", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [row for row in value if isinstance(row, dict)]
        return []

    async def events(self, **params: Any) -> list[dict[str, Any]]:
        return self._as_list(await self.http.get("/events", params=params))

    async def markets(self, **params: Any) -> list[dict[str, Any]]:
        return self._as_list(await self.http.get("/markets", params=params))

    async def series(self, **params: Any) -> list[dict[str, Any]]:
        return self._as_list(await self.http.get("/series", params=params))

    async def events_by_series_slug(
        self, series_slug: str, limit: int = 500, closed: bool = False
    ) -> list[dict[str, Any]]:
        """Every (pre-listed and live) event in a recurring series."""
        return await self.events(
            series_slug=series_slug,
            closed=str(closed).lower(),
            limit=limit,
            order="endDate",
            ascending="true",
        )

    async def events_by_series_id(
        self, series_id: str | int, limit: int = 500, closed: bool = False
    ) -> list[dict[str, Any]]:
        return await self.events(
            series_id=series_id,
            closed=str(closed).lower(),
            limit=limit,
            order="endDate",
            ascending="true",
        )

    async def active_events(
        self, limit: int = 500, offset: int = 0, order: str = "endDate"
    ) -> list[dict[str, Any]]:
        return await self.events(
            active="true", closed="false", archived="false",
            limit=limit, offset=offset, order=order, ascending="true",
        )

    async def event_by_slug(self, slug: str) -> dict[str, Any] | None:
        rows = await self.events(slug=slug)
        return rows[0] if rows else None

    async def market_by_condition_id(self, condition_id: str) -> dict[str, Any] | None:
        try:
            rows = await self.markets(condition_ids=condition_id)
        except ApiError:
            return None
        return rows[0] if rows else None

    async def probe_series(self, slug: str) -> dict[str, Any] | None:
        """Does a series with this slug exist?  ``None`` when it does not."""
        try:
            rows = await self.series(slug=slug)
        except ApiError as exc:
            if exc.status == 404:
                return None
            raise
        return rows[0] if rows else None
