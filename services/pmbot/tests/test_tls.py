"""TLS trust store.

The bug this covers was partial and therefore confusing: REST discovery
worked, every websocket failed with `unable to get local issuer certificate`,
and the bot looked unable to reach exchanges it was already talking to over
HTTPS. The cause is that `httpx` verifies against certifi's bundle while
`websockets` asks OpenSSL for its own paths, which on a python.org macOS build
are empty until the certificate installer has run.
"""

from __future__ import annotations

import logging
import ssl

import pytest

from pmbot.core.tls import (
    CA_BUNDLE_ENV_VARS,
    ca_bundle_path,
    ssl_context_for,
    tls_kwargs,
    trust_store_summary,
)


@pytest.fixture(autouse=True)
def _no_inherited_overrides(monkeypatch):
    """Start from a clean environment: the host may set these itself."""
    for name in CA_BUNDLE_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


class TestSchemeHandling:
    def test_wss_gets_a_verifying_context(self):
        context = ssl_context_for("wss://ws-subscriptions-clob.polymarket.com/ws/market")
        assert isinstance(context, ssl.SSLContext)
        assert context.verify_mode is ssl.CERT_REQUIRED
        assert context.check_hostname is True

    def test_plain_ws_gets_nothing(self):
        """`websockets` raises if handed an ssl argument on a ws:// URI."""
        assert ssl_context_for("ws://localhost:8765") is None
        assert tls_kwargs("ws://localhost:8765") == {}

    def test_scheme_match_is_case_insensitive(self):
        assert ssl_context_for("WSS://EXAMPLE.COM/feed") is not None

    def test_kwargs_carry_the_context(self):
        kwargs = tls_kwargs("wss://stream.binance.com:9443/stream")
        assert set(kwargs) == {"ssl"}
        assert isinstance(kwargs["ssl"], ssl.SSLContext)


class TestBundleSelection:
    def test_certifi_is_the_default(self):
        import certifi

        assert ca_bundle_path() == certifi.where()

    def test_the_default_store_is_not_empty(self):
        """The whole point: verify against a bundle that has CAs in it."""
        assert len(ssl_context_for("wss://x/").get_ca_certs()) > 50

    @pytest.mark.parametrize("env_var", CA_BUNDLE_ENV_VARS)
    def test_an_existing_override_wins(self, monkeypatch, tmp_path, env_var):
        """An operator behind a TLS-inspecting proxy must be able to say so."""
        bundle = tmp_path / "corporate.pem"
        bundle.write_text("")
        monkeypatch.setenv(env_var, str(bundle))
        assert ca_bundle_path() == str(bundle)
        assert trust_store_summary() == (env_var, str(bundle))

    def test_precedence_is_pmbot_then_ssl_cert_file(self, monkeypatch, tmp_path):
        mine, theirs = tmp_path / "mine.pem", tmp_path / "theirs.pem"
        mine.write_text("")
        theirs.write_text("")
        monkeypatch.setenv("SSL_CERT_FILE", str(theirs))
        monkeypatch.setenv("PMBOT_CA_BUNDLE", str(mine))
        assert ca_bundle_path() == str(mine)

    def test_a_missing_override_is_ignored_loudly(self, monkeypatch, tmp_path, caplog):
        """Silently falling back would hide a typo in a security setting."""
        import certifi

        caplog.set_level(logging.WARNING)
        monkeypatch.setenv("PMBOT_CA_BUNDLE", str(tmp_path / "absent.pem"))
        assert ca_bundle_path() == certifi.where()
        assert any("does not exist" in r.getMessage() for r in caplog.records)

    def test_summary_names_certifi_when_unset(self):
        source, detail = trust_store_summary()
        assert source == "certifi"
        assert detail.endswith(".pem")


class TestContextReuse:
    def test_contexts_are_cached_per_bundle(self):
        """Reconnect storms must not re-parse a 250KB PEM each time."""
        first = ssl_context_for("wss://a/")
        second = ssl_context_for("wss://b/")
        assert first is second

    def test_a_different_bundle_gets_a_different_context(self, monkeypatch, tmp_path):
        import shutil

        import certifi

        default = ssl_context_for("wss://a/")
        bundle = tmp_path / "other.pem"
        shutil.copyfile(certifi.where(), bundle)       # valid, different path
        monkeypatch.setenv("PMBOT_CA_BUNDLE", str(bundle))
        assert ssl_context_for("wss://a/") is not default


class TestFeedsUseIt:
    """The regression itself: both connect paths must pass the context."""

    @staticmethod
    def _capture(monkeypatch, feed):
        """Record the first connect attempt, then end the reconnect loop.

        The loop checks ``_stop`` before connecting, so it cannot be set in
        advance -- the feed would exit without ever calling connect.
        """
        captured: dict = {}

        def fake_connect(url, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            feed._stop.set()
            raise OSError("refused by the test")

        import websockets

        monkeypatch.setattr(websockets, "connect", fake_connect)
        return captured

    async def test_exchange_feed_passes_the_context(self, monkeypatch):
        from pmbot.exchanges.venues import BinanceFeed

        feed = BinanceFeed(["BTC"], reconnect_base=0.0, reconnect_max=0.0)
        captured = self._capture(monkeypatch, feed)
        await feed.run()
        assert captured["url"].startswith("wss://")
        assert isinstance(captured["kwargs"]["ssl"], ssl.SSLContext)

    async def test_polymarket_feed_passes_the_context(self, monkeypatch):
        from pmbot.orderbook.book import OrderBookManager
        from pmbot.polymarket.clob_ws import PolymarketMarketFeed

        feed = PolymarketMarketFeed(
            OrderBookManager(), reconnect_base=0.0, reconnect_max=0.0
        )
        captured = self._capture(monkeypatch, feed)
        await feed.run()
        assert captured["url"].startswith("wss://")
        assert isinstance(captured["kwargs"]["ssl"], ssl.SSLContext)
