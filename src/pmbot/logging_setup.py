"""Structured logging.

Every record carries ``timestamp``, ``component``, ``level``, ``event`` plus any
contextual keys (market, asset, trade_id...).  JSON by default so logs are
machine-readable for post-hoc debugging; a human-friendly console format is
available for interactive work.

Secrets never reach the log: :class:`SecretRedactingFilter` scrubs anything that
looks like a key before the record is emitted.
"""

from __future__ import annotations

import contextlib
import json
import logging
import logging.handlers
import re
import sys
import time
from pathlib import Path
from typing import Any

_SECRET_PATTERNS = [
    re.compile(r"0x[a-fA-F0-9]{64}"),                       # private keys
    re.compile(r"(?i)(api[_-]?key|secret|passphrase|token|private[_-]?key)"
               r"\"?\s*[:=]\s*\"?([A-Za-z0-9_\-+/=]{8,})"),
]
_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
    "message", "asctime", "taskName",
}


def _redact(text: str) -> str:
    text = _SECRET_PATTERNS[0].sub("0x<redacted>", text)
    text = _SECRET_PATTERNS[1].sub(lambda m: f'{m.group(1)}"="***"', text)
    return text


class SecretRedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = _redact(record.msg)
        if record.args:
            with contextlib.suppress(TypeError):   # dict-style args
                record.args = tuple(
                    _redact(a) if isinstance(a, str) else a for a in record.args
                )
        for key, value in list(record.__dict__.items()):
            if key not in _RESERVED and isinstance(value, str):
                record.__dict__[key] = _redact(value)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": round(record.created, 6),
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "component": record.name,
            "event": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED:
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = str(value)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = (
            f"{time.strftime('%H:%M:%S', time.localtime(record.created))} "
            f"{record.levelname:<7} {record.name:<28} {record.getMessage()}"
        )
        extras = {
            k: v for k, v in record.__dict__.items()
            if k not in _RESERVED and not k.startswith("_")
        }
        if extras:
            base += "  " + " ".join(f"{k}={v}" for k, v in extras.items())
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


_configured = False


def setup_logging(
    level: str = "INFO",
    log_dir: Path | None = None,
    json_format: bool = True,
    console: bool = True,
    filename: str = "pmbot.log",
) -> None:
    """Idempotent root-logger configuration."""
    global _configured
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    if _configured:
        return

    for handler in list(root.handlers):
        root.removeHandler(handler)

    redactor = SecretRedactingFilter()

    if console:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(JsonFormatter() if json_format else ConsoleFormatter())
        stream.addFilter(redactor)
        root.addHandler(stream)

    if log_dir is not None:
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        rotating = logging.handlers.RotatingFileHandler(
            log_dir / filename, maxBytes=32 * 1024 * 1024, backupCount=5
        )
        rotating.setFormatter(JsonFormatter())
        rotating.addFilter(redactor)
        root.addHandler(rotating)

    for noisy in ("websockets", "httpx", "httpcore", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True


def reset_logging() -> None:
    global _configured
    _configured = False


class ContextLogger(logging.LoggerAdapter):
    """LoggerAdapter that *merges* per-call ``extra`` with bound context.

    The stdlib adapter replaces the caller's ``extra`` outright, which would
    silently drop the structured fields we attach at each call site.
    """

    def process(self, msg: Any, kwargs: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        merged = dict(self.extra or {})
        merged.update(kwargs.get("extra") or {})
        kwargs["extra"] = merged
        return msg, kwargs

    def bind(self, **context: Any) -> ContextLogger:
        merged = dict(self.extra or {})
        merged.update(context)
        return ContextLogger(self.logger, merged)


def get_logger(name: str, **context: Any) -> ContextLogger:
    """Logger that accepts structured keyword context via ``extra=``."""
    return ContextLogger(logging.getLogger(name), context)
