#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: run-server.sh <mode> <port> <map> <maxplayers> <cfg>" >&2
  exit 2
fi

MODE="$1"
PORT="$2"
MAP="$3"
MAXPLAYERS="$4"
CFG="$5"

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"
MOD="$ROOT/game/openvibe.games"

if [[ ! -x "$SRCDS/srcds_linux64" ]]; then
  echo "Missing 64-bit SRCDS at $SRCDS/srcds_linux64" >&2
  echo "Install Team Fortress 2 Dedicated Server AppID 232250 into $SRCDS." >&2
  exit 1
fi

if [[ ! -f "$MOD/maps/$MAP.bsp" ]]; then
  echo "Missing map $MOD/maps/$MAP.bsp" >&2
  echo "Compile hammer/vmf/$MAP.vmf first." >&2
  exit 1
fi

cd "$SRCDS"

export LD_LIBRARY_PATH="$MOD/bin/linux64:.:$SRCDS/bin/linux64:$SRCDS/bin:${LD_LIBRARY_PATH:-}"

exec ./srcds_linux64 \
  -game "$MOD" \
  -console \
  -usercon \
  +ip 0.0.0.0 \
  +port "$PORT" \
  +maxplayers "$MAXPLAYERS" \
  +map "$MAP" \
  +exec "$CFG"
