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
  echo "Creating virtual environment..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  echo "Installing pmbot and dependencies (this takes a minute)..."
  "$VENV/bin/pip" install --quiet -e ".[all]"
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
