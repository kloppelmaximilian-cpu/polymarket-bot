"""Shared fixtures."""

from __future__ import annotations

import time

import pytest

from pmbot.config import Settings, reset_settings
from pmbot.core.clock import SimulatedClock
from pmbot.core.types import (
    BookSnapshot,
    Market,
    Outcome,
    PriceLevel,
    TokenInfo,
)
from pmbot.logging_setup import reset_logging, setup_logging


@pytest.fixture(autouse=True)
def _quiet_logging():
    reset_logging()
    setup_logging("CRITICAL", log_dir=None, json_format=True, console=False)
    yield
    reset_logging()


@pytest.fixture(autouse=True)
def _clean_settings():
    reset_settings()
    yield
    reset_settings()


@pytest.fixture
def tmp_settings(tmp_path):
    def build(**overrides) -> Settings:
        base = {
            "database_url": f"sqlite:///{tmp_path}/test.db",
            "log_dir": tmp_path / "logs",
            "model_dir": tmp_path / "models",
            "bankroll": 1000.0,
            "ml_enabled": False,
            "record_training_data": True,
        }
        base.update(overrides)
        return Settings(**base)

    return build


@pytest.fixture
def clock():
    return SimulatedClock(1_760_000_000.0)


def make_market(
    market_id: str = "m1",
    asset: str = "BTC",
    window_start: float = 1_760_000_000.0,
    window_seconds: int = 300,
    tick_size: float = 0.01,
    min_order_size: float = 5.0,
    taker_fee_rate: float = 0.07,
) -> Market:
    return Market(
        market_id=market_id,
        condition_id=f"0x{market_id}",
        question_id=None,
        slug=f"{asset.lower()}-updown-5m-{int(window_start)}",
        asset=asset,
        title=f"{asset} Up or Down",
        window_start=window_start,
        window_end=window_start + window_seconds,
        tokens={
            Outcome.UP: TokenInfo(f"{market_id}-UP", Outcome.UP, "Up"),
            Outcome.DOWN: TokenInfo(f"{market_id}-DOWN", Outcome.DOWN, "Down"),
        },
        tick_size=tick_size,
        min_order_size=min_order_size,
        neg_risk=False,
        enable_order_book=True,
        accepting_orders=True,
        active=True,
        closed=False,
        resolution_source="https://data.chain.link/streams/btc-usd",
        taker_fee_rate=taker_fee_rate,
        maker_fee_rate=0.0,
        fee_type="crypto_fees_v2",
        series_slug=f"{asset.lower()}-up-or-down-5m",
    )


def make_book(
    token_id: str = "m1-UP",
    bid: float = 0.50,
    ask: float = 0.51,
    bid_size: float = 100.0,
    ask_size: float = 100.0,
    depth: int = 4,
    timestamp: float | None = None,
    tick_size: float = 0.01,
) -> BookSnapshot:
    ts = time.time() if timestamp is None else timestamp
    bids = [
        PriceLevel(round(bid - i * tick_size, 6), bid_size * (1 + i))
        for i in range(depth)
        if 0.0 < bid - i * tick_size < 1.0
    ]
    asks = [
        PriceLevel(round(ask + i * tick_size, 6), ask_size * (1 + i))
        for i in range(depth)
        if 0.0 < ask + i * tick_size < 1.0
    ]
    return BookSnapshot(
        token_id=token_id, bids=bids, asks=asks, timestamp=ts, tick_size=tick_size
    )


@pytest.fixture
def market_factory():
    return make_market


@pytest.fixture
def book_factory():
    return make_book
