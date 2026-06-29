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
MAP_DELAY="${OPENVIBE_SRCDS_MAP_DELAY:-6}"

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

printf '243750\n' > "$SRCDS/steam_appid.txt"

export LD_LIBRARY_PATH="$MOD/bin/linux64:.:$SRCDS/bin/linux64:$SRCDS/bin:${LD_LIBRARY_PATH:-}"

server_cmd=(
  ./srcds_linux64
  -game "$MOD"
  -console
  -usercon
  -condebug
  +ip 0.0.0.0
  +port "$PORT"
  +maxplayers "$MAXPLAYERS"
  +exec "$CFG"
)

if [[ "${OPENVIBE_SRCDS_PIPE_MAP:-1}" == "1" ]]; then
  printf -v server_command '%q ' "${server_cmd[@]}"
  map_input() {
    sleep "$MAP_DELAY"
    printf 'map %s\n' "$MAP"
    while sleep 3600; do :; done
  }

  if command -v script >/dev/null 2>&1; then
    map_input | script -qfec "$server_command" /dev/null
  else
    map_input | "${server_cmd[@]}"
  fi
else
  exec "${server_cmd[@]}" +map "$MAP"
fi
