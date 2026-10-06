"""Concrete reference-exchange adapters.

Five independent spot venues.  Each parser is written defensively: message
shapes drift over time, so a missing or renamed field yields *no tick* rather
than an exception or -- far worse -- a silently wrong price.

Both trades and top-of-book updates are consumed where available.  Trades carry
aggression information (used by the order-flow features); book updates give a
continuous mid even when trading is quiet.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..core.clock import parse_iso8601
from ..core.types import Tick
from .base import ExchangeFeed, make_tick


def _f(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f > 0 else None


class BinanceFeed(ExchangeFeed):
    """Binance spot combined stream (trade + bookTicker)."""

    name = "binance"
    symbol_map = {
        "BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT",
        "XRP": "XRPUSDT", "DOGE": "DOGEUSDT", "BNB": "BNBUSDT",
        "ADA": "ADAUSDT", "LTC": "LTCUSDT", "AVAX": "AVAXUSDT",
    }
    text_ping = None          # protocol-level pings handled by the library

    @property
    def url(self) -> str:
        streams = []
        for asset in self.assets:
            sym = self.symbol_map[asset].lower()
            streams.append(f"{sym}@trade")
            streams.append(f"{sym}@bookTicker")
        return "wss://stream.binance.com:9443/stream?streams=" + "/".join(streams)

    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        return []             # subscription is encoded in the URL

    def parse(self, message: Any) -> list[Tick]:
        data = message.get("data") if isinstance(message, dict) else None
        if not isinstance(data, dict):
            return []
        symbol = data.get("s")
        if not symbol:
            return []
        asset = self.asset_for_symbol(symbol)
        if asset is None:
            return []

        event = data.get("e")
        if event == "trade":
            price = _f(data.get("p"))
            if price is None:
                return []
            ts = data.get("T")
            return [make_tick(
                self.name, asset, symbol, price,
                size=_f(data.get("q")) or 0.0,
                exchange_ts=(ts / 1000.0) if ts else None,
                is_trade=True,
            )]

        # bookTicker has no "e" field: {u, s, b, B, a, A}
        bid, ask = _f(data.get("b")), _f(data.get("a"))
        if bid is None or ask is None or ask < bid:
            return []
        return [make_tick(
            self.name, asset, symbol, (bid + ask) / 2.0,
            size=0.0, exchange_ts=None, bid=bid, ask=ask, is_trade=False,
        )]


class CoinbaseFeed(ExchangeFeed):
    """Coinbase Exchange public market-data feed."""

    name = "coinbase"
    symbol_map = {
        "BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD",
        "XRP": "XRP-USD", "DOGE": "DOGE-USD", "ADA": "ADA-USD",
        "LTC": "LTC-USD", "AVAX": "AVAX-USD",
    }

    @property
    def url(self) -> str:
        return "wss://ws-feed.exchange.coinbase.com"

    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        return [{
            "type": "subscribe",
            "product_ids": [self.symbol_map[a] for a in self.assets],
            "channels": ["ticker"],
        }]

    def parse(self, message: Any) -> list[Tick]:
        if not isinstance(message, dict) or message.get("type") != "ticker":
            return []
        symbol = message.get("product_id")
        if not symbol:
            return []
        asset = self.asset_for_symbol(symbol)
        if asset is None:
            return []
        price = _f(message.get("price"))
        if price is None:
            return []
        ts = None
        raw_time = message.get("time")
        if isinstance(raw_time, str):
            try:
                ts = parse_iso8601(raw_time)
            except (ValueError, TypeError):
                ts = None
        bid, ask = _f(message.get("best_bid")), _f(message.get("best_ask"))
        if bid is not None and ask is not None and ask < bid:
            bid = ask = None
        return [make_tick(
            self.name, asset, symbol, price,
            size=_f(message.get("last_size")) or 0.0,
            exchange_ts=ts, bid=bid, ask=ask, is_trade=True,
        )]


class KrakenFeed(ExchangeFeed):
    """Kraken WebSocket v2 level-1 ticker."""

    name = "kraken"
    symbol_map = {
        "BTC": "BTC/USD", "ETH": "ETH/USD", "SOL": "SOL/USD",
        "XRP": "XRP/USD", "DOGE": "XDG/USD", "ADA": "ADA/USD",
        "LTC": "LTC/USD", "AVAX": "AVAX/USD",
    }

    @property
    def url(self) -> str:
        return "wss://ws.kraken.com/v2"

    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        return [{
            "method": "subscribe",
            "params": {
                "channel": "ticker",
                "symbol": [self.symbol_map[a] for a in self.assets],
            },
        }]

    def parse(self, message: Any) -> list[Tick]:
        if not isinstance(message, dict) or message.get("channel") != "ticker":
            return []
        rows = message.get("data")
        if not isinstance(rows, list):
            return []
        ticks: list[Tick] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            symbol = row.get("symbol")
            asset = self.asset_for_symbol(symbol) if symbol else None
            if asset is None:
                continue
            bid, ask = _f(row.get("bid")), _f(row.get("ask"))
            last = _f(row.get("last"))
            if bid is not None and ask is not None and ask >= bid:
                price = (bid + ask) / 2.0
            elif last is not None:
                price, bid, ask = last, None, None
            else:
                continue
            ticks.append(make_tick(
                self.name, asset, symbol, price,
                size=_f(row.get("volume")) or 0.0,
                exchange_ts=None, bid=bid, ask=ask, is_trade=False,
            ))
        return ticks


class OKXFeed(ExchangeFeed):
    """OKX v5 public trades feed."""

    name = "okx"
    symbol_map = {
        "BTC": "BTC-USDT", "ETH": "ETH-USDT", "SOL": "SOL-USDT",
        "XRP": "XRP-USDT", "DOGE": "DOGE-USDT", "BNB": "BNB-USDT",
        "ADA": "ADA-USDT", "LTC": "LTC-USDT", "AVAX": "AVAX-USDT",
    }
    text_ping = "ping"
    heartbeat_interval = 20.0

    @property
    def url(self) -> str:
        return "wss://ws.okx.com:8443/ws/v5/public"

    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        args = []
        for asset in self.assets:
            inst = self.symbol_map[asset]
            args.append({"channel": "trades", "instId": inst})
            args.append({"channel": "bbo-tbt", "instId": inst})
        return [{"op": "subscribe", "args": args}]

    def parse(self, message: Any) -> list[Tick]:
        if not isinstance(message, dict):
            return []
        arg = message.get("arg") or {}
        channel = arg.get("channel")
        rows = message.get("data")
        if not isinstance(rows, list) or not channel:
            return []
        ticks: list[Tick] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            symbol = row.get("instId") or arg.get("instId")
            asset = self.asset_for_symbol(symbol) if symbol else None
            if asset is None:
                continue
            ts_raw = row.get("ts") or message.get("ts")
            ts = (float(ts_raw) / 1000.0) if ts_raw else None

            if channel == "trades":
                price = _f(row.get("px"))
                if price is None:
                    continue
                ticks.append(make_tick(
                    self.name, asset, symbol, price,
                    size=_f(row.get("sz")) or 0.0, exchange_ts=ts, is_trade=True,
                ))
            else:  # bbo-tbt: {"bids": [[px, sz, .., ..]], "asks": [...]}
                bids, asks = row.get("bids"), row.get("asks")
                bid = _f(bids[0][0]) if isinstance(bids, list) and bids else None
                ask = _f(asks[0][0]) if isinstance(asks, list) and asks else None
                if bid is None or ask is None or ask < bid:
                    continue
                ticks.append(make_tick(
                    self.name, asset, symbol, (bid + ask) / 2.0,
                    size=0.0, exchange_ts=ts, bid=bid, ask=ask, is_trade=False,
                ))
        return ticks


class BybitFeed(ExchangeFeed):
    """Bybit v5 public spot feed."""

    name = "bybit"
    symbol_map = {
        "BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT",
        "XRP": "XRPUSDT", "DOGE": "DOGEUSDT", "BNB": "BNBUSDT",
        "ADA": "ADAUSDT", "LTC": "LTCUSDT", "AVAX": "AVAXUSDT",
    }
    json_ping = {"op": "ping"}
    heartbeat_interval = 20.0

    @property
    def url(self) -> str:
        return "wss://stream.bybit.com/v5/public/spot"

    def subscribe_messages(self) -> Iterable[str | dict[str, Any]]:
        args = []
        for asset in self.assets:
            sym = self.symbol_map[asset]
            args.append(f"publicTrade.{sym}")
            args.append(f"tickers.{sym}")
        return [{"op": "subscribe", "args": args}]

    def parse(self, message: Any) -> list[Tick]:
        if not isinstance(message, dict):
            return []
        topic = message.get("topic")
        if not isinstance(topic, str):
            return []
        payload = message.get("data")
        msg_ts = message.get("ts")

        if topic.startswith("publicTrade."):
            rows = payload if isinstance(payload, list) else []
            ticks: list[Tick] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                symbol = row.get("s") or topic.split(".", 1)[1]
                asset = self.asset_for_symbol(symbol)
                if asset is None:
                    continue
                price = _f(row.get("p"))
                if price is None:
                    continue
                ts_raw = row.get("T") or msg_ts
                ticks.append(make_tick(
                    self.name, asset, symbol, price,
                    size=_f(row.get("v")) or 0.0,
                    exchange_ts=(float(ts_raw) / 1000.0) if ts_raw else None,
                    is_trade=True,
                ))
            return ticks

        if topic.startswith("tickers."):
            row = payload if isinstance(payload, dict) else {}
            symbol = row.get("symbol") or topic.split(".", 1)[1]
            asset = self.asset_for_symbol(symbol)
            if asset is None:
                return []
            bid, ask = _f(row.get("bid1Price")), _f(row.get("ask1Price"))
            last = _f(row.get("lastPrice"))
            if bid is not None and ask is not None and ask >= bid:
                price = (bid + ask) / 2.0
            elif last is not None:
                price, bid, ask = last, None, None
            else:
                return []
            return [make_tick(
                self.name, asset, symbol, price, size=0.0,
                exchange_ts=(float(msg_ts) / 1000.0) if msg_ts else None,
                bid=bid, ask=ask, is_trade=False,
            )]

        return []


FEED_REGISTRY: dict[str, type[ExchangeFeed]] = {
    "binance": BinanceFeed,
    "coinbase": CoinbaseFeed,
    "kraken": KrakenFeed,
    "okx": OKXFeed,
    "bybit": BybitFeed,
}


def build_feeds(names, assets, on_tick=None, **kwargs) -> list[ExchangeFeed]:
    """Instantiate the configured feeds, skipping unknown names."""
    feeds: list[ExchangeFeed] = []
    for name in names:
        cls = FEED_REGISTRY.get(name.lower())
        if cls is None:
            continue
        feed = cls(assets=assets, on_tick=on_tick, **kwargs)
        if feed.assets:
            feeds.append(feed)
    return feeds
