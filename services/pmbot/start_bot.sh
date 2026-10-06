#!/usr/bin/env bash
# Start the bot. Paper mode unless --live is passed AND the environment arms it.
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
MODE="paper"
EXTRA=()

for arg in "$@"; do
  case "$arg" in
    --live) MODE="live" ;;
    --dry-run) export DRY_RUN_LIVE=true ;;
    *) EXTRA+=("$arg") ;;
  esac
done

if [ ! -d "$VENV" ]; then
  # Pick an interpreter this project actually supports. macOS ships 3.9 as
  # `python3`, so fall through to the versioned names before giving up --
  # otherwise pip fails halfway with a much less obvious message.
  PY_BIN="${PYTHON:-}"
  if [ -z "$PY_BIN" ]; then
    for candidate in python3 python3.13 python3.12 python3.11; do
      if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c \
         'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
        PY_BIN="$candidate"
        break
      fi
    done
  fi
  if [ -z "$PY_BIN" ]; then
    cat >&2 <<'MSG'
No Python 3.11+ found.

  macOS:  brew install python@3.12
  Linux:  apt install python3.12 python3.12-venv

Then re-run, or point this script at an interpreter directly:
  PYTHON=/full/path/to/python3.12 ./start_bot.sh
MSG
    exit 1
  fi
  echo "Creating virtual environment with $PY_BIN..."
  "$PY_BIN" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  echo "Installing pmbot and dependencies (this takes a minute)..."
  if ! "$VENV/bin/pip" install --quiet -e ".[all]"; then
    echo "Full install failed; retrying without the ML extra." >&2
    echo "On macOS LightGBM also needs: brew install libomp" >&2
    "$VENV/bin/pip" install --quiet -e ".[live,dev]"
  fi
fi

mkdir -p data logs models

if [ "$MODE" = "live" ]; then
  if [ "${LIVE_CONFIRMATION:-false}" != "true" ]; then
    cat >&2 <<'MSG'
Refusing to start in live mode.

Live trading needs LIVE_CONFIRMATION=true in the environment, on top of
--live, plus a signing key and L2 API credentials. Read docs/SETUP.md.

To see exactly what it would send without sending anything:
  DRY_RUN_LIVE=true LIVE_CONFIRMATION=true ./start_bot.sh --live
MSG
    exit 2
  fi
  echo "*** LIVE TRADING - real orders will be placed ***"
  [ "${DRY_RUN_LIVE:-false}" = "true" ] && echo "*** DRY RUN: orders built, not sent ***"
  sleep 2
else
  echo "Starting in PAPER mode. No real orders will be placed."
fi

echo $$ > data/bot.pid
trap 'rm -f data/bot.pid' EXIT

exec "$VENV/bin/bot" start --mode "$MODE" ${EXTRA[@]+"${EXTRA[@]}"}
