"""Automatic discovery of 5-minute crypto up/down markets.

No market id, condition id or token id is ever configured by hand.  Discovery
works in three layers, most specific first:

1. **Series probe** -- for each configured asset, try the known recurring-series
   slug patterns (``btc-up-or-down-5m`` and friends) and pull that series'
   events.  Cheap and precise.
2. **Series sweep** -- list every active event and keep those whose ``series``
   entry has a sub-hourly ``recurrence``.  This picks up assets nobody
   configured (new listings) automatically.
3. **Validation** -- whatever the source, every candidate must parse into a
   market whose window really is the configured length, whose outcomes really
   are Up/Down, and whose asset is recognised.

Layer 2 runs on a slower cadence than layer 1 because it is a much heavier
request.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from ..core.clock import Clock, default_clock
from ..core.types import Market
from ..logging_setup import get_logger
from .gamma import GammaClient
from .http import ApiError
from .parsers import detect_asset, detect_window_seconds, parse_market


@dataclass
class DiscoveryStats:
    cycles: int = 0
    events_seen: int = 0
    markets_parsed: int = 0
    markets_rejected: int = 0
    last_error: str = ""
    last_success_at: float = 0.0
    reject_reasons: dict[str, int] = field(default_factory=dict)
    series_found: dict[str, str] = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        self.markets_rejected += 1
        key = reason[:60]
        self.reject_reasons[key] = self.reject_reasons.get(key, 0) + 1


class MarketDiscovery:
    """Finds and refreshes the set of tradable 5-minute crypto markets."""

    def __init__(
        self,
        gamma: GammaClient,
        assets: Iterable[str],
        series_slug_templates: Iterable[str],
        window_seconds: int = 300,
        lookahead_seconds: int = 900,
        max_markets: int = 40,
        sweep_every: int = 15,
        clock: Clock | None = None,
        default_taker_fee: float = 0.07,
    ):
        self.gamma = gamma
        self.assets = [a.upper() for a in assets]
        self.templates = list(series_slug_templates)
        self.window_seconds = window_seconds
        self.lookahead_seconds = lookahead_seconds
        self.max_markets = max_markets
        self.sweep_every = sweep_every
        self.clock = clock or default_clock()
        self.default_taker_fee = default_taker_fee
        self.log = get_logger("pmbot.discovery")

        self.stats = DiscoveryStats()
        #: asset -> resolved series slug (learned once, reused afterwards)
        self.series_by_asset: dict[str, str] = {}
        self._unresolved: set[str] = set(self.assets)
        self._known: dict[str, Market] = {}

    # --------------------------------------------------------------- public
    async def discover(self) -> list[Market]:
        """One discovery cycle.  Returns every currently relevant market."""
        self.stats.cycles += 1
        now = self.clock.time()
        found: dict[str, Market] = {}

        for event in await self._collect_events():
            self.stats.events_seen += 1
            for market in self._markets_from_event(event):
                found[market.market_id] = market

        relevant = [m for m in found.values() if self._is_relevant(m, now)]
        relevant.sort(key=lambda m: (m.window_end, m.asset))
        relevant = relevant[: self.max_markets]

        self._known = {m.market_id: m for m in relevant}
        if relevant:
            self.stats.last_success_at = now
        self.log.info(
            "discovery cycle complete",
            extra={
                "events": self.stats.events_seen,
                "tracked": len(relevant),
                "assets": sorted({m.asset for m in relevant}),
                "series": self.series_by_asset,
            },
        )
        return relevant

    @property
    def known_markets(self) -> dict[str, Market]:
        return dict(self._known)

    # -------------------------------------------------------------- sources
    async def _collect_events(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        for event in await self._series_probe():
            key = str(event.get("id") or event.get("slug") or id(event))
            if key not in seen_ids:
                seen_ids.add(key)
                events.append(event)

        # The sweep is heavy; run it on the first cycle and periodically after,
        # or whenever an asset has no series resolved yet.
        due = (self.stats.cycles == 1) or (self.stats.cycles % self.sweep_every == 0)
        if due or self._unresolved:
            for event in await self._series_sweep():
                key = str(event.get("id") or event.get("slug") or id(event))
                if key not in seen_ids:
                    seen_ids.add(key)
                    events.append(event)
        return events

    async def _series_probe(self) -> list[dict[str, Any]]:
        """Pull events for every series slug we know or can guess."""
        events: list[dict[str, Any]] = []
        for asset in self.assets:
            slugs = [self.series_by_asset[asset]] if asset in self.series_by_asset else [
                template.format(
                    asset_lower=asset.lower(),
                    asset_upper=asset.upper(),
                    asset=asset.lower(),
                )
                for template in self.templates
            ]
            for slug in slugs:
                try:
                    rows = await self.gamma.events_by_series_slug(slug)
                except ApiError as exc:
                    self.stats.last_error = f"{slug}: {exc}"
                    self.log.warning(
                        "series probe failed",
                        extra={"series_slug": slug, "error": str(exc)[:200]},
                    )
                    continue
                if not rows:
                    continue
                self.series_by_asset[asset] = slug
                self._unresolved.discard(asset)
                self.stats.series_found[asset] = slug
                events.extend(rows)
                break
        return events

    async def _series_sweep(self) -> list[dict[str, Any]]:
        """Find short-recurrence crypto series we were not told about."""
        try:
            rows = await self.gamma.active_events(limit=500)
        except ApiError as exc:
            self.stats.last_error = f"sweep: {exc}"
            self.log.warning("event sweep failed", extra={"error": str(exc)[:200]})
            return []

        hits: list[dict[str, Any]] = []
        extra_slugs: set[str] = set()
        for event in rows:
            series = event.get("series")
            entry = series[0] if isinstance(series, list) and series else {}
            if not isinstance(entry, dict):
                continue
            window = detect_window_seconds(
                entry.get("recurrence"), entry.get("slug"), event.get("seriesSlug")
            )
            if window != self.window_seconds:
                continue
            asset = detect_asset(
                event.get("seriesSlug"), entry.get("slug"), event.get("slug"),
                event.get("title"),
            )
            if asset is None:
                continue
            slug = entry.get("slug") or event.get("seriesSlug")
            if asset not in self.series_by_asset and slug:
                self.series_by_asset[asset] = str(slug)
                self.stats.series_found[asset] = str(slug)
                self._unresolved.discard(asset)
                self.log.info(
                    "auto-discovered series",
                    extra={"asset": asset, "series_slug": slug},
                )
            if asset not in self.assets:
                self.assets.append(asset)
            if slug:
                extra_slugs.add(str(slug))
            hits.append(event)

        # The sweep only surfaces a handful of events per series; pull the full
        # schedule for any newly-found series.
        for slug in extra_slugs:
            try:
                hits.extend(await self.gamma.events_by_series_slug(slug))
            except ApiError:
                continue
        return hits

    # ------------------------------------------------------------ filtering
    def _markets_from_event(self, event: dict[str, Any]) -> list[Market]:
        raw_markets = event.get("markets")
        if not isinstance(raw_markets, list):
            raw_markets = [event] if event.get("conditionId") else []

        out: list[Market] = []
        for raw in raw_markets:
            if not isinstance(raw, dict):
                continue
            market, reason = parse_market(
                raw, event, default_taker_fee=self.default_taker_fee
            )
            if market is None:
                self.stats.reject(reason)
                continue
            duration = market.window_end - market.window_start
            if abs(duration - self.window_seconds) > 1.0:
                self.stats.reject(f"window {duration:.0f}s != {self.window_seconds}s")
                continue
            self.stats.markets_parsed += 1
            out.append(market)
        return out

    def _is_relevant(self, market: Market, now: float) -> bool:
        """Keep live markets and those whose window opens soon."""
        if market.closed or not market.active:
            return False
        if not market.enable_order_book or not market.accepting_orders:
            return False
        if market.window_end <= now:
            return False
        return market.window_start <= now + self.lookahead_seconds


def summarise(markets: list[Market], now: float | None = None) -> dict[str, Any]:
    """Compact discovery summary for logs and the dashboard."""
    now = time.time() if now is None else now
    live = [m for m in markets if m.is_in_window(now)]
    return {
        "total": len(markets),
        "live": len(live),
        "upcoming": len(markets) - len(live),
        "assets": sorted({m.asset for m in markets}),
        "next_close": min((m.window_end - now for m in markets), default=0.0),
    }
