"""Polymarket CLOB REST client.

Read endpoints need no auth; order placement and cancellation need L2 HMAC
headers.  Order *signing* (EIP-712 over the exchange's order struct) is
delegated to the official ``py-clob-client`` when it is installed, because
hand-rolling that signature is exactly the kind of thing that silently produces
rejected -- or worse, wrong -- orders.
"""

from __future__ import annotations

import json
from typing import Any

from ..core.types import BookSnapshot
from ..logging_setup import get_logger
from .auth import ApiCreds, l2_headers
from .http import ApiError, HttpClient
from .parsers import as_float, parse_book

# Endpoint paths verified against the official client's endpoints module.
BOOK = "/book"
BOOKS = "/books"
MIDPOINT = "/midpoint"
MIDPOINTS = "/midpoints"
PRICE = "/price"
PRICES = "/prices"
SPREAD = "/spread"
TICK_SIZE = "/tick-size"
NEG_RISK = "/neg-risk"
FEE_RATE = "/fee-rate"
LAST_TRADE_PRICE = "/last-trade-price"
PRICES_HISTORY = "/prices-history"
MARKETS = "/markets"
ORDER = "/order"
ORDERS = "/orders"
CANCEL_ALL = "/cancel-all"
CANCEL_MARKET_ORDERS = "/cancel-market-orders"
DATA_ORDERS = "/data/orders"
DATA_TRADES = "/data/trades"
HEARTBEAT = "/v1/heartbeats"
SERVER_TIME = "/time"


class ClobRestClient:
    def __init__(
        self,
        base_url: str = "https://clob.polymarket.com",
        creds: ApiCreds | None = None,
        address: str | None = None,
        timeout: float = 10.0,
        rate_per_sec: float = 10.0,
    ):
        self.http = HttpClient(base_url, timeout=timeout,
                               rate_per_sec=rate_per_sec, name="clob")
        self.creds = creds
        self.address = address
        self.log = get_logger("pmbot.clob")
        self._tick_cache: dict[str, tuple[float, float]] = {}
        self._neg_risk_cache: dict[str, bool] = {}
        self._fee_cache: dict[str, float] = {}

    async def close(self) -> None:
        await self.http.close()

    @property
    def has_l2(self) -> bool:
        return self.creds is not None and self.address is not None

    # ------------------------------------------------------------ read-only
    async def server_time(self) -> float | None:
        try:
            value = await self.http.get(SERVER_TIME)
        except ApiError:
            return None
        return as_float(value)

    async def get_book(self, token_id: str) -> BookSnapshot | None:
        payload = await self.http.get(BOOK, params={"token_id": token_id})
        if not isinstance(payload, dict):
            return None
        return parse_book(payload, token_id)

    async def get_books(self, token_ids: list[str]) -> dict[str, BookSnapshot]:
        """Batch book fetch.  Falls back to sequential fetches if the batch
        endpoint is unavailable, because a partial view is better than none."""
        if not token_ids:
            return {}
        try:
            payload = await self.http.post(
                BOOKS, json_body=[{"token_id": t} for t in token_ids]
            )
        except ApiError as exc:
            self.log.warning("batch book failed, falling back",
                             extra={"error": str(exc)[:200], "n": len(token_ids)})
            out: dict[str, BookSnapshot] = {}
            for token_id in token_ids:
                try:
                    book = await self.get_book(token_id)
                except ApiError:
                    continue
                if book is not None:
                    out[token_id] = book
            return out

        books: dict[str, BookSnapshot] = {}
        rows = payload if isinstance(payload, list) else [payload]
        for row in rows:
            if not isinstance(row, dict):
                continue
            book = parse_book(row)
            if book.token_id:
                books[book.token_id] = book
        return books

    async def get_midpoint(self, token_id: str) -> float | None:
        payload = await self.http.get(MIDPOINT, params={"token_id": token_id})
        return as_float(payload.get("mid")) if isinstance(payload, dict) else None

    async def get_price(self, token_id: str, side: str) -> float | None:
        payload = await self.http.get(
            PRICE, params={"token_id": token_id, "side": side.upper()}
        )
        return as_float(payload.get("price")) if isinstance(payload, dict) else None

    async def get_spread(self, token_id: str) -> float | None:
        payload = await self.http.get(SPREAD, params={"token_id": token_id})
        return as_float(payload.get("spread")) if isinstance(payload, dict) else None

    async def get_tick_size(self, token_id: str, ttl: float = 300.0) -> float:
        import time as _time

        cached = self._tick_cache.get(token_id)
        if cached and _time.monotonic() - cached[1] < ttl:
            return cached[0]
        payload = await self.http.get(TICK_SIZE, params={"token_id": token_id})
        tick = as_float(
            payload.get("minimum_tick_size") if isinstance(payload, dict) else None,
            0.01,
        ) or 0.01
        self._tick_cache[token_id] = (tick, _time.monotonic())
        return tick

    def cache_tick_size(self, token_id: str, tick: float) -> None:
        """Seed the cache from a websocket ``tick_size_change`` event."""
        import time as _time

        self._tick_cache[token_id] = (tick, _time.monotonic())

    async def get_neg_risk(self, token_id: str) -> bool:
        if token_id in self._neg_risk_cache:
            return self._neg_risk_cache[token_id]
        payload = await self.http.get(NEG_RISK, params={"token_id": token_id})
        value = bool(payload.get("neg_risk")) if isinstance(payload, dict) else False
        self._neg_risk_cache[token_id] = value
        return value

    async def get_fee_rate_bps(self, token_id: str) -> float:
        if token_id in self._fee_cache:
            return self._fee_cache[token_id]
        try:
            payload = await self.http.get(FEE_RATE, params={"token_id": token_id})
        except ApiError:
            return 0.0
        value = as_float(payload.get("base_fee"), 0.0) if isinstance(payload, dict) else 0.0
        self._fee_cache[token_id] = value or 0.0
        return self._fee_cache[token_id]

    async def get_last_trade_price(self, token_id: str) -> float | None:
        payload = await self.http.get(LAST_TRADE_PRICE, params={"token_id": token_id})
        return as_float(payload.get("price")) if isinstance(payload, dict) else None

    async def get_price_history(
        self,
        token_id: str,
        start_ts: int | None = None,
        end_ts: int | None = None,
        interval: str | None = None,
        fidelity: int | None = None,
    ) -> list[tuple[float, float]]:
        """Historical mid prices as ``[(epoch_seconds, price)]``.

        ``interval`` and ``startTs``/``endTs`` are mutually exclusive.
        """
        params: dict[str, Any] = {"market": token_id}
        if interval:
            params["interval"] = interval
        else:
            if start_ts is not None:
                params["startTs"] = int(start_ts)
            if end_ts is not None:
                params["endTs"] = int(end_ts)
        if fidelity is not None:
            params["fidelity"] = int(fidelity)

        payload = await self.http.get(PRICES_HISTORY, params=params)
        rows = payload.get("history") if isinstance(payload, dict) else payload
        out: list[tuple[float, float]] = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                ts, price = as_float(row.get("t")), as_float(row.get("p"))
                if ts is None or price is None:
                    continue
                out.append((ts, price))
        out.sort(key=lambda r: r[0])
        return out

    async def get_market(self, condition_id: str) -> dict[str, Any] | None:
        payload = await self.http.get(f"{MARKETS}/{condition_id}")
        return payload if isinstance(payload, dict) else None

    # ------------------------------------------------------ authenticated
    def _auth_headers(self, method: str, path: str, body: str | None = None) -> dict[str, str]:
        if not self.has_l2:
            raise ApiError("L2 credentials required for this endpoint", 401)
        assert self.creds is not None and self.address is not None
        headers = l2_headers(self.address, self.creds, method, path, body)
        headers["Content-Type"] = "application/json"
        return headers

    async def post_order(self, order_payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(order_payload, separators=(",", ":"), ensure_ascii=False)
        headers = self._auth_headers("POST", ORDER, body)
        result = await self.http.request("POST", ORDER, headers=headers, content=body)
        return result if isinstance(result, dict) else {"raw": result}

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        body = json.dumps({"orderID": order_id}, separators=(",", ":"))
        headers = self._auth_headers("DELETE", ORDER, body)
        result = await self.http.request("DELETE", ORDER, headers=headers, content=body)
        return result if isinstance(result, dict) else {"raw": result}

    async def cancel_orders(self, order_ids: list[str]) -> dict[str, Any]:
        body = json.dumps(order_ids, separators=(",", ":"))
        headers = self._auth_headers("DELETE", ORDERS, body)
        result = await self.http.request("DELETE", ORDERS, headers=headers, content=body)
        return result if isinstance(result, dict) else {"raw": result}

    async def cancel_all(self) -> dict[str, Any]:
        headers = self._auth_headers("DELETE", CANCEL_ALL)
        result = await self.http.request("DELETE", CANCEL_ALL, headers=headers)
        return result if isinstance(result, dict) else {"raw": result}

    async def cancel_market_orders(
        self, condition_id: str = "", token_id: str = ""
    ) -> dict[str, Any]:
        payload = {"market": condition_id, "asset_id": token_id}
        body = json.dumps(payload, separators=(",", ":"))
        headers = self._auth_headers("DELETE", CANCEL_MARKET_ORDERS, body)
        result = await self.http.request(
            "DELETE", CANCEL_MARKET_ORDERS, headers=headers, content=body
        )
        return result if isinstance(result, dict) else {"raw": result}

    async def get_open_orders(self, condition_id: str | None = None) -> list[dict[str, Any]]:
        params = {"market": condition_id} if condition_id else None
        path = DATA_ORDERS
        headers = self._auth_headers("GET", path)
        payload = await self.http.get(path, params=params, headers=headers)
        if isinstance(payload, dict):
            payload = payload.get("data") or []
        return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []

    async def get_trades(self, condition_id: str | None = None) -> list[dict[str, Any]]:
        params = {"market": condition_id} if condition_id else None
        headers = self._auth_headers("GET", DATA_TRADES)
        payload = await self.http.get(DATA_TRADES, params=params, headers=headers)
        if isinstance(payload, dict):
            payload = payload.get("data") or []
        return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []

    async def post_heartbeat(self, heartbeat_id: str = "") -> str:
        """Keep-alive for resting orders.

        Miss it for ~10s and the venue cancels every open order, so the live
        execution path runs this on a 5s timer.
        """
        payload = {"heartbeat_id": heartbeat_id}
        body = json.dumps(payload, separators=(",", ":"))
        headers = self._auth_headers("POST", HEARTBEAT, body)
        try:
            result = await self.http.request("POST", HEARTBEAT, headers=headers, content=body)
        except ApiError as exc:
            # A 400 carries the correct id to use next time.
            if exc.status == 400 and exc.body:
                try:
                    return str(json.loads(exc.body).get("heartbeat_id", ""))
                except (ValueError, AttributeError):
                    pass
            raise
        return str(result.get("heartbeat_id", "")) if isinstance(result, dict) else ""
