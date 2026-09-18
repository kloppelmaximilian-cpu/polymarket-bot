"""Rich renderables shared by both dashboard front-ends.

Everything is a pure function of :class:`DashboardState`, so the same panels are
used by the Textual app and by the plain Rich fallback, and both can be
snapshot-tested without a terminal.
"""

from __future__ import annotations

import time
from typing import Any

from rich.align import Align
from rich.box import SIMPLE_HEAD
from rich.console import Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .state import DashboardState

SORT_KEYS = ("edge", "confidence", "asset", "time", "liquidity", "signal")


def _money(value: Any, digits: int = 2, signed: bool = False) -> Text:
    if value is None:
        return Text("--", style="dim")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return Text("--", style="dim")
    text = f"{number:+.{digits}f}" if signed else f"{number:.{digits}f}"
    style = "green" if number > 0 else ("red" if number < 0 else "white")
    return Text(text, style=style if signed else "white")


def _pct(value: Any, digits: int = 1, signed: bool = False) -> Text:
    if value is None:
        return Text("--", style="dim")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return Text("--", style="dim")
    text = f"{number:+.{digits}%}" if signed else f"{number:.{digits}%}"
    style = "green" if number > 0 else ("red" if number < 0 else "white")
    return Text(text, style=style if signed else "white")


def _num(value: Any, digits: int = 4) -> str:
    if value is None:
        return "--"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "--"


def _unknown_or(value: Any, digits: int = 0) -> str:
    """A dash for unmeasurable, never a confident zero.

    Venues that omit timestamps make latency and clock drift unknowable, and
    "0 ms" in a health panel reads as a perfect link rather than as silence.
    """
    if value is None:
        return "-"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "-"


def _clock(seconds: Any) -> Text:
    if seconds is None:
        return Text("--", style="dim")
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return Text("--", style="dim")
    if value <= 0:
        return Text("closed", style="dim")
    style = "red" if value < 30 else ("yellow" if value < 60 else "white")
    return Text(f"{int(value // 60)}:{int(value % 60):02d}", style=style)


def _uptime(seconds: Any) -> str:
    try:
        total = int(float(seconds or 0))
    except (TypeError, ValueError):
        return "--"
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}h{minutes:02d}m{secs:02d}s"


DECISION_STYLES = {
    "HIGH_CONFIDENCE_TRADE": "bold green",
    "TRADE": "green",
    "WATCH": "yellow",
    "WEAK_SIGNAL": "dim yellow",
    "NO_TRADE": "dim",
}
STATUS_STYLES = {"ONLINE": "green", "DEGRADED": "yellow", "OFFLINE": "red"}
HEALTH_STYLES = {"OK": "green", "DEGRADED": "yellow", "CRITICAL": "bold red"}


def header_panel(state: DashboardState) -> Panel:
    if not state.connected:
        return Panel(
            Align.center(Text(state.error or "not connected", style="bold red")),
            title="POLYMARKET 5-MIN CRYPTO BOT", border_style="red",
        )

    mode = state.mode
    mode_style = "bold red" if state.is_live else "bold cyan"
    if state.is_live and state.get("dry_run"):
        mode = "LIVE (DRY RUN)"
        mode_style = "bold yellow"
    health = state.health
    level = str(health.get("level", "OK"))
    risk = state.risk

    left = Table.grid(padding=(0, 2))
    left.add_column(style="dim", justify="right")
    left.add_column()
    left.add_row("mode", Text(mode, style=mode_style))
    left.add_row(
        "status",
        Text("PAUSED", style="bold red") if risk.get("trading_paused")
        else Text("RUNNING", style="bold green"),
    )
    left.add_row("uptime", Text(_uptime(state.get("uptime"))))
    left.add_row(
        "health",
        Text(
            f"{level} ({float(health.get('score', 1.0)):.2f})",
            style=HEALTH_STYLES.get(level, "white"),
        ),
    )

    loop = state.get("loop", {}) or {}
    discovery = state.get("discovery", {}) or {}
    right = Table.grid(padding=(0, 2))
    right.add_column(style="dim", justify="right")
    right.add_column()
    right.add_row("markets tracked", Text(str(discovery.get("tracked", 0))))
    right.add_row(
        "loop",
        Text(f"{loop.get('cycles', 0)} cycles, {loop.get('avg_cycle_ms', 0):.0f}ms avg"),
    )
    right.add_row(
        "orders",
        Text(f"{loop.get('trades_attempted', 0)} attempted / "
             f"{loop.get('trades_filled', 0)} filled"),
    )
    right.add_row(
        "snapshot age",
        Text(f"{state.age:.1f}s", style="red" if state.stale else "dim"),
    )

    grid = Table.grid(expand=True)
    grid.add_column(ratio=1)
    grid.add_column(ratio=1)
    grid.add_row(left, right)
    return Panel(
        grid, title="POLYMARKET 5-MIN CRYPTO BOT",
        border_style="red" if state.is_live else "cyan",
    )


def account_panel(state: DashboardState) -> Panel:
    risk = state.risk
    stats = state.stats
    table = Table.grid(padding=(0, 2), expand=True)
    for _ in range(4):
        table.add_column(style="dim", justify="right")
        table.add_column(justify="left")

    rows = [
        ("balance", _money(risk.get("bankroll"))),
        ("equity", _money(risk.get("equity"))),
        ("available", _money(risk.get("available"))),
        ("open exposure", _money(risk.get("open_exposure"))),
        ("realized P&L", _money(risk.get("realized_pnl"), signed=True)),
        ("unrealized", _money(risk.get("unrealized_pnl"), signed=True)),
        ("today", _money(risk.get("daily_pnl"), signed=True)),
        ("session", _money(risk.get("session_pnl"), signed=True)),
        ("trades", Text(str(stats.get("trades", 0)))),
        ("win rate", _pct(stats.get("win_rate"))),
        ("trades/hr", Text(f"{float(stats.get('trades_per_hour', 0) or 0):.1f}")),
        ("expectancy", _money(stats.get("expectancy"), 4, signed=True)),
        ("max drawdown", _pct(risk.get("drawdown"))),
        ("open positions", Text(str(risk.get("open_positions", 0)))),
        ("consec. losses", Text(str(risk.get("consecutive_losses", 0)))),
        ("fees paid", _money(stats.get("fees_paid"))),
    ]
    for i in range(0, len(rows), 4):
        chunk = rows[i:i + 4]
        cells: list[Any] = []
        for label, value in chunk:
            cells.extend([label, value])
        while len(cells) < 8:
            cells.extend(["", ""])
        table.add_row(*cells)
    return Panel(table, title="ACCOUNT / RISK", border_style="blue")


def market_table(state: DashboardState, sort_key: str = "edge") -> Panel:
    table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("asset", "left"), ("left", "right"), ("YES", "right"), ("NO", "right"),
        ("bid", "right"), ("ask", "right"), ("spr", "right"), ("liq$", "right"),
        ("spot", "right"), ("strike", "right"), ("dist bp", "right"),
        ("model", "right"), ("market", "right"), ("edge", "right"),
        ("req", "right"), ("conf", "right"), ("regime", "left"),
        ("decision", "left"),
    ):
        table.add_column(name, justify=justify, no_wrap=True)

    markets = list(state.markets)
    reverse = True
    if sort_key == "asset":
        markets.sort(key=lambda m: str(m.get("asset") or ""))
        reverse = False
    elif sort_key == "time":
        markets.sort(key=lambda m: float(m.get("seconds_remaining") or 1e9))
        reverse = False
    elif sort_key == "liquidity":
        markets.sort(key=lambda m: float(m.get("liquidity") or 0.0), reverse=reverse)
    elif sort_key == "confidence":
        markets.sort(key=lambda m: float(m.get("confidence") or 0.0), reverse=reverse)
    elif sort_key == "signal":
        markets.sort(
            key=lambda m: abs(float(m.get("model_up") or 0.5) - 0.5), reverse=reverse
        )
    else:
        markets.sort(key=lambda m: float(m.get("edge") or -1.0), reverse=reverse)

    for market in markets[:24]:
        decision = str(market.get("decision") or "-")
        table.add_row(
            Text(str(market.get("asset", "?")),
                 style="bold" if market.get("in_window") else "dim"),
            _clock(market.get("seconds_remaining")),
            _num(market.get("up_ask"), 3),
            _num(market.get("down_ask"), 3),
            _num(market.get("up_bid"), 3),
            _num(market.get("up_ask"), 3),
            _num(market.get("spread"), 3),
            f"{float(market.get('liquidity') or 0):.0f}",
            _num(market.get("spot"), 2),
            _num(market.get("strike"), 2),
            _money(market.get("distance_bps"), 1, signed=True),
            _num(market.get("model_up"), 3),
            _num(market.get("market_up"), 3),
            _money(market.get("edge"), 4, signed=True),
            _num(market.get("required_edge"), 4),
            _num(market.get("confidence"), 2),
            Text(str(market.get("regime") or "-")[:12], style="dim"),
            Text(decision[:18], style=DECISION_STYLES.get(decision, "dim")),
        )
    if not markets:
        table.add_row(*["--"] * 18)
    return Panel(
        table,
        title=f"MARKET MONITOR  ({len(state.markets)} tracked, sorted by {sort_key})",
        border_style="blue",
    )


def signal_panel(state: DashboardState, limit: int = 5) -> Panel:
    blocks = []
    for signal in state.signals[:limit]:
        decision = str(signal.get("decision", "-"))
        style = DECISION_STYLES.get(decision, "dim")
        head = Text()
        head.append(f"{signal.get('asset', '?'):<5}", style="bold")
        head.append(f"{signal.get('outcome', '?'):<5}")
        head.append(f"model {float(signal.get('model_probability') or 0):.1%}  ")
        head.append(f"market {float(signal.get('market_probability') or 0):.1%}  ")
        edge = float(signal.get("net_edge") or 0.0)
        head.append(
            f"edge {edge:+.2%}",
            style="green" if edge > 0 else "red",
        )
        head.append(f"  conf {float(signal.get('confidence') or 0):.0%}  ")
        head.append(_clock(signal.get("seconds_remaining")))
        head.append("  ")
        head.append(decision, style=style)

        detail = Text()
        gross = float(signal.get("gross_edge") or 0.0)
        fee = float(signal.get("fee_cost") or 0.0)
        slip = float(signal.get("slippage_cost") or 0.0)
        detail.append(
            f"   gross {gross:+.4f} - fee {fee:.4f} - slip {slip:.4f} = "
            f"net {edge:+.4f}   size {float(signal.get('size_shares') or 0):.1f} sh "
            f"(${float(signal.get('notional') or 0):.2f})\n",
            style="dim",
        )
        drivers = signal.get("drivers") or []
        if drivers:
            detail.append("   drivers: ", style="dim")
            for driver in drivers:
                probability = float(driver.get("probability") or 0.5)
                detail.append(
                    f"{driver.get('strategy')}={probability:.2f}"
                    f"@{float(driver.get('confidence') or 0):.2f}  ",
                    style="green" if probability > 0.5 else "red",
                )
            detail.append("\n")
        blockers = signal.get("blockers") or []
        if blockers:
            detail.append(f"   blocked: {'; '.join(str(b) for b in blockers[:3])}\n",
                          style="yellow")
        blocks.extend([head, detail])

    if not blocks:
        blocks = [Text("no signals yet", style="dim")]
    return Panel(Group(*blocks), title="LIVE SIGNALS", border_style="magenta")


def positions_panel(state: DashboardState) -> Panel:
    table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("asset", "left"), ("side", "left"), ("size", "right"), ("entry", "right"),
        ("now", "right"), ("exposure", "right"), ("left", "right"), ("EV", "right"),
        ("P&L", "right"), ("conf", "right"), ("strategy", "left"),
    ):
        table.add_column(name, justify=justify, no_wrap=True)
    for position in state.positions:
        table.add_row(
            Text(str(position.get("asset", "?")), style="bold"),
            str(position.get("outcome", "?")),
            f"{float(position.get('size') or 0):.1f}",
            _num(position.get("avg_price"), 3),
            _num(position.get("current"), 3),
            _money(position.get("exposure")),
            _clock(position.get("seconds_remaining")),
            _money(position.get("expected_value"), 2, signed=True),
            _money(position.get("unrealized"), 2, signed=True),
            _num(position.get("entry_confidence"), 2),
            Text(str(position.get("strategy", "-"))[:14], style="dim"),
        )
    if not state.positions:
        table.add_row(*["--"] * 11)
    return Panel(table, title=f"OPEN TRADES ({len(state.positions)})", border_style="green")


def history_panel(state: DashboardState, limit: int = 10) -> Panel:
    table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("time", "left"), ("asset", "left"), ("side", "left"), ("entry", "right"),
        ("exit", "right"), ("result", "left"), ("P&L", "right"),
        ("edge", "right"), ("conf", "right"), ("strategy", "left"),
    ):
        table.add_column(name, justify=justify, no_wrap=True)
    for trade in state.trades[:limit]:
        pnl = trade.get("pnl")
        won = (pnl or 0) > 0
        closed_at = trade.get("closed_at")
        stamp = (
            time.strftime("%H:%M:%S", time.localtime(float(closed_at)))
            if closed_at else "--"
        )
        table.add_row(
            stamp,
            Text(str(trade.get("asset", "?")), style="bold"),
            str(trade.get("outcome", "?")),
            _num(trade.get("entry"), 3),
            _num(trade.get("exit"), 3),
            Text("WIN" if won else "LOSS", style="green" if won else "red"),
            _money(pnl, 2, signed=True),
            _money(trade.get("edge"), 4, signed=True),
            _num(trade.get("confidence"), 2),
            Text(str(trade.get("strategy", "-"))[:14], style="dim"),
        )
    if not state.trades:
        table.add_row(*["--"] * 10)
    return Panel(table, title="TRADE HISTORY", border_style="green")


def strategy_panel(state: DashboardState) -> Panel:
    table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("strategy", "left"), ("signals", "right"), ("skill", "right"),
        ("brier", "right"), ("trades", "right"), ("win%", "right"),
        ("P&L", "right"), ("expect", "right"), ("avg edge", "right"),
        ("maxDD", "right"),
    ):
        table.add_column(name, justify=justify, no_wrap=True)
    for row in state.strategy_rows:
        skill = float(row.get("skill") or 0.0)
        table.add_row(
            Text(str(row["strategy"])[:18], style="bold"),
            str(row.get("signals", 0)),
            Text(f"{skill:+.3f}", style="green" if skill > 0 else "red"),
            _num(row.get("brier"), 4),
            str(row.get("trades", 0)),
            _pct(row.get("win_rate")),
            _money(row.get("pnl"), 2, signed=True),
            _money(row.get("expectancy"), 4, signed=True),
            _money(row.get("avg_edge"), 4, signed=True),
            _money(row.get("max_dd")),
        )
    if not state.strategy_rows:
        table.add_row(*["--"] * 10)
    return Panel(table, title="STRATEGY PERFORMANCE", border_style="yellow")


def feeds_panel(state: DashboardState) -> Panel:
    table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("feed", "left"), ("status", "left"), ("lat ms", "right"), ("msg/s", "right"),
        ("recon", "right"), ("err", "right"), ("drift ms", "right"),
        ("score", "right"), ("detail", "left"),
    ):
        table.add_column(name, justify=justify, no_wrap=True)
    for feed in state.feeds:
        status = str(feed.get("status", "OFFLINE"))
        table.add_row(
            Text(str(feed.get("name", "?")), style="bold"),
            Text(status, style=STATUS_STYLES.get(status, "white")),
            _unknown_or(feed.get("latency_ms"), 0),
            f"{float(feed.get('messages_per_sec') or 0):.1f}",
            str(feed.get("reconnects", 0)),
            str(feed.get("errors", 0)),
            _unknown_or(feed.get("clock_drift_ms"), 0),
            f"{float(feed.get('score') or 0):.2f}",
            Text(str(feed.get("detail", ""))[:26], style="dim"),
        )

    composites = state.get("composites", {}) or {}
    comp_table = Table(box=SIMPLE_HEAD, expand=True, pad_edge=False)
    for name, justify in (
        ("asset", "left"), ("composite", "right"), ("src", "right"),
        ("disp bp", "right"), ("5m vol bp", "right"), ("ok", "left"),
    ):
        comp_table.add_column(name, justify=justify, no_wrap=True)
    for asset, row in sorted(composites.items()):
        healthy = bool(row.get("healthy"))
        comp_table.add_row(
            Text(asset, style="bold"),
            _num(row.get("price"), 2),
            str(row.get("sources", 0)),
            _num(row.get("dispersion_bps"), 1),
            _num(row.get("sigma_window_bps"), 1),
            Text("yes" if healthy else "no", style="green" if healthy else "red"),
        )
    if not composites:
        comp_table.add_row(*["--"] * 6)

    resolution = state.get("resolution", {}) or {}
    footer = Text()
    if resolution.get("compared"):
        footer.append(
            f"proxy vs venue resolution agreement: "
            f"{resolution.get('agreement_rate', 0):.1%} "
            f"over {resolution.get('compared')} markets\n",
            style="dim",
        )
    execution = state.get("execution", {}) or {}
    footer.append(
        f"execution: {execution.get('filled', 0)} filled / "
        f"{execution.get('submitted', 0)} submitted, "
        f"{execution.get('maker_fills', 0)} maker / {execution.get('taker_fills', 0)} taker, "
        f"avg slip {execution.get('avg_slippage', 0)}, "
        f"dupes blocked {execution.get('duplicates_blocked', 0)}",
        style="dim",
    )
    return Panel(
        Group(table, comp_table, footer), title="FEED HEALTH", border_style="cyan"
    )


def alerts_panel(state: DashboardState) -> Panel:
    lines: list[Text] = []
    for warning in state.warnings():
        lines.append(Text(f"! {warning}", style="bold yellow"))
    for alert in state.alerts[:6]:
        level = str(alert.get("level", "info"))
        style = {"critical": "bold red", "warning": "yellow"}.get(level, "dim")
        stamp = time.strftime("%H:%M:%S", time.localtime(float(alert.get("ts", 0) or 0)))
        lines.append(Text(
            f"{stamp} [{level}] {alert.get('component')}: {alert.get('message')}",
            style=style,
        ))
    if not lines:
        lines = [Text("no alerts", style="green")]
    return Panel(Group(*lines), title="ALERTS", border_style="red")
