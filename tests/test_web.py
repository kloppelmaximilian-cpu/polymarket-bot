"""Local web dashboard.

Read-only, loopback, and separate from the trading loop -- the same contract
the terminal dashboard has. The tests that matter are the ones about telling
the truth when there is no fresh data, and about not letting anything other
than a local browser read an account statement.
"""

from __future__ import annotations

import http.client
import json
import threading
import time

import pytest

from pmbot.dashboard.web import LOOPBACK_HOSTS, build_server, page_path


@pytest.fixture
def snapshot():
    from tests.test_dashboard import full_snapshot

    return full_snapshot()


@pytest.fixture
def server(tmp_path):
    """A running server on an ephemeral port, torn down afterwards."""
    state = tmp_path / "state.json"
    instance = build_server(state, port=0)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    port = instance.server_address[1]

    def request(path: str, host: str | None = None, method: str = "GET"):
        """Always connect to loopback; only the Host *header* varies.

        urllib derives the connection target from the URL, so overriding the
        header there would make it dial the attacker's name for real.
        """
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            headers = {"Host": host} if host else {}
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    try:
        yield request, state
    finally:
        instance.shutdown()
        instance.server_close()


def _state(request):
    status, body, _ = request("/api/state")
    assert status == 200
    return json.loads(body)


class TestPage:
    def test_the_page_ships_with_the_package(self):
        """A missing asset would only show up at runtime otherwise."""
        assert page_path().exists()
        assert page_path().suffix == ".html"

    def test_root_serves_html(self, server):
        request, _ = server
        status, body, headers = request("/")
        assert status == 200
        assert headers["Content-Type"].startswith("text/html")
        assert b"<title>pmbot</title>" in body

    def test_the_page_fetches_nothing_from_the_internet(self, server):
        """A trading tool must not load code from a CDN at runtime."""
        request, _ = server
        _, body, _ = request("/")
        text = body.decode()
        assert "http://" not in text
        assert "https://" not in text
        assert "//cdn" not in text

    def test_the_poll_interval_reaches_the_page(self, tmp_path):
        instance = build_server(tmp_path / "s.json", port=0, poll_interval_ms=2500)
        try:
            handler = instance.RequestHandlerClass
            assert handler.poll_interval_ms == 2500
        finally:
            instance.server_close()

    def test_an_absurd_interval_is_floored(self, tmp_path):
        """A 10ms poll would spin the browser for no extra information."""
        instance = build_server(tmp_path / "s.json", port=0, poll_interval_ms=10)
        try:
            assert instance.RequestHandlerClass.poll_interval_ms == 250
        finally:
            instance.server_close()

    def test_head_is_allowed(self, server):
        request, _ = server
        status, body, _ = request("/", method="HEAD")
        assert status == 200
        assert body == b""

    def test_unknown_paths_404(self, server):
        request, _ = server
        assert request("/../../etc/passwd")[0] == 404
        assert request("/admin")[0] == 404


class TestState:
    def test_a_fresh_snapshot_is_reported_live(self, server, snapshot):
        request, state = server
        snapshot["ts"] = time.time()
        state.write_text(json.dumps(snapshot))
        data = _state(request)
        assert data["connected"] is True
        assert data["stale"] is False
        assert data["age"] < 5.0
        assert data["payload"]["mode"] == snapshot["mode"]

    def test_a_missing_snapshot_says_so(self, server):
        """Never an empty dashboard that looks like a flat day."""
        request, _ = server
        data = _state(request)
        assert data["connected"] is False
        assert "not found" in data["error"]
        assert data["payload"] == {}

    def test_a_stale_snapshot_is_flagged_and_explained(self, server, snapshot):
        request, state = server
        snapshot["ts"] = time.time() - 600
        state.write_text(json.dumps(snapshot))
        data = _state(request)
        assert data["stale"] is True
        assert data["age"] > 500
        assert any("old" in w for w in data["warnings"])

    def test_a_timestampless_snapshot_does_not_serialise_infinity(self, server, snapshot):
        """`inf` is not JSON, and absent is not "zero seconds old"."""
        request, state = server
        snapshot.pop("ts", None)
        state.write_text(json.dumps(snapshot))
        _, body, _ = request("/api/state")
        assert b"Infinity" not in body
        data = json.loads(body)
        assert data["age"] == -1.0
        assert data["stale"] is True

    def test_corrupt_json_is_an_error_not_a_crash(self, server):
        request, state = server
        state.write_text("{ this is not json")
        data = _state(request)
        assert data["connected"] is False
        assert "JSONDecodeError" in data["error"]

    def test_warnings_come_from_the_shared_reader(self, server, snapshot):
        """Both dashboards must agree on what counts as a problem."""
        request, state = server
        snapshot["ts"] = time.time()
        snapshot["risk"] = dict(snapshot.get("risk", {}))
        snapshot["risk"]["trading_paused"] = True
        snapshot["risk"]["pause_reason"] = "feeds degraded"
        state.write_text(json.dumps(snapshot))
        data = _state(request)
        assert any("TRADING PAUSED: feeds degraded" in w for w in data["warnings"])

    def test_healthz_does_not_need_a_snapshot(self, server):
        request, _ = server
        status, body, _ = request("/healthz")
        assert status == 200
        assert json.loads(body)["ok"] is True


class TestNotAnOpenEndpoint:
    """The payload is a live account statement: positions, balances, P&L."""

    @pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
    def test_loopback_hosts_are_accepted(self, server, host):
        request, _ = server
        assert request("/api/state", host=host)[0] == 200

    def test_a_foreign_host_header_is_refused(self, server):
        """DNS rebinding: a public page can aim its own name at 127.0.0.1."""
        request, _ = server
        status, body, _ = request("/api/state", host="attacker.example.com")
        assert status == 403
        assert b"host not allowed" in body

    def test_the_refusal_covers_the_page_too(self, server):
        request, _ = server
        assert request("/", host="attacker.example.com")[0] == 403

    def test_a_port_on_the_host_header_is_still_loopback(self, server):
        request, _ = server
        assert request("/api/state", host="localhost:8787")[0] == 200

    def test_no_cors_header_is_sent(self, server, snapshot):
        """Without it, another origin's JavaScript cannot read the response."""
        request, state = server
        snapshot["ts"] = time.time()
        state.write_text(json.dumps(snapshot))
        _, _, headers = request("/api/state")
        assert not any(h.lower().startswith("access-control") for h in headers)

    def test_responses_are_not_cached(self, server):
        request, _ = server
        _, _, headers = request("/api/state")
        assert headers["Cache-Control"] == "no-store"

    def test_the_configured_host_is_also_allowed(self, tmp_path):
        """Binding elsewhere on purpose must not then refuse its own name."""
        instance = build_server(tmp_path / "s.json", host="0.0.0.0", port=0)
        try:
            assert "0.0.0.0" in instance.RequestHandlerClass.allowed_hosts
            assert instance.RequestHandlerClass.allowed_hosts >= LOOPBACK_HOSTS
        finally:
            instance.server_close()
