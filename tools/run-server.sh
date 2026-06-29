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

case "$MODE" in
  hub) DEFAULT_BIND_IP="127.0.0.1" ;;
  prophunt) DEFAULT_BIND_IP="127.0.0.2" ;;
  deathrun) DEFAULT_BIND_IP="127.0.0.3" ;;
  fortwars) DEFAULT_BIND_IP="127.0.0.4" ;;
  traitortown) DEFAULT_BIND_IP="127.0.0.5" ;;
  *) DEFAULT_BIND_IP="127.0.0.1" ;;
esac

BIND_IP="${OPENVIBE_BIND_IP:-$DEFAULT_BIND_IP}"

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

COMPAT_LIB_DIR="${OPENVIBE_SRCDS_COMPAT_LIB_DIR:-/tmp/openvibe-srcds-compat-$USER}"
if [[ ! -e /lib/i386-linux-gnu/libtinfo.so.5 && -e /lib/i386-linux-gnu/libtinfo.so.6 ]]; then
  mkdir -p "$COMPAT_LIB_DIR"
  ln -sfn /lib/i386-linux-gnu/libtinfo.so.6 "$COMPAT_LIB_DIR/libtinfo.so.5"
fi
if [[ ! -e /lib/i386-linux-gnu/libncurses.so.5 && -e /lib/i386-linux-gnu/libncurses.so.6 ]]; then
  mkdir -p "$COMPAT_LIB_DIR"
  ln -sfn /lib/i386-linux-gnu/libncurses.so.6 "$COMPAT_LIB_DIR/libncurses.so.5"
fi

export LD_LIBRARY_PATH="$COMPAT_LIB_DIR:$MOD/bin/linux64:.:$SRCDS/bin/linux64:$SRCDS/bin:${LD_LIBRARY_PATH:-}"

server_cmd=(
  ./srcds_linux64
  -game "$MOD"
  -console
  -usercon
  -ip "$BIND_IP"
  -port "$PORT"
  +clientport "$((PORT + 1000))"
  +maxplayers "$MAXPLAYERS"
  +tv_port "$((PORT + 2000))"
  +exec "$CFG"
)

if [[ "${OPENVIBE_SRCDS_PIPE_MAP:-1}" == "1" ]]; then
  printf -v server_command '%q ' "${server_cmd[@]}"
  map_input() {
    sleep "$MAP_DELAY"
    printf 'map %s\n' "$MAP"
    while sleep 3600; do :; done
  }
  filter_output() {
    sed -u \
      -e '/WARNING: Failed to load 32-bit libtinfo\.so\.5 or libncurses\.so\.5\./d' \
      -e '/Please install (lib32tinfo5 \/ ncurses-libs\.i686 \/ equivalent) to enable readline\./d'
  }

  if command -v script >/dev/null 2>&1; then
    map_input | script -qfec "$server_command" /dev/null | filter_output
  else
    map_input | "${server_cmd[@]}" | filter_output
  fi
else
  exec "${server_cmd[@]}" +map "$MAP"
fi
