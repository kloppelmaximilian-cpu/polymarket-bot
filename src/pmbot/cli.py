"""Command-line interface.

``bot <command>``.  Read-only commands work against the published state
snapshot and the database, so they are safe to run while the bot is trading.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from .config import TradingMode, get_settings

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Polymarket 5-minute crypto trading bot",
)
console = Console()


def _state_path() -> Path:
    settings = get_settings()
    return Path(settings.log_dir).parent / "data" / "state.json"


def _read_state():
    from .dashboard.state import StateReader

    state = StateReader(_state_path()).read()
    if not state.connected:
        console.print(f"[red]{state.error}[/red]")
        raise typer.Exit(1)
    if state.stale:
        console.print(
            f"[yellow]warning: snapshot is {state.age:.0f}s old; "
            f"the bot may not be running[/yellow]"
        )
    return state


# ------------------------------------------------------------------ lifecycle


@app.command()
def start(
    mode: str = typer.Option(None, help="paper | live (overrides TRADING_MODE)"),
    log_level: str = typer.Option(None, help="DEBUG | INFO | WARNING | ERROR"),
) -> None:
    """Start the bot.  Paper mode unless explicitly configured otherwise."""
    from .logging_setup import setup_logging
    from .runner import BotRunner

    overrides: dict = {}
    if mode:
        overrides["trading_mode"] = mode.lower()
    if log_level:
        overrides["log_level"] = log_level.upper()
    settings = get_settings(reload=True, **overrides) if overrides else get_settings()
    setup_logging(settings.log_level, settings.log_dir, settings.log_json)

    if settings.trading_mode is TradingMode.LIVE:
        if not settings.live_confirmation:
            console.print(
                "[red]LIVE mode requires LIVE_CONFIRMATION=true in the "
                "environment. Refusing to start.[/red]"
            )
            raise typer.Exit(2)
        console.print(
            "[bold red]LIVE TRADING ARMED - real orders will be placed.[/bold red]"
        )
        if settings.dry_run_live:
            console.print("[yellow]DRY_RUN_LIVE=true: orders will be built, not sent.[/yellow]")
    else:
        console.print("[cyan]Starting in PAPER mode. No real orders will be placed.[/cyan]")

    runner = BotRunner(settings)

    async def main() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            # Not every platform or event loop supports signal handlers.
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, runner.request_stop)
        await runner.run()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]interrupted[/yellow]")


@app.command()
def stop() -> None:
    """How to stop a running bot."""
    console.print(
        "The bot stops on SIGINT/SIGTERM and shuts down cleanly "
        "(cancelling open orders).\n"
        "  - foreground: press Ctrl-C\n"
        "  - background: kill -TERM <pid>   (see ./start_bot.sh which writes data/bot.pid)"
    )


@app.command()
def dashboard(
    simple: bool = typer.Option(False, help="use the Rich fallback instead of Textual"),
    once: bool = typer.Option(False, help="render one frame and exit"),
    width: int | None = typer.Option(None, help="force console width"),
) -> None:
    """Launch the live terminal dashboard."""
    from .dashboard.app import main as dashboard_main

    argv: list[str] = []
    if simple:
        argv.append("--simple")
    if once:
        argv.append("--once")
    if width:
        argv.extend(["--width", str(width)])
    raise typer.Exit(dashboard_main(argv))


# ---------------------------------------------------------------- read-only


@app.command()
def status() -> None:
    """One-screen summary of the running bot."""
    state = _read_state()
    risk, stats, health = state.risk, state.stats, state.health
    table = Table.grid(padding=(0, 2))
    table.add_column(style="dim", justify="right")
    table.add_column()
    table.add_row("mode", f"[{'red' if state.is_live else 'cyan'}]{state.mode}[/]")
    table.add_row("paused", "yes" if risk.get("trading_paused") else "no")
    if risk.get("trading_paused"):
        table.add_row("pause reason", str(risk.get("pause_reason")))
    table.add_row("uptime", f"{float(state.get('uptime') or 0) / 3600:.2f}h")
    table.add_row("health", f"{health.get('level')} ({float(health.get('score', 1)):.2f})")
    table.add_row("markets tracked", str((state.get("discovery") or {}).get("tracked", 0)))
    table.add_row("equity", f"{float(risk.get('equity') or 0):.2f}")
    table.add_row("realized P&L", f"{float(risk.get('realized_pnl') or 0):+.2f}")
    table.add_row("unrealized", f"{float(risk.get('unrealized_pnl') or 0):+.2f}")
    table.add_row("open positions", str(risk.get("open_positions", 0)))
    table.add_row("trades", str(stats.get("trades", 0)))
    table.add_row("win rate", f"{float(stats.get('win_rate') or 0):.1%}")
    table.add_row("trades/hour", f"{float(stats.get('trades_per_hour') or 0):.2f}")
    table.add_row("drawdown", f"{float(risk.get('drawdown') or 0):.2%}")
    console.print(table)
    for warning in state.warnings():
        console.print(f"[yellow]! {warning}[/yellow]")


@app.command()
def markets(
    sort: str = typer.Option("edge", help="edge | confidence | asset | time | liquidity"),
) -> None:
    """Currently monitored 5-minute markets."""
    from .dashboard.render import market_table

    console.print(market_table(_read_state(), sort))


@app.command()
def signals() -> None:
    """Best current signals, with the reasoning behind each."""
    from .dashboard.render import signal_panel

    console.print(signal_panel(_read_state(), limit=8))


@app.command()
def positions() -> None:
    """Open positions."""
    from .dashboard.render import positions_panel

    console.print(positions_panel(_read_state()))


@app.command()
def trades(limit: int = typer.Option(20, help="how many to show")) -> None:
    """Recent closed trades."""
    from .dashboard.render import history_panel

    console.print(history_panel(_read_state(), limit))


@app.command()
def pnl() -> None:
    """Account and P&L detail."""
    from .dashboard.render import account_panel

    console.print(account_panel(_read_state()))


@app.command()
def risk() -> None:
    """Risk state, limits and recent risk events."""
    state = _read_state()
    settings = get_settings()
    row = state.risk
    table = Table("limit", "configured", "current", title="RISK")
    table.add_row("max stake per trade", f"{settings.max_stake_per_trade:.2f}", "-")
    table.add_row("max stake fraction", f"{settings.max_stake_fraction:.2%}", "-")
    table.add_row(
        "max portfolio exposure", f"{settings.max_portfolio_exposure:.2f}",
        f"{float(row.get('open_exposure') or 0):.2f}",
    )
    table.add_row(
        "max simultaneous positions", str(settings.max_simultaneous_positions),
        str(row.get("open_positions", 0)),
    )
    table.add_row(
        "max daily loss", f"{settings.max_daily_loss:.2f}",
        f"{float(row.get('daily_pnl') or 0):+.2f}",
    )
    table.add_row(
        "max session loss", f"{settings.max_session_loss:.2f}",
        f"{float(row.get('session_pnl') or 0):+.2f}",
    )
    table.add_row(
        "max consecutive losses", str(settings.max_consecutive_losses),
        str(row.get("consecutive_losses", 0)),
    )
    table.add_row(
        "max drawdown", f"{settings.max_drawdown:.2%}",
        f"{float(row.get('drawdown') or 0):.2%}",
    )
    console.print(table)
    console.print(
        f"paused: [{'red' if row.get('trading_paused') else 'green'}]"
        f"{bool(row.get('trading_paused'))}[/] {row.get('pause_reason', '')}"
    )


@app.command()
def strategies() -> None:
    """Per-strategy signal skill and realised P&L."""
    from .dashboard.render import strategy_panel

    console.print(strategy_panel(_read_state()))


@app.command()
def feeds() -> None:
    """Data-feed health."""
    from .dashboard.render import feeds_panel

    console.print(feeds_panel(_read_state()))


@app.command()
def config() -> None:
    """Print the effective configuration (secrets redacted)."""
    console.print_json(json.dumps(get_settings().redacted_dict(), default=str))


@app.command()
def audit(market_id: str = typer.Argument(..., help="market id to explain")) -> None:
    """Replay every recorded decision for one market: why did we trade it?"""
    from .database.repo import Repository
    from .database.store import Database

    settings = get_settings()
    db = Database(settings.database_url)
    db.backend.connect()
    rows = Repository(db).audit_for_market(market_id)
    if not rows:
        console.print(f"[yellow]no audit records for {market_id}[/yellow]")
        raise typer.Exit(1)
    for row in rows:
        console.print(f"[bold]{row['kind']}[/bold]  ts={row['ts']}")
        try:
            console.print_json(row["payload"])
        except (TypeError, ValueError):
            console.print(row["payload"])


# ---------------------------------------------------------------- research


@app.command()
def discover(
    limit: int = typer.Option(20, help="how many markets to print"),
) -> None:
    """One-shot live market discovery.  Verifies API reachability."""
    from .polymarket.discovery import MarketDiscovery, summarise
    from .polymarket.gamma import GammaClient

    settings = get_settings()

    async def main() -> int:
        gamma = GammaClient(settings.gamma_base_url)
        discovery = MarketDiscovery(
            gamma=gamma, assets=settings.assets,
            series_slug_templates=settings.series_slug_templates,
            window_seconds=settings.market_window_seconds,
            lookahead_seconds=settings.discovery_lookahead_seconds,
            max_markets=max(limit, settings.max_tracked_markets),
        )
        try:
            found = await discovery.discover()
        except Exception as exc:  # noqa: BLE001
            console.print(f"[red]discovery failed: {type(exc).__name__}: {exc}[/red]")
            console.print(
                "[yellow]If this is a network/egress error, the Polymarket API is "
                "unreachable from this host.[/yellow]"
            )
            return 1
        finally:
            await gamma.close()

        if not found:
            reason = discovery.stats.last_error or "no matching markets returned"
            console.print("[yellow]No 5-minute crypto markets found.[/yellow]")
            console.print(f"reason: {reason}")
            if "unreachable" in reason.lower() or "connect" in reason.lower():
                console.print(
                    "[yellow]The Polymarket API is not reachable from this host. "
                    "Check egress to gamma-api.polymarket.com, then run "
                    "`bot doctor`.[/yellow]"
                )
            elif discovery.stats.reject_reasons:
                console.print(f"rejected: {discovery.stats.reject_reasons}")
            else:
                console.print(
                    "The API answered but returned nothing for these series "
                    "slugs. If Polymarket has renamed the series, set "
                    "SERIES_SLUG_TEMPLATES (see docs/CONFIG.md)."
                )
            return 1

        console.print(f"series resolved: {discovery.series_by_asset}")
        console.print(f"summary: {summarise(found)}")
        table = Table("asset", "slug", "window (UTC)", "left", "tick", "min", "fee")
        import datetime as dt

        for market in found[:limit]:
            table.add_row(
                market.asset, market.slug,
                dt.datetime.utcfromtimestamp(market.window_start).strftime("%H:%M:%S"),
                f"{market.seconds_remaining():.0f}s",
                f"{market.tick_size}", f"{market.min_order_size:g}",
                f"{market.taker_fee_rate:g}",
            )
        console.print(table)
        if discovery.stats.reject_reasons:
            console.print(f"rejected: {discovery.stats.reject_reasons}")
        return 0

    raise typer.Exit(asyncio.run(main()))


@app.command()
def doctor() -> None:
    """Check the environment: config, dependencies and API reachability."""
    settings = get_settings()
    table = Table("check", "result", "detail")

    table.add_row(
        "trading mode",
        "[cyan]PAPER[/cyan]" if not settings.is_live else "[red]LIVE[/red]",
        f"live_confirmation={settings.live_confirmation}",
    )
    table.add_row(
        "live credentials",
        "present" if settings.has_live_credentials() else "absent",
        "required only for live trading",
    )
    for module in ("numpy", "pandas", "sklearn", "lightgbm", "xgboost",
                   "websockets", "httpx", "textual", "rich", "typer"):
        try:
            __import__(module)
            table.add_row(f"import {module}", "[green]ok[/green]", "")
        except ImportError as exc:
            table.add_row(f"import {module}", "[red]missing[/red]", str(exc)[:60])
    try:
        import py_clob_client  # noqa: F401

        table.add_row("import py_clob_client", "[green]ok[/green]", "live order signing")
    except ImportError:
        table.add_row(
            "import py_clob_client", "[yellow]missing[/yellow]",
            "needed only for LIVE mode",
        )

    sqlite_path = settings.sqlite_path
    if sqlite_path is not None:
        try:
            sqlite_path.parent.mkdir(parents=True, exist_ok=True)
            table.add_row("database path", "[green]writable[/green]", str(sqlite_path))
        except OSError as exc:
            table.add_row("database path", "[red]not writable[/red]", str(exc)[:60])

    model_dir = settings.model_dir / settings.model_name
    table.add_row(
        "model artifact",
        "[green]found[/green]" if (model_dir / "manifest.json").exists()
        else "[yellow]none[/yellow]",
        str(model_dir),
    )

    async def probe() -> None:
        import httpx

        for name, url in (
            ("gamma API", f"{settings.gamma_base_url}/events?limit=1"),
            ("CLOB API", f"{settings.clob_base_url}/time"),
        ):
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    response = await client.get(url)
                table.add_row(
                    name,
                    "[green]reachable[/green]" if response.status_code == 200
                    else f"[yellow]HTTP {response.status_code}[/yellow]",
                    url[:56],
                )
            except Exception as exc:  # noqa: BLE001
                table.add_row(
                    name, "[red]unreachable[/red]",
                    f"{type(exc).__name__}: {str(exc)[:44]}",
                )

    asyncio.run(probe())
    console.print(table)


@app.command()
def backtest(
    session_file: Path | None = typer.Option(
        None, help="replay session JSON; omit to generate a synthetic one"
    ),
    windows: int = typer.Option(24, help="synthetic windows per asset"),
    efficiency: float = typer.Option(
        0.5, help="synthetic market efficiency (1.0 = perfectly priced)"
    ),
    seed: int = typer.Option(42),
    interval: float = typer.Option(1.0, help="decision interval in seconds"),
    out: Path | None = typer.Option(None, help="directory for the result JSON"),
    robustness: bool = typer.Option(True, help="also run Monte Carlo robustness"),
) -> None:
    """Run a backtest (synthetic by default) and print the full report."""
    from .backtesting.engine import BacktestConfig, BacktestEngine
    from .backtesting.metrics import format_report
    from .backtesting.montecarlo import MonteCarloConfig, run_robustness
    from .backtesting.replay import (
        ReplaySession,
        SyntheticConfig,
        generate_synthetic_session,
    )
    from .logging_setup import setup_logging

    settings = get_settings()
    setup_logging("WARNING", settings.log_dir, settings.log_json)

    if session_file:
        session = ReplaySession.load(session_file)
    else:
        console.print(
            "[yellow]No session file given: generating a SYNTHETIC session.\n"
            "Synthetic results validate the engine, not real-market alpha "
            "(the mispricing is injected by the generator).[/yellow]"
        )
        session = generate_synthetic_session(SyntheticConfig(
            assets=tuple(settings.assets[:3]), windows=windows, seed=seed,
            market_efficiency=efficiency,
        ))

    console.print(f"session: {session.describe()}")
    engine = BacktestEngine(
        settings, session,
        BacktestConfig(decision_interval=interval, label="cli", seed=seed),
    )
    result = engine.run()
    console.print(format_report(
        result.report,
        f"Backtest {result.run_id}" + (" [SYNTHETIC]" if session.synthetic else ""),
    ))

    horizons = result.calibration_by_horizon()
    if horizons:
        table = Table("horizon", "n", "brier", "skill", "ece", "ece floor",
                      "excess", "auc", "vs market", title="Calibration by horizon")
        for band, row in horizons.items():
            table.add_row(
                band, str(row["n"]), f"{row['brier']:.4f}",
                f"{row['brier_skill']:+.4f}", f"{row['ece']:.4f}",
                f"{row['ece_floor']:.4f}", f"{row['ece_excess']:+.4f}",
                f"{row['auc']:.3f}" if row["auc"] is not None else "n/a",
                f"{row['vs_market']:+.4f}" if row["vs_market"] is not None else "n/a",
            )
        console.print(table)

    console.print(f"\ndiagnostics: evaluations={result.diagnostics['evaluations']} "
                  f"tradable={result.diagnostics['tradable']} "
                  f"orders={result.diagnostics['orders']}")
    console.print(f"top blockers: {result.diagnostics['top_blockers'][:8]}")

    if result.report.trades == 0:
        anchor = settings.market_anchor_weight
        console.print(
            f"\n[yellow]No trades were taken. That is the expected outcome "
            f"unless the market is clearly mispriced: MARKET_ANCHOR_WEIGHT is "
            f"{anchor:.2f}, so the model's disagreement with the market is "
            f"shrunk to roughly {anchor:.0%} before it counts as edge.\n"
            f"The blockers above say which condition failed. To explore a more "
            f"mispriced world, lower --efficiency; to see the effect of trusting "
            f"the model more, raise MARKET_ANCHOR_WEIGHT (and read "
            f"docs/CONFIG.md on fitting it from real data first).[/yellow]"
        )

    if robustness and result.trades:
        report = run_robustness(
            result.trades, settings.bankroll, MonteCarloConfig(n_paths=1000, seed=seed)
        )
        console.print("\n=== Monte Carlo bootstrap ===")
        console.print(report.bootstrap.summary())
        console.print("\n=== Stress scenarios ===")
        console.print(report.table())
        console.print(f"\nscenarios profitable: {report.scenarios_profitable:.0%}")

    if out:
        path = result.save(out)
        console.print(f"\nsaved: {path}")


@app.command()
def session(
    out: Path = typer.Option(Path("data/recorded_session.json"),
                             help="where to write the replay session"),
    hours: float = typer.Option(24.0, help="how far back to include"),
    assets: str | None = typer.Option(None, help="comma-separated asset filter"),
) -> None:
    """Build a replay session from the bot's own recorded paper/live data.

    This is the best evidence available without live API access: the books and
    reference prices are exactly what the bot saw.
    """
    import time as _time

    from .backtesting.real import save_session, session_from_database
    from .database.store import Database

    settings = get_settings()
    db = Database(settings.database_url)

    async def build():
        await db.start()
        try:
            return await session_from_database(
                db,
                start_ts=_time.time() - hours * 3600,
                assets=[a.strip().upper() for a in assets.split(",")] if assets else None,
            )
        finally:
            await db.stop()

    replay = asyncio.run(build())
    if not replay.markets:
        console.print(
            "[yellow]No resolved markets recorded yet. Run `bot start` in paper "
            "mode for a while first - every window it watches is recorded.[/yellow]"
        )
        raise typer.Exit(1)
    save_session(replay, out)
    console.print_json(json.dumps(replay.describe(), default=str))
    console.print(f"\nsaved: {out}")
    console.print(f"backtest it with:  bot backtest --session-file {out}")


@app.command()
def walkforward(
    session_file: Path | None = typer.Option(None, help="replay session JSON"),
    windows: int = typer.Option(48, help="synthetic windows per asset"),
    efficiency: float = typer.Option(0.45, help="synthetic market efficiency"),
    slices: int = typer.Option(4, help="number of walk-forward slices"),
    model: str = typer.Option("logistic", help="model kind, or 'none' for analytic only"),
    seed: int = typer.Option(42),
    seeds: int = typer.Option(
        1, help="repeat over N synthetic seeds and report the spread"
    ),
    out: Path | None = typer.Option(None),
) -> None:
    """Walk-forward validation: each slice traded with a model fitted only on
    the slices before it."""
    from .backtesting.replay import (
        ReplaySession,
        SyntheticConfig,
        generate_synthetic_session,
    )
    from .backtesting.walkforward import SeedSweepResult, run_walkforward
    from .logging_setup import setup_logging

    settings = get_settings()
    setup_logging("WARNING", settings.log_dir, settings.log_json)

    def run_one(run_seed: int):
        if session_file:
            session = ReplaySession.load(session_file)
        else:
            session = generate_synthetic_session(SyntheticConfig(
                assets=tuple(settings.assets[:3]), windows=windows, seed=run_seed,
                market_efficiency=efficiency,
            ))
        return run_walkforward(
            settings, session, n_slices=slices,
            model_kind=None if model == "none" else model, seed=run_seed,
        )

    if seeds < 1:
        console.print("[red]--seeds must be at least 1[/]")
        raise typer.Exit(2)
    if seeds > 1 and session_file:
        console.print(
            "[red]--seeds needs a synthetic session: one recorded session is "
            "one world, and re-running it changes nothing.[/]"
        )
        raise typer.Exit(2)

    if not session_file:
        console.print(
            "[yellow]Generating a SYNTHETIC session (engine validation only).[/yellow]"
        )

    if seeds > 1:
        runs = []
        for offset in range(seeds):
            run_seed = seed + offset
            console.print(f"[dim]seed {run_seed} ({offset + 1}/{seeds})...[/]")
            runs.append((run_seed, run_one(run_seed)))
        sweep = SeedSweepResult(runs=runs, label=f"{seeds} seeds from {seed}")
        console.print("\n=== Walk-forward per seed (each fully out of sample) ===")
        console.print(sweep.table())
        console.print("\n=== Across seeds ===")
        console.print(sweep.summary())
        console.print(
            "\n[yellow]Twenty to forty trades per seed is too few to call a "
            "P&L. Read the spread, not the best row.[/]"
        )
        if out:
            console.print(f"saved: {sweep.save(out / 'walkforward_seeds.json')}")
        return

    result = run_one(seed)
    console.print("=== Walk-forward slices (each out of sample) ===")
    console.print(result.table())
    console.print("\n=== Combined ===")
    console.print(result.combined.summary())
    if result.combined_calibration:
        report = result.combined_calibration
        console.print(
            f"\nout-of-sample model calibration: n={report.n_samples} "
            f"brier={report.brier:.4f} skill={report.brier_skill:+.4f} "
            f"ece={report.ece:.4f} (floor {report.ece_noise_floor:.4f}, "
            f"excess {report.ece_excess:+.4f})"
        )
    colour = {
        "stable": "green", "unstable": "red", "insufficient evidence": "yellow",
    }[result.stability]
    console.print(
        f"\nstable across slices: [{colour}]{result.stability}[/] "
        f"({result.stability_detail()})"
    )
    if out:
        console.print(f"saved: {result.save(out / 'walkforward.json')}")


@app.command()
def train(
    source: str = typer.Option(
        "database", help="database | backtest | file (dataset JSON)"
    ),
    dataset_file: Path | None = typer.Option(None),
    windows: int = typer.Option(60, help="synthetic windows if source=backtest"),
    splits: int = typer.Option(5, help="walk-forward folds for model selection"),
    select: str | None = typer.Option(
        None, help="force a model kind instead of using the benchmark winner"
    ),
    out: Path | None = typer.Option(None, help="model output directory"),
) -> None:
    """Benchmark candidate models with purged walk-forward CV, then fit the
    winner and save it with a reproducibility manifest."""
    from .features.engine import FEATURE_NAMES
    from .logging_setup import setup_logging
    from .ml.dataset import Dataset
    from .ml.train import benchmark, format_table, train_final

    settings = get_settings()
    setup_logging("WARNING", settings.log_dir, settings.log_json)

    if source == "file":
        if not dataset_file:
            console.print("[red]--dataset-file is required with --source file[/red]")
            raise typer.Exit(2)
        dataset = Dataset.load(dataset_file)
    elif source == "backtest":
        from .backtesting.engine import BacktestConfig, BacktestEngine
        from .backtesting.replay import SyntheticConfig, generate_synthetic_session

        console.print(
            "[yellow]Training on SYNTHETIC data. Useful to exercise the pipeline; "
            "a model fitted here must not be trusted on real markets.[/yellow]"
        )
        session = generate_synthetic_session(SyntheticConfig(
            assets=tuple(settings.assets[:3]), windows=windows, seed=7,
            market_efficiency=0.45,
        ))
        engine = BacktestEngine(
            settings, session, BacktestConfig(label="train", sample_interval=3.0)
        )
        dataset = engine.run().dataset
    else:
        from .database.repo import Repository
        from .database.store import Database

        db = Database(settings.database_url)

        async def load():
            await db.start()
            try:
                return await Repository(db).build_training_dataset(FEATURE_NAMES)
            finally:
                await db.stop()

        dataset = asyncio.run(load())

    labelled = dataset.labelled
    console.print(f"dataset: {labelled.describe()}")
    if len(labelled) < 200:
        console.print(
            "[red]Not enough labelled samples to train responsibly "
            f"({len(labelled)}). Run the bot in paper mode to collect data, or use "
            "--source backtest to exercise the pipeline.[/red]"
        )
        raise typer.Exit(1)

    results = benchmark(
        labelled, n_splits=splits,
        calibration_method=settings.calibration_method,
        min_calibration_samples=min(settings.min_calibration_samples, len(labelled) // 4),
    )
    console.print("\n=== Model selection (purged walk-forward CV) ===")
    console.print(format_table(results))
    console.print(
        "\n[dim]composite = mean Brier skill - 0.5*std(skill) - 0.5*ECE: "
        "consistency and calibration are weighted against raw accuracy.[/dim]"
    )

    viable = [r for r in results if r.error is None and r.folds]
    if not viable:
        console.print("[red]no model trained successfully[/red]")
        raise typer.Exit(1)
    chosen = select or viable[0].kind
    console.print(f"\nselected: [bold]{chosen}[/bold]")

    output = out or (settings.model_dir / settings.model_name)
    manifest = train_final(
        labelled, chosen, output,
        calibration_method=settings.calibration_method,
        min_calibration_samples=min(settings.min_calibration_samples, len(labelled) // 4),
        seed=settings.random_seed,
        extra_manifest={"benchmark": [r.row() for r in results]},
    )
    console.print(f"\nsaved to {output}")
    test = manifest["test_report"]
    console.print(
        f"held-out test: n={test['n_samples']} brier={test['brier']:.4f} "
        f"skill={test['brier_skill']:+.4f} ece={test['ece']:.4f} "
        f"(excess {test.get('ece_excess', float('nan')):+.4f})"
    )
    if manifest.get("market_report"):
        market = manifest["market_report"]
        console.print(
            f"market's own price on the same samples: brier={market['brier']:.4f} "
            f"-> model {'beats' if market['brier'] > test['brier'] else 'loses to'} "
            f"the market by {abs(market['brier'] - test['brier']):.5f} Brier"
        )
    top = list(manifest.get("importances", {}).items())[:12]
    if top:
        table = Table("feature", "importance", title="Top features")
        for name, value in top:
            table.add_row(name, f"{value:.4f}")
        console.print(table)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
