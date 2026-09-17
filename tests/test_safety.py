"""Live-trading safety, authentication and secret handling.

These are the tests that matter most: everything here guards against either
losing real money by accident or leaking a key.
"""

from __future__ import annotations

import base64
import logging

import pytest
from pydantic import ValidationError

from pmbot.config import Settings, TradingMode
from pmbot.execution.live import LiveTradingNotArmed, LiveVenue, _mask, _tick_literal
from pmbot.logging_setup import (
    JsonFormatter,
    SecretRedactingFilter,
    install_loop_exception_handler,
    loop_exception_handler,
)
from pmbot.polymarket.auth import (
    ApiCreds,
    build_hmac_signature,
    l2_headers,
    ws_auth_payload,
)
from pmbot.polymarket.clob_rest import ClobRestClient

SECRET = base64.urlsafe_b64encode(b"0123456789abcdef0123456789abcdef").decode()
PRIVATE_KEY = "0x" + "a" * 64


class TestLiveArming:
    def test_paper_mode_cannot_build_a_live_venue(self):
        with pytest.raises(LiveTradingNotArmed, match="not 'live'"):
            LiveVenue(Settings(), ClobRestClient())

    def test_live_without_confirmation_is_rejected_at_config_time(self):
        with pytest.raises(ValidationError, match="LIVE_CONFIRMATION"):
            Settings(trading_mode="live")

    def test_live_without_a_key_is_refused(self):
        settings = Settings(trading_mode="live", live_confirmation=True)
        with pytest.raises(LiveTradingNotArmed, match="PRIVATE_KEY"):
            LiveVenue(settings, ClobRestClient())

    def test_live_without_l2_credentials_is_refused(self):
        settings = Settings(
            trading_mode="live", live_confirmation=True,
            polymarket_private_key=PRIVATE_KEY,
        )
        with pytest.raises(LiveTradingNotArmed, match="API credentials"):
            LiveVenue(settings, ClobRestClient())

    def test_fully_armed_venue_can_be_built(self):
        settings = Settings(
            trading_mode="live", live_confirmation=True,
            polymarket_private_key=PRIVATE_KEY, polymarket_api_key="k",
            polymarket_api_secret=SECRET, polymarket_api_passphrase="p",
        )
        venue = LiveVenue(settings, ClobRestClient())
        assert venue.is_live is True
        assert venue.dry_run is False

    def test_dry_run_is_visible_on_the_venue(self):
        settings = Settings(
            trading_mode="live", live_confirmation=True, dry_run_live=True,
            polymarket_private_key=PRIVATE_KEY, polymarket_api_key="k",
            polymarket_api_secret=SECRET, polymarket_api_passphrase="p",
        )
        assert LiveVenue(settings, ClobRestClient()).dry_run is True

    async def test_dry_run_never_posts(self, monkeypatch):
        settings = Settings(
            trading_mode="live", live_confirmation=True, dry_run_live=True,
            polymarket_private_key=PRIVATE_KEY, polymarket_api_key="k",
            polymarket_api_secret=SECRET, polymarket_api_passphrase="p",
        )
        rest = ClobRestClient()
        venue = LiveVenue(settings, rest)

        posted = []

        async def fail_post(payload):
            posted.append(payload)
            raise AssertionError("dry run must not POST an order")

        async def fake_tick(token_id, ttl=300.0):
            return 0.01

        async def fake_neg_risk(token_id):
            return False

        monkeypatch.setattr(rest, "post_order", fail_post)
        monkeypatch.setattr(rest, "get_tick_size", fake_tick)
        monkeypatch.setattr(rest, "get_neg_risk", fake_neg_risk)
        monkeypatch.setattr(venue._signer, "build", lambda *a, **k: {"signed": True})

        from pmbot.core.types import OrderKind, OrderRequest, Outcome, Side

        result = await venue.submit(OrderRequest(
            market_id="m1", condition_id="0x1", token_id="t", asset="BTC",
            outcome=Outcome.UP, side=Side.BUY, price=0.52, size=10,
            kind=OrderKind.GTC,
        ))
        assert posted == []
        assert "dry run" in result.error

    def test_paper_is_the_default_everywhere(self):
        assert Settings().trading_mode is TradingMode.PAPER
        assert Settings().is_live is False


class TestAuthentication:
    def test_hmac_matches_the_official_client(self):
        """Byte-for-byte agreement with py-clob-client's implementation."""
        official = pytest.importorskip("py_clob_client.signing.hmac")
        for timestamp, method, path, body in [
            (1_000_000, "POST", "/order", '{"a":1}'),
            (1_700_000_000, "GET", "/data/orders", None),
            (42, "DELETE", "/order", '{"orderID":"0x1"}'),
        ]:
            assert build_hmac_signature(SECRET, timestamp, method, path, body) == \
                official.build_hmac_signature(SECRET, timestamp, method, path, body)

    def test_headers_carry_every_required_field(self):
        headers = l2_headers(
            "0xADDR", ApiCreds("key", SECRET, "pass"), "GET", "/data/orders",
            timestamp=1_000_000,
        )
        for field in ("POLY_ADDRESS", "POLY_SIGNATURE", "POLY_TIMESTAMP",
                      "POLY_API_KEY", "POLY_PASSPHRASE"):
            assert field in headers

    def test_body_changes_the_signature(self):
        first = build_hmac_signature(SECRET, 1, "POST", "/order", '{"a":1}')
        second = build_hmac_signature(SECRET, 1, "POST", "/order", '{"a":2}')
        assert first != second

    def test_creds_repr_hides_the_secret(self):
        # Distinctive values so a match cannot come from a field name.
        text = repr(ApiCreds("key", SECRET, "PASSPHRASE-VALUE-9f3a"))
        assert SECRET not in text
        assert "PASSPHRASE-VALUE-9f3a" not in text
        assert "***" in text

    def test_ws_auth_payload_shape(self):
        payload = ws_auth_payload(ApiCreds("k", "s", "p"))
        assert payload == {"apiKey": "k", "secret": "s", "passphrase": "p"}

    def test_read_endpoints_need_no_credentials(self):
        assert ClobRestClient().has_l2 is False

    async def test_authenticated_endpoint_refuses_without_credentials(self):
        from pmbot.polymarket.http import ApiError

        with pytest.raises(ApiError, match="L2 credentials"):
            await ClobRestClient().post_order({"a": 1})


class TestSecretHandling:
    def test_private_key_is_redacted_from_logs(self, caplog):
        record = logging.LogRecord(
            "t", logging.INFO, "f", 1, "key is %s", (PRIVATE_KEY,), None
        )
        SecretRedactingFilter().filter(record)
        assert PRIVATE_KEY not in record.getMessage()
        assert "redacted" in record.getMessage()

    def test_structured_fields_are_redacted(self):
        record = logging.LogRecord("t", logging.INFO, "f", 1, "msg", (), None)
        record.__dict__["private_key"] = PRIVATE_KEY
        SecretRedactingFilter().filter(record)
        assert PRIVATE_KEY not in record.__dict__["private_key"]

    def test_json_formatter_emits_the_required_fields(self):
        import json

        record = logging.LogRecord("comp", logging.INFO, "f", 1, "event", (), None)
        record.__dict__["market"] = "m1"
        payload = json.loads(JsonFormatter().format(record))
        for field in ("timestamp", "level", "component", "event"):
            assert field in payload
        assert payload["market"] == "m1"

    def test_config_dump_redacts_every_secret(self):
        settings = Settings(
            polymarket_private_key=PRIVATE_KEY, polymarket_api_secret=SECRET,
            polymarket_api_passphrase="PASSPHRASE-VALUE-9f3a",
            telegram_bot_token="TELEGRAM-TOKEN-7c1d",
        )
        blob = str(settings.redacted_dict())
        assert PRIVATE_KEY not in blob
        assert SECRET not in blob
        assert "PASSPHRASE-VALUE-9f3a" not in blob
        assert "TELEGRAM-TOKEN-7c1d" not in blob
        assert blob.count("***") >= 4

    def test_address_masking(self):
        assert _mask(None) == "unset"
        masked = _mask("0x1234567890abcdef1234")
        assert masked.startswith("0x1234")
        assert "7890abcdef" not in masked


class TestTickLiterals:
    @pytest.mark.parametrize(
        "tick,expected",
        [(0.1, "0.1"), (0.01, "0.01"), (0.001, "0.001"), (0.0001, "0.0001")],
    )
    def test_known_ticks_map_exactly(self, tick, expected):
        assert _tick_literal(tick) == expected

    def test_unknown_tick_falls_back_to_the_safe_value(self):
        assert _tick_literal(0.005) == "0.01"


class TestLoopExceptionHandler:
    """An exception in a loop callback must stay visible without crying wolf.

    asyncio routes those to the loop handler, never to the ``except`` block
    around the thing that failed, so without this the two failure classes are
    indistinguishable in the log: a proxy refusing a websocket (expected, the
    feed is already reconnecting) and a genuine bug in a callback.
    """

    @staticmethod
    def _context(message: str, exc: BaseException | None) -> dict:
        return {"message": message, "exception": exc}

    def test_a_real_callback_failure_is_an_error(self, caplog):
        caplog.set_level(logging.DEBUG)
        loop_exception_handler(
            None, self._context("Task exception was never retrieved", KeyError("side")),
        )
        records = [r for r in caplog.records if r.name == "pmbot.asyncio"]
        assert len(records) == 1
        assert records[0].levelno == logging.ERROR
        assert records[0].error == "KeyError: 'side'"

    def test_the_websockets_proxy_artefact_is_demoted(self, caplog):
        caplog.set_level(logging.DEBUG)
        loop_exception_handler(
            None,
            self._context(
                "Exception in callback _SelectorSocketTransport._call_connection_lost",
                AttributeError("'NoneType' object has no attribute 'status_code'"),
            ),
        )
        records = [r for r in caplog.records if r.name == "pmbot.asyncio"]
        assert len(records) == 1, "demoted, not dropped: it must still be logged"
        assert records[0].levelno == logging.DEBUG

    def test_a_similar_looking_but_different_failure_stays_an_error(self, caplog):
        """Only the exact combination is benign, not either half of it."""
        caplog.set_level(logging.DEBUG)
        loop_exception_handler(
            None,
            self._context(
                "Exception in callback _SelectorSocketTransport._call_connection_lost",
                RuntimeError("book writer died"),
            ),
        )
        assert [r for r in caplog.records if r.name == "pmbot.asyncio"][0].levelno == (
            logging.ERROR
        )

    def test_a_context_without_an_exception_still_reports(self, caplog):
        caplog.set_level(logging.DEBUG)
        loop_exception_handler(None, {"message": "socket.send() raised exception."})
        record = [r for r in caplog.records if r.name == "pmbot.asyncio"][0]
        assert record.levelno == logging.ERROR
        assert record.error is None

    def test_secrets_in_a_loop_exception_are_redacted(self):
        formatter = JsonFormatter()
        redactor = SecretRedactingFilter()
        record = logging.LogRecord(
            "pmbot.asyncio", logging.ERROR, __file__, 0,
            "Task exception was never retrieved", (), None,
        )
        record.error = f"ApiError: private_key={'0' * 63}1 rejected"
        redactor.filter(record)
        assert "0" * 63 not in formatter.format(record)

    async def test_install_targets_the_running_loop(self):
        import asyncio

        install_loop_exception_handler()
        assert asyncio.get_running_loop().get_exception_handler() is (
            loop_exception_handler
        )

    def test_install_outside_a_loop_is_a_no_op(self):
        install_loop_exception_handler()          # must not raise
