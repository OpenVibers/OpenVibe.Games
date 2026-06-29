#!/usr/bin/env bash
# run-sidecar.sh
# Launch the ov-sidecar.mjs process for one game mode server.
#
# Usage: run-sidecar.sh <server-id> <mode> <port> <max-players>
# Example: run-sidecar.sh local-prophunt-27016 prophunt 27016 24

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: run-sidecar.sh <server-id> <mode> <port> <max-players>" >&2
  exit 2
fi

SERVER_ID="$1"
MODE="$2"
PORT="$3"
MAX_PLAYERS="$4"

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
LOG_DIR="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}/../openvibe.games/logs"

# Use the actual game log directory if running from the mod root
if [[ -d "$ROOT/game/openvibe.games/logs" ]]; then
  LOG_DIR="$ROOT/game/openvibe.games/logs"
fi

case "$MODE" in
  hub) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
  prophunt) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
  deathrun) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
  fortwars) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
  traitortown) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
  *) DEFAULT_PUBLIC_HOST="127.0.0.1" ;;
esac

exec node "$ROOT/tools/ov-sidecar.mjs" \
  --server-id  "$SERVER_ID" \
  --server-secret "${OPENVIBE_SERVER_SECRET:-dev-secret}" \
  --mode       "$MODE" \
  --port       "$PORT" \
  --max-players "$MAX_PLAYERS" \
  --host       "${OPENVIBE_PUBLIC_HOST:-$DEFAULT_PUBLIC_HOST}" \
  --api-url    "${OPENVIBE_API_URL:-http://127.0.0.1:3000}" \
  --log-dir    "$LOG_DIR"
