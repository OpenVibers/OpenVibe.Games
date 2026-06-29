#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
GAME_DIR="$ROOT/game/openvibe.games"
CLIENT_SO="$GAME_DIR/bin/linux64/client.so"

find_hl2_linux() {
  local candidates=(
    "${OPENVIBE_HL2_LINUX:-}"
    "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/6tb/ssd_offload/home/$USER/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

if [[ ! -f "$CLIENT_SO" && ! -L "$CLIENT_SO" ]]; then
  echo "ERROR: Linux client.so missing at $CLIENT_SO" >&2
  echo "Run: tools/build-sdk-linux.sh && tools/setup-openvibe-bin.sh" >&2
  exit 1
fi

HL2_LINUX="$(find_hl2_linux)" || {
  echo "ERROR: could not find hl2_linux. Set OPENVIBE_HL2_LINUX=/path/to/hl2_linux" >&2
  exit 1
}

CONNECT_ARGS=()
if [[ "${1:-}" != "" && "${2:-}" != "" ]]; then
  CONNECT_ARGS=(+connect "$1:$2")
fi

exec "$HL2_LINUX" \
  -game "$GAME_DIR" \
  -console -dev -novid -sw -w 1280 -h 720 \
  -port 27115 -clientport 27105 \
  +exec openvibe_proton_client.cfg \
  "${CONNECT_ARGS[@]}"
