"""Live execution against the Polymarket CLOB.

This module is the only place in the system that can move real money, so the
safety gates are layered and each one fails closed:

1. The venue refuses to construct unless ``TRADING_MODE=live`` **and**
   ``LIVE_CONFIRMATION=true``.
2. It refuses to construct without a signing key and L2 API credentials.
3. ``DRY_RUN_LIVE=true`` builds and signs orders, runs every validation, logs
   what *would* have been sent, and returns without POSTing.
4. Order signing is delegated to the official ``py-clob-client``.  Rolling our
   own EIP-712 order signature would risk producing orders that are valid but
   wrong.
5. A heartbeat task runs while any order is resting -- the venue cancels all of
   a participant's open orders if a heartbeat is missed for ~10 seconds.

Nothing here logs a key, a secret or a signature.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any

from ..config import Settings, TradingMode
from ..core.clock import Clock, default_clock
from ..core.types import (
    Fill,
    OrderKind,
    OrderRequest,
    OrderResult,
    OrderState,
    Side,
)
from ..polymarket.clob_rest import ClobRestClient
from ..polymarket.fees import FeeSchedule
from ..polymarket.http import ApiError
from .base import ExecutionVenue


class LiveTradingNotArmed(RuntimeError):
    """Raised when live execution is requested without full authorisation."""


@dataclass
class _Tracked:
    request: OrderRequest
    result: OrderResult


class LiveVenue(ExecutionVenue):
    name = "live"
    is_live = True

    def __init__(
        self,
        settings: Settings,
        rest: ClobRestClient,
        clock: Clock | None = None,
        heartbeat_interval: float = 5.0,
    ):
        self._assert_armed(settings)
        super().__init__()
        self.settings = settings
        self.rest = rest
        self.clock = clock or default_clock()
        self.heartbeat_interval = heartbeat_interval
        self.dry_run = settings.dry_run_live

        self._signer = _OrderSigner(settings)
        self._tracked: dict[str, _Tracked] = {}
        self._heartbeat_id = ""
        self._heartbeat_task: asyncio.Task | None = None
        self._stop = asyncio.Event()

        self.log.warning(
            "LIVE execution venue constructed",
            extra={"dry_run": self.dry_run, "funder": _mask(settings.polymarket_funder)},
        )

    # ------------------------------------------------------------- arming
    @staticmethod
    def _assert_armed(settings: Settings) -> None:
        if settings.trading_mode is not TradingMode.LIVE:
            raise LiveTradingNotArmed(
                "TRADING_MODE is not 'live'; refusing to build a live venue"
            )
        if not settings.live_confirmation:
            raise LiveTradingNotArmed(
                "LIVE_CONFIRMATION is not true; refusing to build a live venue"
            )
        if settings.polymarket_private_key is None:
            raise LiveTradingNotArmed("no POLYMARKET_PRIVATE_KEY configured")
        if not all((
            settings.polymarket_api_key,
            settings.polymarket_api_secret,
            settings.polymarket_api_passphrase,
        )):
            raise LiveTradingNotArmed(
                "L2 API credentials (key/secret/passphrase) are required for live trading"
            )

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        self._stop.clear()
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(), name="clob-heartbeat"
            )

    async def stop(self) -> None:
        self._stop.set()
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
            self._heartbeat_task = None
        # Never leave orders resting after shutdown.
        with contextlib.suppress(Exception):
            await self.cancel_all()

    async def _heartbeat_loop(self) -> None:
        """Keep resting orders alive; a missed heartbeat cancels everything."""
        while not self._stop.is_set():
            await asyncio.sleep(self.heartbeat_interval)
            if not self._tracked:
                continue
            try:
                self._heartbeat_id = await self.rest.post_heartbeat(self._heartbeat_id)
            except ApiError as exc:
                self.stats.errors += 1
                self.log.warning("heartbeat failed", extra={"error": str(exc)[:200]})

    # ---------------------------------------------------------------- submit
    async def submit(self, request: OrderRequest) -> OrderResult:
        now = self.clock.time()
        self.stats.submitted += 1

        duplicate = self.guard.check(request, now)
        if duplicate is not None:
            self.stats.duplicates_blocked += 1
            self.log.error(
                "duplicate live order blocked",
                extra={"reason": duplicate, "token_id": request.token_id[:16]},
            )
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=f"duplicate: {duplicate}", submitted_at=now, finalised_at=now,
            )

        try:
            tick = await self.rest.get_tick_size(request.token_id)
        except ApiError as exc:
            self.stats.errors += 1
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=f"tick size lookup failed: {exc}", submitted_at=now,
                finalised_at=now,
            )

        invalid = self._validate(request, tick, min_size=0.0)
        if invalid is not None:
            self.stats.rejected += 1
            return OrderResult(
                request=request, state=OrderState.REJECTED, error=invalid,
                submitted_at=now, finalised_at=now,
            )

        try:
            neg_risk = await self.rest.get_neg_risk(request.token_id)
        except ApiError:
            neg_risk = False

        try:
            payload = self._signer.build(request, tick, neg_risk)
        except Exception as exc:  # noqa: BLE001
            self.stats.errors += 1
            self.log.error("order signing failed", extra={"error": str(exc)[:200]})
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=f"signing failed: {type(exc).__name__}", submitted_at=now,
                finalised_at=now,
            )

        self.guard.register(request, now)

        if self.dry_run:
            self.log.warning(
                "DRY RUN: order built but not sent",
                extra={
                    "token_id": request.token_id[:16], "side": request.side.value,
                    "price": request.price, "size": request.size,
                    "kind": request.kind.value, "post_only": request.post_only,
                    "neg_risk": neg_risk, "tick": tick,
                },
            )
            return OrderResult(
                request=request, state=OrderState.CANCELLED,
                error="dry run: not submitted", submitted_at=now, finalised_at=now,
            )

        try:
            response = await self.rest.post_order(payload)
        except ApiError as exc:
            self.stats.errors += 1
            self.log.error(
                "order submission failed",
                extra={"status": exc.status, "error": str(exc)[:200]},
            )
            return OrderResult(
                request=request, state=OrderState.REJECTED,
                error=f"submit failed: {exc}", submitted_at=now, finalised_at=now,
            )

        return self._interpret(request, response, now)

    def _interpret(self, request: OrderRequest, response: dict[str, Any], now: float) -> OrderResult:
        """Map a CLOB response onto our order state machine."""
        success = response.get("success")
        order_id = response.get("orderID") or response.get("orderId") or response.get("id")
        status = str(response.get("status") or "").lower()
        error = response.get("errorMsg") or response.get("error")

        result = OrderResult(
            request=request, state=OrderState.PENDING,
            order_id=str(order_id) if order_id else None, submitted_at=now,
        )

        if success is False or (error and not order_id):
            self.stats.rejected += 1
            result.state = OrderState.REJECTED
            result.error = str(error or "rejected")
            result.finalised_at = now
            return result

        making = response.get("makingAmount")
        taking = response.get("takingAmount")
        if status == "matched":
            filled, avg = self._fill_from_amounts(request, making, taking)
            result.filled_size = filled
            result.avg_price = avg
            fee = FeeSchedule().total(avg, filled) if filled else 0.0
            result.fees = fee
            if filled > 0:
                result.fills.append(Fill(
                    order_id=result.order_id or "", client_id=request.client_id,
                    token_id=request.token_id, side=request.side, price=avg,
                    size=filled, fee=fee, timestamp=now, is_maker=False,
                ))
                self.record_fill(result.fills[-1])
            result.state = (
                OrderState.FILLED if filled >= request.size - 1e-9 else OrderState.PARTIAL
            )
            if result.state is OrderState.FILLED:
                self.stats.filled += 1
                result.finalised_at = now
            else:
                self.stats.partially_filled += 1
                self._tracked[result.order_id or request.client_id] = _Tracked(request, result)
        elif status in ("live", "delayed", "unmatched"):
            result.state = OrderState.OPEN
            self._tracked[result.order_id or request.client_id] = _Tracked(request, result)
        else:
            result.state = OrderState.OPEN
            self._tracked[result.order_id or request.client_id] = _Tracked(request, result)

        self.log.info(
            "order submitted",
            extra={
                "order_id": str(order_id)[:24] if order_id else None,
                "status": status, "state": result.state.value,
                "filled": result.filled_size, "token_id": request.token_id[:16],
            },
        )
        return result

    @staticmethod
    def _fill_from_amounts(request, making, taking) -> tuple[float, float]:
        """Derive filled size and average price from the CLOB's amounts."""
        try:
            making_f = float(making) if making is not None else 0.0
            taking_f = float(taking) if taking is not None else 0.0
        except (TypeError, ValueError):
            return 0.0, request.price
        if request.side is Side.BUY:
            shares = taking_f
            cost = making_f
        else:
            shares = making_f
            cost = taking_f
        if shares <= 0:
            return 0.0, request.price
        return shares, (cost / shares if shares > 0 else request.price)

    # ---------------------------------------------------------------- cancel
    async def cancel(self, order_id: str) -> bool:
        try:
            await self.rest.cancel_order(order_id)
        except ApiError as exc:
            self.stats.errors += 1
            self.log.warning(
                "cancel failed", extra={"order_id": order_id[:24], "error": str(exc)[:200]}
            )
            return False
        tracked = self._tracked.pop(order_id, None)
        if tracked is not None:
            tracked.result.state = (
                OrderState.PARTIAL if tracked.result.filled_size > 0 else OrderState.CANCELLED
            )
            tracked.result.finalised_at = self.clock.time()
            self.guard.release(tracked.request)
        self.stats.cancelled += 1
        return True

    async def cancel_all(self) -> int:
        count = len(self._tracked)
        try:
            await self.rest.cancel_all()
        except ApiError as exc:
            self.log.warning("cancel-all failed", extra={"error": str(exc)[:200]})
            return 0
        for tracked in self._tracked.values():
            if tracked.result.filled_size <= 0:
                tracked.result.state = OrderState.CANCELLED
            self.guard.release(tracked.request)
        self._tracked.clear()
        self.stats.cancelled += count
        return count

    # ------------------------------------------------------------------ poll
    async def poll(self, now: float | None = None) -> list[OrderResult]:
        """Reconcile our view of resting orders against the venue's."""
        now = self.clock.time() if now is None else now
        if not self._tracked:
            return []
        try:
            open_orders = await self.rest.get_open_orders()
        except ApiError as exc:
            self.stats.errors += 1
            self.log.warning("order reconciliation failed", extra={"error": str(exc)[:200]})
            return []

        by_id = {str(row.get("id") or row.get("orderID") or ""): row for row in open_orders}
        changed: list[OrderResult] = []

        for order_id in list(self._tracked):
            tracked = self._tracked[order_id]
            row = by_id.get(order_id)
            if row is None:
                # Gone from the venue: either fully filled or cancelled.
                tracked.result.state = (
                    OrderState.FILLED if tracked.result.filled_size > 0
                    else OrderState.CANCELLED
                )
                tracked.result.finalised_at = now
                self.guard.release(tracked.request)
                del self._tracked[order_id]
                changed.append(tracked.result)
                continue

            try:
                matched = float(row.get("size_matched") or row.get("sizeMatched") or 0.0)
            except (TypeError, ValueError):
                matched = tracked.result.filled_size
            if matched > tracked.result.filled_size + 1e-9:
                delta = matched - tracked.result.filled_size
                price = tracked.request.price
                fee = FeeSchedule().total(price, delta, is_maker=True)
                fill = Fill(
                    order_id=order_id, client_id=tracked.request.client_id,
                    token_id=tracked.request.token_id, side=tracked.request.side,
                    price=price, size=delta, fee=fee, timestamp=now, is_maker=True,
                )
                tracked.result.fills.append(fill)
                tracked.result.filled_size = matched
                total = sum(f.size for f in tracked.result.fills)
                tracked.result.avg_price = (
                    sum(f.size * f.price for f in tracked.result.fills) / total
                    if total > 0 else price
                )
                tracked.result.fees = sum(f.fee for f in tracked.result.fills)
                tracked.result.state = OrderState.PARTIAL
                self.record_fill(fill)
                changed.append(tracked.result)
        return changed

    def open_orders(self) -> list[OrderResult]:
        return [t.result for t in self._tracked.values()]


class _OrderSigner:
    """Wraps the official client purely for EIP-712 order construction."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Any = None

    def _ensure(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from py_clob_client.client import ClobClient
            from py_clob_client.clob_types import ApiCreds as ClobCreds
        except ImportError as exc:  # pragma: no cover - dependency is declared
            raise RuntimeError(
                "py-clob-client is required for live trading: pip install py-clob-client"
            ) from exc

        settings = self.settings
        creds = ClobCreds(
            api_key=settings.polymarket_api_key.get_secret_value(),
            api_secret=settings.polymarket_api_secret.get_secret_value(),
            api_passphrase=settings.polymarket_api_passphrase.get_secret_value(),
        )
        self._client = ClobClient(
            settings.clob_base_url,
            chain_id=settings.polygon_chain_id,
            key=settings.polymarket_private_key.get_secret_value(),
            creds=creds,
            signature_type=settings.polymarket_signature_type,
            funder=settings.polymarket_funder,
        )
        return self._client

    def address(self) -> str:
        return str(self._ensure().get_address())

    def build(self, request: OrderRequest, tick_size: float, neg_risk: bool) -> dict[str, Any]:
        """Sign an order and render the exact JSON body the CLOB expects."""
        from py_clob_client.clob_types import (
            CreateOrderOptions,
            MarketOrderArgs,
            OrderArgs,
            OrderType,
        )
        from py_clob_client.order_builder.constants import BUY, SELL
        from py_clob_client.utilities import order_to_json

        client = self._ensure()
        side = BUY if request.side is Side.BUY else SELL
        options = CreateOrderOptions(tick_size=_tick_literal(tick_size), neg_risk=neg_risk)

        if request.kind in (OrderKind.FOK, OrderKind.FAK):
            # For market-style orders a BUY amount is dollars, a SELL is shares.
            amount = request.size * request.price if request.side is Side.BUY else request.size
            signed = client.builder.create_market_order(
                MarketOrderArgs(
                    token_id=request.token_id, amount=amount, side=side,
                    price=request.price,
                    order_type=OrderType.FOK if request.kind is OrderKind.FOK else OrderType.FAK,
                ),
                options,
            )
            order_type = OrderType.FOK if request.kind is OrderKind.FOK else OrderType.FAK
        else:
            args = OrderArgs(
                token_id=request.token_id, price=request.price, size=request.size,
                side=side, expiration=request.expiration or 0,
            )
            signed = client.builder.create_order(args, options)
            order_type = (
                OrderType.GTD if request.kind is OrderKind.GTD else OrderType.GTC
            )

        return order_to_json(
            signed,
            self.settings.polymarket_api_key.get_secret_value(),
            order_type,
            request.post_only,
        )


def _tick_literal(tick: float) -> str:
    """Map a numeric tick onto the four literals the venue accepts."""
    for candidate in ("0.0001", "0.001", "0.01", "0.1"):
        if abs(tick - float(candidate)) < 1e-9:
            return candidate
    # Default to the coarsest safe value rather than guessing finer than allowed.
    return "0.01"


def _mask(value: str | None) -> str:
    if not value:
        return "unset"
    return f"{value[:6]}...{value[-4:]}" if len(value) > 12 else "set"
