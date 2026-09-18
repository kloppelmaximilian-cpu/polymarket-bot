"""Dashboard: state reading and every renderer."""

from __future__ import annotations

import json
import time

import pytest
from rich.console import Console

from pmbot.dashboard.render import (
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
from pmbot.dashboard.state import DashboardState, StateReader

PANELS = [
    header_panel, account_panel, market_table, signal_panel, positions_panel,
    history_panel, strategy_panel, feeds_panel, alerts_panel,
]


def full_snapshot(**overrides) -> dict:
    now = time.time()
    snapshot = {
        "ts": now, "mode": "paper", "live_armed": False, "dry_run": False,
        "uptime": 3725.0,
        "risk": {
            "bankroll": 1012.4, "equity": 1018.9, "peak_equity": 1025.0,
            "available": 972.4, "open_exposure": 40.0, "realized_pnl": 12.4,
            "unrealized_pnl": 6.5, "daily_pnl": 12.4, "session_pnl": 12.4,
            "open_positions": 1, "consecutive_losses": 1, "drawdown": 0.006,
            "trading_paused": False, "pause_reason": "", "pause_until": 0,
        },
        "stats": {
            "trades": 37, "wins": 21, "losses": 16, "win_rate": 0.5676,
            "realized_pnl": 12.4, "fees_paid": 4.21, "avg_win": 3.1,
            "avg_loss": 2.4, "profit_factor": 1.19, "expectancy": 0.335,
            "trades_per_hour": 12.4, "session_hours": 2.98,
            "max_drawdown": 0.02, "consecutive_losses": 1,
        },
        "loop": {
            "cycles": 14820, "errors": 0, "last_cycle_ms": 31.2,
            "avg_cycle_ms": 28.7, "evaluations": 74100,
            "trades_attempted": 52, "trades_filled": 37,
        },
        "health": {"level": "OK", "score": 0.97, "issues": [],
                   "size_multiplier": 1.0, "detail": {}},
        "discovery": {"cycles": 180, "tracked": 2,
                      "series": {"BTC": "btc-up-or-down-5m"}, "rejects": {},
                      "last_error": ""},
        "markets": [{
            "market_id": "m1", "asset": "BTC", "slug": "btc-updown-5m-1",
            "seconds_remaining": 143.0, "in_window": True, "up_bid": 0.51,
            "up_ask": 0.52, "down_bid": 0.48, "down_ask": 0.49, "spread": 0.01,
            "liquidity": 842.0, "spot": 100143.2, "strike": 100090.0,
            "strike_quality": "exact", "distance_bps": 5.3, "model_up": 0.663,
            "market_up": 0.515, "edge": 0.0295, "required_edge": 0.0262,
            "confidence": 0.71, "uncertainty": 0.021, "regime": "TRENDING",
            "decision": "TRADE", "outcome_side": "UP", "data_quality": 0.95,
        }],
        "signals": [{
            "asset": "BTC", "market_id": "m1", "outcome": "UP",
            "model_probability": 0.663, "market_probability": 0.515,
            "net_edge": 0.0295, "gross_edge": 0.143, "fee_cost": 0.0175,
            "slippage_cost": 0.0, "confidence": 0.71, "decision": "TRADE",
            "score": 0.008, "regime": "TRENDING", "seconds_remaining": 143.0,
            "size_shares": 38.4, "notional": 19.97,
            "reasons": ["net edge +0.0295 vs required 0.0262"], "blockers": [],
            "drivers": [{"strategy": "fair_value", "probability": 0.66,
                         "confidence": 0.82, "reason": "analytic fair value"}],
        }],
        "positions": [{
            "position_id": "m1:UP", "market_id": "m1", "asset": "BTC",
            "outcome": "UP", "size": 38.4, "avg_price": 0.517, "current": 0.545,
            "exposure": 19.85, "unrealized": 1.07, "seconds_remaining": 143.0,
            "entry_edge": 0.0295, "entry_confidence": 0.71,
            "expected_value": 5.6, "strategy": "order_flow",
        }],
        "trades": [{
            "closed_at": now - 120, "asset": "BTC", "outcome": "UP", "size": 40.0,
            "entry": 0.52, "exit": 1.0, "pnl": 18.5, "strategy": "momentum",
            "edge": 0.031, "confidence": 0.74, "resolution": "UP",
        }],
        "feeds": [{
            "name": "binance", "status": "ONLINE", "latency_ms": 42,
            "messages_per_sec": 31.2, "reconnects": 0, "errors": 0,
            "clock_drift_ms": 42, "last_update": now, "score": 1.0,
            "detail": "connected",
        }],
        "composites": {"BTC": {"price": 100143.2, "sources": 5,
                               "dispersion_bps": 1.4, "healthy": True,
                               "sigma_window_bps": 15.2}},
        "execution": {"submitted": 52, "filled": 37, "partial": 3, "rejected": 2,
                      "cancelled": 10, "duplicates_blocked": 1, "errors": 0,
                      "fill_rate": 0.71, "total_fees": 4.21,
                      "total_notional": 740.0, "avg_slippage": 0.0012,
                      "maker_fills": 29, "taker_fills": 11},
        "working_orders": 1,
        "strategy_performance": {"fair_value": {"strategy": "fair_value", "n": 210,
                                                "ewma_brier": 0.21, "skill": 0.14,
                                                "wins": 124, "losses": 86}},
        "strategy_pnl": {"fair_value": {"trades": 14, "wins": 9, "pnl": 11.2,
                                        "expectancy": 0.8, "avg_edge": 0.03,
                                        "max_dd": 8.1, "win_rate": 0.64}},
        "database": {"queued": 100, "written": 100, "flushes": 4, "errors": 0,
                     "dropped": 0, "last_flush_at": now, "last_error": ""},
        "resolution": {"compared": 34, "agreed": 33, "disagreed": 1,
                       "agreement_rate": 0.97},
        "alerts": [],
    }
    snapshot.update(overrides)
    return snapshot


def render(panel, state) -> str:
    console = Console(width=200, record=True, file=open("/dev/null", "w"))
    console.print(panel(state))
    return console.export_text()


@pytest.fixture
def state_file(tmp_path):
    def write(snapshot):
        path = tmp_path / "state.json"
        path.write_text(json.dumps(snapshot))
        return path

    return write


class TestStateReader:
    def test_missing_file_is_reported_not_crashed(self, tmp_path):
        state = StateReader(tmp_path / "nope.json").read()
        assert state.connected is False
        assert "not found" in state.error

    def test_corrupt_file_is_reported(self, tmp_path):
        path = tmp_path / "state.json"
        path.write_text("{not json")
        state = StateReader(path).read()
        assert state.connected is False
        assert "JSONDecodeError" in state.error

    def test_fresh_snapshot(self, state_file):
        state = StateReader(state_file(full_snapshot())).read()
        assert state.connected is True
        assert state.stale is False
        assert state.mode == "PAPER"

    def test_old_snapshot_is_flagged_stale(self, state_file):
        state = StateReader(
            state_file(full_snapshot(ts=time.time() - 600)), stale_after=5.0
        ).read()
        assert state.stale is True
        assert any("old" in w for w in state.warnings())

    def test_accessors_degrade_gracefully_on_a_sparse_snapshot(self, state_file):
        state = StateReader(state_file({"ts": time.time()})).read()
        assert state.risk == {}
        assert state.markets == []
        assert state.strategy_rows == []


class TestWarnings:
    def test_pause_is_surfaced(self, state_file):
        snapshot = full_snapshot()
        snapshot["risk"]["trading_paused"] = True
        snapshot["risk"]["pause_reason"] = "daily loss limit"
        warnings = StateReader(state_file(snapshot)).read().warnings()
        assert any("TRADING PAUSED" in w for w in warnings)

    def test_offline_feed_is_surfaced(self, state_file):
        snapshot = full_snapshot()
        snapshot["feeds"][0]["status"] = "OFFLINE"
        warnings = StateReader(state_file(snapshot)).read().warnings()
        assert any("offline" in w for w in warnings)

    def test_wide_spread_and_thin_book(self, state_file):
        snapshot = full_snapshot()
        snapshot["markets"][0]["spread"] = 0.09
        snapshot["markets"][0]["liquidity"] = 40.0
        warnings = StateReader(state_file(snapshot)).read().warnings()
        assert any("spread" in w for w in warnings)
        assert any("thin book" in w for w in warnings)

    def test_drawdown_warning(self, state_file):
        snapshot = full_snapshot()
        snapshot["risk"]["drawdown"] = 0.18
        assert any("drawdown" in w for w in
                   StateReader(state_file(snapshot)).read().warnings())

    def test_size_reduction_is_surfaced(self, state_file):
        snapshot = full_snapshot()
        snapshot["health"]["size_multiplier"] = 0.5
        assert any("size reduced" in w for w in
                   StateReader(state_file(snapshot)).read().warnings())

    def test_warnings_are_deduplicated_and_bounded(self, state_file):
        snapshot = full_snapshot()
        snapshot["health"]["issues"] = ["same issue"] * 20
        assert len(StateReader(state_file(snapshot)).read().warnings()) <= 8


class TestRenderers:
    @pytest.mark.parametrize("panel", PANELS)
    def test_renders_with_full_data(self, panel, state_file):
        output = render(panel, StateReader(state_file(full_snapshot())).read())
        assert output.strip()

    @pytest.mark.parametrize("panel", PANELS)
    def test_renders_with_an_empty_snapshot(self, panel, state_file):
        output = render(panel, StateReader(state_file({"ts": time.time()})).read())
        assert output.strip()

    @pytest.mark.parametrize("panel", PANELS)
    def test_renders_when_disconnected(self, panel):
        output = render(panel, DashboardState(connected=False, error="no bot"))
        assert output.strip()

    @pytest.mark.parametrize("panel", PANELS)
    def test_renders_with_null_fields(self, panel, state_file):
        snapshot = full_snapshot()
        for market in snapshot["markets"]:
            for key in list(market):
                if key not in ("market_id", "asset"):
                    market[key] = None
        for position in snapshot["positions"]:
            for key in list(position):
                if key not in ("position_id", "asset"):
                    position[key] = None
        output = render(panel, StateReader(state_file(snapshot)).read())
        assert output.strip()

    def test_live_mode_is_visually_distinct(self, state_file):
        paper = render(header_panel, StateReader(state_file(full_snapshot())).read())
        live = render(
            header_panel,
            StateReader(state_file(full_snapshot(mode="live", live_armed=True))).read(),
        )
        assert "PAPER" in paper
        assert "LIVE" in live

    def test_dry_run_is_labelled(self, state_file):
        output = render(
            header_panel,
            StateReader(
                state_file(full_snapshot(mode="live", live_armed=True, dry_run=True))
            ).read(),
        )
        assert "DRY RUN" in output

    @pytest.mark.parametrize(
        "sort", ["edge", "confidence", "asset", "time", "liquidity", "signal"]
    )
    def test_every_sort_key_works(self, sort, state_file):
        state = StateReader(state_file(full_snapshot())).read()
        console = Console(width=200, record=True, file=open("/dev/null", "w"))
        console.print(market_table(state, sort))
        assert console.export_text().strip()

    def test_market_table_shows_the_economics(self, state_file):
        output = render(market_table, StateReader(state_file(full_snapshot())).read())
        assert "TRADE" in output
        assert "TRENDING" in output

    def test_signal_panel_explains_the_reasoning(self, state_file):
        output = render(signal_panel, StateReader(state_file(full_snapshot())).read())
        assert "fair_value" in output
        assert "gross" in output

    def test_signal_panel_shows_blockers(self, state_file):
        snapshot = full_snapshot()
        snapshot["signals"][0]["blockers"] = ["net edge too small"]
        output = render(signal_panel, StateReader(state_file(snapshot)).read())
        assert "blocked" in output

    def test_feeds_panel_shows_reconciliation(self, state_file):
        output = render(feeds_panel, StateReader(state_file(full_snapshot())).read())
        assert "agreement" in output


class TestSimpleDashboard:
    def test_single_frame_renders(self, state_file, capsys):
        from pmbot.dashboard.app import run_simple

        assert run_simple(state_file(full_snapshot()), once=True, width=200) == 0
        assert capsys.readouterr().out.strip()

    def test_renders_without_a_bot_running(self, tmp_path, capsys):
        from pmbot.dashboard.app import run_simple

        assert run_simple(tmp_path / "missing.json", once=True, width=200) == 0
        assert "not found" in capsys.readouterr().out

    def test_textual_app_constructs(self, state_file):
        from pmbot.dashboard.app import build_textual_app

        app = build_textual_app(state_file(full_snapshot()), refresh_hz=2.0)
        assert app is not None
        assert app.sort_key == "edge"


class TestPauseWarning:
    """A pause reason from boot reads as a live fault minutes later."""

    @staticmethod
    def _state(**risk):
        import time as _time

        from pmbot.dashboard.state import DashboardState

        payload = full_snapshot()
        payload["ts"] = _time.time()
        payload["risk"] = {**payload.get("risk", {}), **risk}
        return DashboardState(connected=True, stale=False, age=0.1, payload=payload)

    def test_remaining_time_is_shown_while_the_pause_holds(self):
        import time as _time

        state = self._state(
            trading_paused=True,
            pause_reason="system health: only 0 healthy reference feeds",
            pause_until=_time.time() + 240,
        )
        warning = next(w for w in state.warnings() if "PAUSED" in w)
        assert "for another 2" in warning          # ~240s, formatted
        assert "only 0 healthy reference feeds" in warning

    def test_an_expired_pause_drops_the_countdown(self):
        import time as _time

        state = self._state(
            trading_paused=True, pause_reason="manual",
            pause_until=_time.time() - 5,
        )
        warning = next(w for w in state.warnings() if "PAUSED" in w)
        assert "for another" not in warning
        assert warning.endswith("manual")

    def test_a_pause_without_an_until_still_warns(self):
        state = self._state(trading_paused=True, pause_reason="drawdown stop")
        assert any("TRADING PAUSED: drawdown stop" in w for w in state.warnings())

    def test_no_warning_when_not_paused(self):
        state = self._state(trading_paused=False)
        assert not any("PAUSED" in w for w in state.warnings())
