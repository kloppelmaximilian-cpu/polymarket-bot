"""Configuration and the live-trading safety invariants."""

from __future__ import annotations

import pytest
from pydantic import SecretStr, ValidationError

from pmbot.config import Settings, TradingMode, get_settings, reset_settings


def test_defaults_to_paper():
    settings = Settings()
    assert settings.trading_mode is TradingMode.PAPER
    assert settings.is_live is False
    assert settings.live_confirmation is False


def test_live_requires_confirmation():
    with pytest.raises(ValidationError, match="LIVE_CONFIRMATION"):
        Settings(trading_mode="live")


def test_live_with_confirmation_is_armed():
    settings = Settings(trading_mode="live", live_confirmation=True)
    assert settings.is_live is True


def test_inconsistent_time_window_rejected():
    with pytest.raises(ValidationError):
        Settings(min_seconds_remaining=300, max_seconds_remaining=100)


def test_kelly_fraction_bounds():
    with pytest.raises(ValidationError):
        Settings(kelly_fraction=0.0)
    with pytest.raises(ValidationError):
        Settings(kelly_fraction=1.5)


@pytest.mark.parametrize(
    "value,expected",
    [
        ("BTC,ETH", ["BTC", "ETH"]),
        ('["btc", "sol"]', ["BTC", "SOL"]),
        (["eth"], ["ETH"]),
    ],
)
def test_asset_list_parsing(value, expected):
    assert Settings(assets=value).assets == expected


def test_secrets_are_redacted():
    settings = Settings(
        polymarket_private_key="0x" + "a" * 64,
        polymarket_api_secret="supersecretvalue",
    )
    blob = settings.redacted_dict()
    assert blob["polymarket_private_key"] == "***"
    assert blob["polymarket_api_secret"] == "***"
    assert "a" * 64 not in str(blob)


def test_secrets_never_str_in_repr():
    settings = Settings(polymarket_private_key="0x" + "b" * 64)
    assert "b" * 64 not in repr(settings)
    assert isinstance(settings.polymarket_private_key, SecretStr)


def test_sqlite_path_extraction(tmp_path):
    settings = Settings(database_url=f"sqlite:///{tmp_path}/x.db")
    assert settings.sqlite_path == tmp_path / "x.db"


def test_singleton_reload():
    reset_settings()
    first = get_settings()
    assert get_settings() is first
    assert get_settings(reload=True) is not first
