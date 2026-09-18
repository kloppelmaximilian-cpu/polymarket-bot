"""Local web dashboard.

Same data as the terminal dashboard, same architecture: a *separate process*
that reads the snapshot the runner publishes atomically.  A browser tab left
open overnight, or ten of them, cannot slow the trading loop, because this
never touches it -- it only reads a file the runner already writes.

Deliberately small: the standard library's HTTP server, one HTML page, one
JSON endpoint.  A trading tool does not need a web framework, and it certainly
does not need a page that fetches code from a CDN at runtime.

Bound to loopback.  The payload is a live account statement -- positions,
balances, P&L -- so serving it on a shared network is opt-in and says so.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..logging_setup import get_logger
from .state import StateReader

log = get_logger("pmbot.web")

#: Loopback names a browser may use to reach us. Anything else in the Host
#: header is refused: a page on the public internet can otherwise point a
#: hostname it controls at 127.0.0.1 and read this dashboard through the
#: victim's browser (DNS rebinding). Cheap to block, so block it.
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]", "::1"})


def page_path() -> Path:
    return Path(__file__).resolve().parent / "web" / "index.html"


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "pmbot"
    sys_version = ""

    # Injected by serve().
    reader: StateReader
    allowed_hosts: frozenset[str]
    poll_interval_ms: int

    # ------------------------------------------------------------- plumbing
    def log_message(self, fmt: str, *args: Any) -> None:
        # BaseHTTPRequestHandler writes to stderr unstructured; route it to
        # the same JSON log as everything else, at debug.
        log.debug("http", extra={"client": self.address_string(), "line": fmt % args})

    def _host_allowed(self) -> bool:
        host = (self.headers.get("Host") or "").strip()
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        if name.startswith("[") and "]" in name:
            name = name[: name.index("]") + 1]
        return name.lower() in self.allowed_hosts

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # No Access-Control-Allow-Origin: another site's JavaScript has no
        # business reading this.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, default=str).encode()
        self._send(status, body, "application/json; charset=utf-8")

    # --------------------------------------------------------------- routes
    def do_HEAD(self) -> None:                      # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:                       # noqa: N802
        if not self._host_allowed():
            self._json(403, {"error": "host not allowed"})
            return

        route = urlparse(self.path).path.rstrip("/") or "/"
        if route == "/":
            self._serve_page()
        elif route == "/api/state":
            self._serve_state()
        elif route == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def _serve_page(self) -> None:
        try:
            html = page_path().read_text(encoding="utf-8")
        except OSError as exc:
            self._json(500, {"error": f"page missing: {exc}"})
            return
        html = html.replace("<body>", f'<body data-interval="{self.poll_interval_ms}">', 1)
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _serve_state(self) -> None:
        state = self.reader.read()
        self._json(200, {
            "connected": state.connected,
            "stale": state.stale,
            # `inf` is not JSON, and a missing timestamp is not "age zero".
            "age": state.age if state.age != float("inf") else -1.0,
            "error": state.error,
            # The warning list is computed once, in the reader both dashboards
            # share, so the two cannot drift on what counts as a problem.
            "warnings": state.warnings() if state.connected else [],
            "payload": state.payload,
        })


def build_server(
    state_path: Path,
    host: str = "127.0.0.1",
    port: int = 8787,
    poll_interval_ms: int = 1000,
    stale_after: float = 8.0,
) -> ThreadingHTTPServer:
    handler = type("BoundDashboardHandler", (DashboardHandler,), {
        "reader": StateReader(state_path, stale_after=stale_after),
        "allowed_hosts": LOOPBACK_HOSTS | {host.lower()},
        "poll_interval_ms": max(250, int(poll_interval_ms)),
    })
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def serve(
    state_path: Path,
    host: str = "127.0.0.1",
    port: int = 8787,
    poll_interval_ms: int = 1000,
    open_browser: bool = False,
) -> None:
    """Serve until interrupted."""
    server = build_server(state_path, host, port, poll_interval_ms)
    bound_host, bound_port = server.server_address[:2]
    url = f"http://{host}:{bound_port}/"

    if host not in LOOPBACK_HOSTS:
        log.warning(
            "dashboard bound beyond loopback: it exposes positions and balances "
            "to anyone who can reach this host",
            extra={"host": host, "port": bound_port},
        )

    log.info("web dashboard listening", extra={"url": url, "state": str(state_path)})
    print(f"pmbot dashboard: {url}")
    print(f"reading {state_path}")
    if host not in LOOPBACK_HOSTS:
        print(f"WARNING: bound to {bound_host} -- reachable from the network.")
    print("Ctrl-C to stop.")

    if open_browser:
        import webbrowser

        threading.Timer(0.4, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print()
    finally:
        server.shutdown()
        server.server_close()
        log.info("web dashboard stopped")
