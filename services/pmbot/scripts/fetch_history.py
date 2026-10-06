#!/usr/bin/env python3
"""Download real history and assemble a replay session.

Two sources, both required for a meaningful historical backtest:

* **Reference price** -- 1-second or 1-minute klines from a public exchange
  endpoint.  1s resolution is what the strategies actually want; Binance serves
  ``interval=1s`` for recent history.
* **Polymarket market price** -- ``/prices-history`` on the CLOB for each
  window's UP token, which gives the market's own mid over the window.

Markets themselves are discovered through the Gamma series endpoint, so no ids
are hard-coded here either.

Both endpoints must be reachable.  If your host blocks them (a corporate proxy,
a restricted cloud egress policy, or a geo-block) this script will say so
plainly rather than producing a half-empty session -- and the *recorded* route
(run the bot in paper mode, then ``--source database``) remains available and is
better evidence anyway.

    python scripts/fetch_history.py --assets BTC ETH --hours 6 --out data/session.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from pmbot.backtesting.real import (  # noqa: E402
    BookReconstruction,
    HistoricalWindow,
    save_session,
    session_from_history,
)
from pmbot.config import get_settings  # noqa: E402
from pmbot.core.types import Outcome  # noqa: E402
from pmbot.logging_setup import get_logger, setup_logging  # noqa: E402
from pmbot.polymarket.clob_rest import ClobRestClient  # noqa: E402
from pmbot.polymarket.discovery import MarketDiscovery  # noqa: E402
from pmbot.polymarket.gamma import GammaClient  # noqa: E402
from pmbot.polymarket.http import ApiError, HttpClient  # noqa: E402

log = get_logger("pmbot.fetch_history")

BINANCE_SYMBOLS = {
    "BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT",
    "XRP": "XRPUSDT", "DOGE": "DOGEUSDT", "BNB": "BNBUSDT",
}


async def fetch_klines(
    client: HttpClient, asset: str, start_ms: int, end_ms: int, interval: str = "1s"
) -> list[tuple[float, float]]:
    """Klines as ``[(epoch_seconds, close_price)]``."""
    symbol = BINANCE_SYMBOLS.get(asset.upper())
    if symbol is None:
        log.warning("no kline symbol mapping", extra={"asset": asset})
        return []

    out: list[tuple[float, float]] = []
    cursor = start_ms
    while cursor < end_ms:
        rows = await client.get("/api/v3/klines", params={
            "symbol": symbol, "interval": interval,
            "startTime": cursor, "endTime": end_ms, "limit": 1000,
        })
        if not isinstance(rows, list) or not rows:
            break
        for row in rows:
            try:
                out.append((float(row[0]) / 1000.0, float(row[4])))
            except (TypeError, ValueError, IndexError):
                continue
        last_open = float(rows[-1][0])
        if last_open <= cursor:
            break
        cursor = int(last_open) + 1
        if len(out) > 400_000:
            break
    return out


async def fetch_market_history(
    clob: ClobRestClient, token_id: str, start_ts: float, end_ts: float
) -> list[tuple[float, float]]:
    try:
        return await clob.get_price_history(
            token_id, start_ts=int(start_ts), end_ts=int(end_ts), fidelity=1
        )
    except ApiError as exc:
        log.warning(
            "price history unavailable",
            extra={"token": token_id[:16], "error": str(exc)[:160]},
        )
        return []


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", nargs="+", default=["BTC", "ETH"])
    parser.add_argument("--hours", type=float, default=6.0,
                        help="how far back to fetch")
    parser.add_argument("--interval", default="1s", help="kline interval (1s or 1m)")
    parser.add_argument("--out", type=pathlib.Path,
                        default=pathlib.Path("data/history_session.json"))
    parser.add_argument("--spread", type=float, default=0.01,
                        help="assumed spread for the reconstructed book")
    parser.add_argument("--top-size", type=float, default=30.0,
                        help="assumed top-of-book size in shares")
    parser.add_argument("--binance-url", default="https://api.binance.com")
    args = parser.parse_args()

    settings = get_settings()
    setup_logging("INFO", settings.log_dir, json_format=False)

    end = time.time()
    start = end - args.hours * 3600

    gamma = GammaClient(settings.gamma_base_url)
    clob = ClobRestClient(settings.clob_base_url)
    klines_client = HttpClient(args.binance_url, rate_per_sec=8.0, name="klines")

    try:
        discovery = MarketDiscovery(
            gamma=gamma, assets=args.assets,
            series_slug_templates=settings.series_slug_templates,
            window_seconds=settings.market_window_seconds,
            lookahead_seconds=0, max_markets=10_000,
        )
        try:
            # Closed markets carry the resolved outcome we need for labels.
            events = []
            for asset in args.assets:
                for template in settings.series_slug_templates:
                    slug = template.format(
                        asset_lower=asset.lower(), asset_upper=asset.upper(),
                        asset=asset.lower(),
                    )
                    rows = await gamma.events_by_series_slug(slug, closed=True)
                    if rows:
                        events.extend(rows)
                        break
        except ApiError as exc:
            print(f"ERROR: could not reach the Gamma API: {exc}", file=sys.stderr)
            print(
                "The Polymarket API is not reachable from this host. Run the bot "
                "in paper mode instead and backtest with --source database.",
                file=sys.stderr,
            )
            return 2

        markets = []
        for event in events:
            markets.extend(discovery._markets_from_event(event))
        markets = [
            m for m in markets if start <= m.window_start and m.window_end <= end
        ]
        if not markets:
            print(
                f"No resolved 5-minute markets found in the last {args.hours}h.",
                file=sys.stderr,
            )
            return 1
        print(f"found {len(markets)} resolved markets")

        price_paths: dict[str, list[tuple[float, float]]] = {}
        for asset in {m.asset for m in markets}:
            try:
                path = await fetch_klines(
                    klines_client, asset, int((start - 900) * 1000),
                    int(end * 1000), args.interval,
                )
            except ApiError as exc:
                print(f"ERROR: could not fetch klines for {asset}: {exc}",
                      file=sys.stderr)
                return 2
            price_paths[asset] = path
            print(f"  {asset}: {len(path)} price points")

        reconstruction = BookReconstruction(
            spread=args.spread, top_size=args.top_size
        )
        windows: list[HistoricalWindow] = []
        for market in markets:
            path = [
                (ts, price) for ts, price in price_paths.get(market.asset, [])
                if market.window_start - 600 <= ts <= market.window_end + 5
            ]
            if len(path) < 10:
                continue
            mids = await fetch_market_history(
                clob, market.token_id(Outcome.UP),
                market.window_start, market.window_end,
            )
            strike = next((p for ts, p in path if ts >= market.window_start), None)
            settle = None
            for ts, price in path:
                if ts <= market.window_end:
                    settle = price
            windows.append(HistoricalWindow(
                market=market, price_path=path, market_mid=mids,
                strike=strike, settle=settle,
            ))

        with_books = sum(1 for w in windows if w.market_mid)
        print(f"assembled {len(windows)} windows ({with_books} with market prices)")
        if with_books == 0:
            print(
                "WARNING: no Polymarket price history was returned, so the market "
                "side is empty and the session cannot be traded.",
                file=sys.stderr,
            )
            return 1

        session = session_from_history(
            [w for w in windows if w.market_mid], reconstruction,
            reference_venue="binance", label=f"history-{int(start)}",
        )
        save_session(session, args.out)
        print(json.dumps(session.describe(), indent=2, default=str))
        print(f"\nsaved to {args.out}")
        print(f"backtest it with:  bot backtest --session-file {args.out}")
        return 0
    finally:
        await gamma.close()
        await clob.close()
        await klines_client.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
