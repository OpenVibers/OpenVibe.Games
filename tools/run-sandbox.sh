#!/usr/bin/env bash
set -euo pipefail

# OpenVibe Sandbox dev server (free-build + JS Q menu).
#
# Standalone launcher (does not use run-server.sh's fixed map_input) because the
# sandbox needs to force the JS gamemode to "sandbox" AFTER the map is up:
# loading the ov_hub map auto-execs cfg/ov_hub.cfg -> openvibe_hub.cfg, and the
# JS runtime latches ov_mode on first tick. ov_js_reload re-reads ov_mode and
# reloads the gamemode, so we set ov_mode + reload once the server is live.

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"
MOD="$ROOT/game/openvibe.games"
PORT="${OPENVIBE_SANDBOX_PORT:-27020}"
MAP="${OPENVIBE_SANDBOX_MAP:-ov_hub}"
MAXPLAYERS="${OPENVIBE_SANDBOX_MAXPLAYERS:-24}"
BIND_IP="${OPENVIBE_BIND_IP:-127.0.0.1}"
MAP_DELAY="${OPENVIBE_SRCDS_MAP_DELAY:-6}"
RELOAD_DELAY="${OPENVIBE_SANDBOX_RELOAD_DELAY:-8}"

if [[ ! -x "$SRCDS/srcds_linux64" ]]; then
  echo "Missing 64-bit SRCDS at $SRCDS/srcds_linux64" >&2
  exit 1
fi
if [[ ! -f "$MOD/maps/$MAP.bsp" ]]; then
  echo "Missing map $MOD/maps/$MAP.bsp" >&2
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
  +exec openvibe_sandbox.cfg
)

printf -v server_command '%q ' "${server_cmd[@]}"

console_input() {
  sleep "$MAP_DELAY"
  printf 'map %s\n' "$MAP"
  # After the map is live and the JS runtime has started, force sandbox mode.
  sleep "$RELOAD_DELAY"
  printf 'ov_mode sandbox\n'
  printf 'ov_js_reload\n'
  while sleep 3600; do :; done
}

filter_output() {
  sed -u \
    -e '/WARNING: Failed to load 32-bit libtinfo\.so\.5 or libncurses\.so\.5\./d' \
    -e '/Please install (lib32tinfo5 \/ ncurses-libs\.i686 \/ equivalent) to enable readline\./d'
}

if command -v script >/dev/null 2>&1; then
  console_input | script -qfec "$server_command" /dev/null | filter_output
else
  console_input | "${server_cmd[@]}" | filter_output
fi
