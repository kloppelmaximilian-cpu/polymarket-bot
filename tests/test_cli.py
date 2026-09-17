"""CLI surface: every command must at least run and fail cleanly."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from pmbot.cli import app

runner = CliRunner()


@pytest.fixture
def state(tmp_path, monkeypatch):
    """A state.json where the CLI expects it, plus a matching config."""
    data = tmp_path / "data"
    logs = tmp_path / "logs"
    data.mkdir()
    logs.mkdir()
    monkeypatch.setenv("LOG_DIR", str(logs))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{data}/test.db")
    monkeypatch.setenv("MODEL_DIR", str(tmp_path / "models"))
    from pmbot.config import reset_settings

    reset_settings()

    from tests.test_dashboard import full_snapshot

    (data / "state.json").write_text(json.dumps(full_snapshot()))
    yield tmp_path
    reset_settings()


class TestHelp:
    def test_root_help(self):
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        for command in ("start", "status", "markets", "signals", "backtest",
                        "walkforward", "train", "dashboard", "doctor", "risk"):
            assert command in result.output

    @pytest.mark.parametrize(
        "command",
        ["start", "stop", "dashboard", "status", "markets", "signals", "positions",
         "trades", "pnl", "risk", "strategies", "feeds", "config", "audit",
         "discover", "doctor", "backtest", "walkforward", "train", "session"],
    )
    def test_each_command_has_help(self, command):
        result = runner.invoke(app, [command, "--help"])
        assert result.exit_code == 0


class TestReadOnlyCommands:
    @pytest.mark.parametrize(
        "command",
        ["status", "markets", "signals", "positions", "trades", "pnl", "risk",
         "strategies", "feeds"],
    )
    def test_runs_against_a_live_snapshot(self, command, state):
        result = runner.invoke(app, [command])
        assert result.exit_code == 0, result.output

    @pytest.mark.parametrize(
        "command",
        ["status", "markets", "signals", "positions", "trades", "pnl", "risk",
         "strategies", "feeds"],
    )
    def test_fails_cleanly_without_a_running_bot(self, command, tmp_path, monkeypatch):
        # Point every path at a fresh empty tree so no earlier test's state or
        # a stray .env can make a snapshot appear.
        empty = tmp_path / "empty"
        (empty / "logs").mkdir(parents=True)
        monkeypatch.setenv("LOG_DIR", str(empty / "logs"))
        monkeypatch.setenv("DATABASE_URL", f"sqlite:///{empty}/t.db")
        monkeypatch.setenv("MODEL_DIR", str(empty / "models"))
        from pmbot.config import reset_settings

        reset_settings()
        assert not (empty / "data" / "state.json").exists()
        result = runner.invoke(app, [command])
        assert result.exit_code == 1, result.output
        assert "not found" in result.output
        reset_settings()

    def test_status_shows_the_key_numbers(self, state):
        result = runner.invoke(app, ["status"])
        assert "PAPER" in result.output
        assert "equity" in result.output

    def test_risk_shows_limits_against_current_values(self, state):
        result = runner.invoke(app, ["risk"])
        assert "max daily loss" in result.output
        assert "max drawdown" in result.output

    def test_markets_accepts_a_sort_key(self, state):
        assert runner.invoke(app, ["markets", "--sort", "confidence"]).exit_code == 0

    def test_config_redacts_secrets(self, tmp_path, monkeypatch):
        monkeypatch.setenv("POLYMARKET_PRIVATE_KEY", "0x" + "a" * 64)
        from pmbot.config import reset_settings

        reset_settings()
        result = runner.invoke(app, ["config"])
        assert result.exit_code == 0
        assert "a" * 64 not in result.output
        assert "***" in result.output
        reset_settings()

    def test_stop_explains_itself(self):
        result = runner.invoke(app, ["stop"])
        assert result.exit_code == 0
        assert "SIGTERM" in result.output


class TestDoctor:
    def test_reports_dependencies_and_mode(self, state):
        result = runner.invoke(app, ["doctor"])
        assert result.exit_code == 0
        assert "PAPER" in result.output
        assert "import numpy" in result.output

    def test_reports_unreachable_apis_rather_than_crashing(self, state):
        result = runner.invoke(app, ["doctor"])
        assert result.exit_code == 0
        assert "gamma API" in result.output


class TestLiveGuard:
    def test_start_refuses_live_without_confirmation(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOG_DIR", str(tmp_path))
        monkeypatch.delenv("LIVE_CONFIRMATION", raising=False)
        from pmbot.config import reset_settings

        reset_settings()
        result = runner.invoke(app, ["start", "--mode", "live"])
        assert result.exit_code != 0
        reset_settings()


class TestDashboardCommand:
    def test_single_frame(self, state):
        result = runner.invoke(app, ["dashboard", "--once", "--width", "200"])
        assert result.exit_code == 0


class TestAudit:
    def test_reports_when_there_is_nothing_to_show(self, state):
        result = runner.invoke(app, ["audit", "nonexistent-market"])
        assert result.exit_code == 1
        assert "no audit records" in result.output


class TestSessionCommand:
    def test_reports_when_nothing_has_been_recorded(self, state):
        result = runner.invoke(app, ["session", "--hours", "1"])
        assert result.exit_code == 1
        assert "No resolved markets" in result.output


class TestBacktestCommand:
    @pytest.mark.slow
    def test_synthetic_backtest_runs_and_warns(self, state):
        result = runner.invoke(app, [
            "backtest", "--windows", "3", "--efficiency", "0.2", "--seed", "1",
            "--no-robustness",
        ])
        assert result.exit_code == 0, result.output
        assert "SYNTHETIC" in result.output
        assert "trades" in result.output

    @pytest.mark.slow
    def test_train_refuses_on_too_little_data(self, state):
        result = runner.invoke(app, ["train", "--source", "database"])
        assert result.exit_code == 1
        assert "Not enough labelled samples" in result.output
