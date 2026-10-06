#!/usr/bin/env bash
# Local web dashboard. Safe to run while the bot is trading: it reads the
# published snapshot and never touches the trading loop.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/bot" ]; then
  echo "Not installed yet. Run ./start_bot.sh first." >&2
  exit 1
fi

exec .venv/bin/bot web "$@"
