.DEFAULT_GOAL := help
VENV := .venv
PY := $(VENV)/bin/python
BOT := $(VENV)/bin/bot

.PHONY: help install run dashboard status doctor discover test test-fast \
        lint validate backtest walkforward train session clean db-size

help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Create the venv and install everything
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install -e ".[all]"
	@mkdir -p data logs models
	@echo "Installed. Next: make doctor"

run:  ## Start the bot in paper mode
	./start_bot.sh

dashboard:  ## Live terminal dashboard
	./dashboard.sh

status:  ## One-screen summary of the running bot
	$(BOT) status

doctor:  ## Check dependencies and API reachability
	$(BOT) doctor

discover:  ## One-shot live market discovery
	$(BOT) discover

test:  ## Full test suite
	$(PY) -m pytest tests/ -q

test-fast:  ## Tests, skipping the slow backtests
	$(PY) -m pytest tests/ -q -m "not slow"

lint:  ## Lint with ruff
	$(VENV)/bin/ruff check src tests scripts

validate:  ## Synthetic engine validation (correctness, not alpha)
	$(PY) scripts/validate_engine.py

backtest:  ## Synthetic backtest with robustness testing
	$(BOT) backtest --windows 24 --efficiency 0.4

walkforward:  ## Walk-forward validation
	$(BOT) walkforward --windows 60 --slices 4

session:  ## Build a replay session from recorded paper data
	$(BOT) session --hours 24 --out data/recorded.json

train:  ## Benchmark models and fit the winner
	$(BOT) train --source database

db-size:  ## Row counts per table
	@$(PY) -c "import sqlite3,sys; c=sqlite3.connect('data/pmbot.db'); \
	[print(f'{t[0]:>24} {c.execute(f\"SELECT COUNT(*) FROM {t[0]}\").fetchone()[0]:>10,}') \
	for t in c.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\")]" \
	2>/dev/null || echo "no database yet"

clean:  ## Remove caches and build artifacts (keeps data/ and models/)
	find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name '*.egg-info' -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf .pytest_cache .ruff_cache build dist
