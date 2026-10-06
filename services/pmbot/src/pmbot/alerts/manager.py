"""Alerting.

Alerts are deduplicated and rate-limited: a stale feed produces one alert, not
one per cycle.  Telegram is strictly optional and entirely fire-and-forget --
a delivery failure is logged and never propagates into the trading loop, and
the bot's behaviour does not depend on any message being delivered.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass

from ..core.types import Alert
from ..logging_setup import get_logger

LEVELS = {"info": 0, "warning": 1, "critical": 2}


@dataclass
class _Throttle:
    last_sent: float = 0.0
    count: int = 0


class AlertManager:
    def __init__(
        self,
        telegram_enabled: bool = False,
        telegram_token: str | None = None,
        telegram_chat_id: str | None = None,
        cooldown_seconds: float = 120.0,
        min_telegram_level: str = "warning",
        max_history: int = 200,
    ):
        self.telegram_enabled = telegram_enabled and bool(telegram_token and telegram_chat_id)
        self.telegram_token = telegram_token
        self.telegram_chat_id = telegram_chat_id
        self.cooldown = cooldown_seconds
        self.min_telegram_level = min_telegram_level
        self.log = get_logger("pmbot.alerts")
        self.history: deque[Alert] = deque(maxlen=max_history)
        self._throttles: dict[str, _Throttle] = {}

    def _key(self, component: str, message: str) -> str:
        return f"{component}|{message[:60]}"

    async def send(
        self, level: str, component: str, message: str, detail: dict | None = None
    ) -> bool:
        """Record an alert; returns whether it was emitted (vs throttled)."""
        now = time.time()
        key = self._key(component, message)
        throttle = self._throttles.setdefault(key, _Throttle())
        throttle.count += 1
        if now - throttle.last_sent < self.cooldown:
            return False
        throttle.last_sent = now

        alert = Alert(
            timestamp=now, level=level, component=component,
            message=message, detail=detail or {},
        )
        self.history.append(alert)
        log_fn = {
            "critical": self.log.error, "warning": self.log.warning,
        }.get(level, self.log.info)
        log_fn(
            "alert",
            extra={"alert_level": level, "alert_component": component,
                   "alert_message": message[:300], "repeats": throttle.count},
        )

        if self.telegram_enabled and LEVELS.get(level, 0) >= LEVELS.get(
            self.min_telegram_level, 1
        ):
            asyncio.create_task(self._telegram(level, component, message))
        return True

    async def _telegram(self, level: str, component: str, message: str) -> None:
        try:
            import httpx

            icon = {"critical": "\U0001F6A8", "warning": "⚠️"}.get(level, "ℹ️")
            text = f"{icon} *{level.upper()}* `{component}`\n{message}"
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"https://api.telegram.org/bot{self.telegram_token}/sendMessage",
                    json={
                        "chat_id": self.telegram_chat_id,
                        "text": text,
                        "parse_mode": "Markdown",
                    },
                )
        except Exception as exc:  # noqa: BLE001 - alerting must never break trading
            self.log.warning("telegram delivery failed", extra={"error": str(exc)[:200]})

    async def maybe_warn_losses(self, consecutive: int, limit: int) -> None:
        if limit <= 0:
            return
        if consecutive >= max(limit - 2, 2):
            await self.send(
                "warning", "risk",
                f"{consecutive} consecutive losses (limit {limit})",
            )

    def recent(self, limit: int = 20) -> list[dict]:
        return [
            {
                "ts": a.timestamp, "level": a.level, "component": a.component,
                "message": a.message[:200],
            }
            for a in list(self.history)[-limit:][::-1]
        ]
