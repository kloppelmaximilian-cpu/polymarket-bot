"""Terminal dashboard.

Two front-ends over the same renderers:

* **Textual** (default) -- full TUI with tabs, keyboard sorting and live refresh.
* **Rich** (``--simple``) -- a single auto-refreshing screen that works over a
  plain pipe, a dumb terminal or a CI log, where a full TUI cannot run.

The fallback is not an afterthought: a dashboard that only works in a modern
terminal is a dashboard that is unavailable exactly when something has gone
wrong on a remote box.
"""

from __future__ import annotations

import sys
from pathlib import Path

from rich.console import Console

from .render import (
    SORT_KEYS,
    account_panel,
    alerts_panel,
    feeds_panel,
    header_panel,
    history_panel,
    market_table,
    positions_panel,
    signal_panel,
    strategy_panel,
)
from .state import StateReader


def run_simple(
    state_path: Path,
    refresh_hz: float = 2.0,
    once: bool = False,
    width: int | None = None,
) -> int:
    """Rich-only dashboard: one live screen, no TUI framework required."""
    from rich.layout import Layout
    from rich.live import Live

    # Outside a terminal Rich assumes 80 columns, which clips every table. The
    # tables need ~170 columns, so pin a usable width when piping to a file.
    if width is None and not sys.stdout.isatty():
        width = 180
    console = Console(width=width) if width else Console()
    reader = StateReader(state_path)

    def build() -> Layout:
        state = reader.read()
        layout = Layout()
        layout.split_column(
            Layout(header_panel(state), name="header", size=8),
            Layout(account_panel(state), name="account", size=8),
            Layout(market_table(state), name="markets", ratio=3),
            Layout(name="middle", ratio=3),
            Layout(name="bottom", ratio=2),
        )
        layout["middle"].split_row(
            Layout(signal_panel(state, limit=4), name="signals", ratio=3),
            Layout(positions_panel(state), name="positions", ratio=2),
        )
        layout["bottom"].split_row(
            Layout(history_panel(state, limit=8), name="history", ratio=2),
            Layout(strategy_panel(state), name="strategies", ratio=2),
            Layout(alerts_panel(state), name="alerts", ratio=1),
        )
        return layout

    if once:
        console.print(build())
        return 0

    try:
        with Live(
            build(), console=console, refresh_per_second=max(refresh_hz, 0.5),
            screen=True,
        ) as live:
            import time

            while True:
                time.sleep(1.0 / max(refresh_hz, 0.5))
                live.update(build())
    except KeyboardInterrupt:
        return 0
    return 0


def build_textual_app(state_path: Path, refresh_hz: float = 2.0):
    """Construct the Textual application (imported lazily)."""
    from textual.app import App, ComposeResult
    from textual.containers import Horizontal, Vertical
    from textual.widgets import Footer, Static, TabbedContent, TabPane

    class PanelView(Static):
        """A Static whose content is produced by a render function."""

        def __init__(self, renderer, **kwargs):
            super().__init__("", **kwargs)
            self._renderer = renderer

        def refresh_panel(self, state) -> None:
            try:
                self.update(self._renderer(state))
            except Exception as exc:  # noqa: BLE001 - a panel must not kill the app
                self.update(f"[red]panel error: {type(exc).__name__}: {exc}[/red]")

    class DashboardApp(App):
        CSS = """
        Screen { layout: vertical; }
        #header { height: 9; }
        #account { height: 9; }
        .grow { height: 1fr; }
        """
        BINDINGS = [
            ("q", "quit", "Quit"),
            ("r", "refresh", "Refresh"),
            ("e", "sort('edge')", "Sort: edge"),
            ("c", "sort('confidence')", "Sort: confidence"),
            ("a", "sort('asset')", "Sort: asset"),
            ("t", "sort('time')", "Sort: time left"),
            ("l", "sort('liquidity')", "Sort: liquidity"),
            ("s", "sort('signal')", "Sort: signal"),
            ("p", "toggle_pause_view", "Freeze"),
        ]

        def __init__(self) -> None:
            super().__init__()
            self.reader = StateReader(state_path)
            self.sort_key = "edge"
            self.frozen = False
            self._panels: list[PanelView] = []

        def compose(self) -> ComposeResult:
            self.header_view = PanelView(header_panel, id="header")
            self.account_view = PanelView(account_panel, id="account")
            self.market_view = PanelView(
                lambda s: market_table(s, self.sort_key), classes="grow"
            )
            self.signal_view = PanelView(lambda s: signal_panel(s, 5), classes="grow")
            self.position_view = PanelView(positions_panel, classes="grow")
            self.history_view = PanelView(
                lambda s: history_panel(s, 14), classes="grow"
            )
            self.strategy_view = PanelView(strategy_panel, classes="grow")
            self.feeds_view = PanelView(feeds_panel, classes="grow")
            self.alerts_view = PanelView(alerts_panel, classes="grow")

            yield self.header_view
            yield self.account_view
            with TabbedContent(initial="tab-markets"):
                with TabPane("Markets", id="tab-markets"):
                    yield self.market_view
                with TabPane("Signals", id="tab-signals"), Horizontal():
                    yield self.signal_view
                    yield self.position_view
                with TabPane("Trades", id="tab-trades"), Vertical():
                    yield self.history_view
                    yield self.strategy_view
                with TabPane("Health", id="tab-health"), Vertical():
                    yield self.feeds_view
                    yield self.alerts_view
            yield Footer()

            self._panels = [
                self.header_view, self.account_view, self.market_view,
                self.signal_view, self.position_view, self.history_view,
                self.strategy_view, self.feeds_view, self.alerts_view,
            ]

        def on_mount(self) -> None:
            self.set_interval(1.0 / max(refresh_hz, 0.5), self.tick)
            self.tick()

        def tick(self) -> None:
            if self.frozen:
                return
            state = self.reader.read()
            for panel in self._panels:
                panel.refresh_panel(state)

        def action_refresh(self) -> None:
            self.tick()

        def action_sort(self, key: str) -> None:
            if key in SORT_KEYS:
                self.sort_key = key
                self.tick()

        def action_toggle_pause_view(self) -> None:
            self.frozen = not self.frozen
            self.notify(
                "display frozen" if self.frozen else "display live",
                severity="warning" if self.frozen else "information",
            )

    return DashboardApp()


def main(argv: list[str] | None = None) -> int:
    import argparse

    from ..config import get_settings

    parser = argparse.ArgumentParser(
        prog="python -m pmbot.dashboard",
        description="Live terminal dashboard for the Polymarket 5-minute crypto bot",
    )
    parser.add_argument("--state", type=Path, default=None,
                        help="path to the bot's state.json (default: data/state.json)")
    parser.add_argument("--simple", action="store_true",
                        help="use the Rich fallback instead of the Textual TUI")
    parser.add_argument("--once", action="store_true",
                        help="render a single frame and exit (useful in CI)")
    parser.add_argument("--refresh", type=float, default=None, help="refresh Hz")
    parser.add_argument("--width", type=int, default=None,
                        help="force a console width (useful when piping output)")
    args = parser.parse_args(argv)

    settings = get_settings()
    state_path = args.state or (Path(settings.log_dir).parent / "data" / "state.json")
    refresh = args.refresh or settings.dashboard_refresh_hz

    if args.once or args.simple or not sys.stdout.isatty():
        return run_simple(state_path, refresh, once=args.once, width=args.width)

    try:
        app = build_textual_app(state_path, refresh)
    except Exception as exc:  # noqa: BLE001
        Console().print(
            f"[yellow]Textual unavailable ({type(exc).__name__}: {exc}); "
            f"falling back to the simple dashboard.[/yellow]"
        )
        return run_simple(state_path, refresh, width=args.width)
    app.run()
    return 0
