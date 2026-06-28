#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: compile-map-wine.sh <map-name-without-extension>" >&2
  exit 2
fi

MAP="$1"
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MOD="$ROOT/game/openvibe.games"
VMF="$ROOT/hammer/vmf/$MAP.vmf"
WINEPREFIX="${WINEPREFIX:-$HOME/.wine-openvibe-hammer}"
TF2_DIR="${TF2_DIR:-$HOME/.steam/steam/steamapps/common/Team Fortress 2}"

if [[ ! -f "$VMF" ]]; then
  echo "Missing VMF: $VMF" >&2
  exit 1
fi

find_tool() {
  local name="$1"
  if [[ -f "$TF2_DIR/bin/x64/$name" ]]; then
    printf '%s\n' "$TF2_DIR/bin/x64/$name"
  elif [[ -f "$TF2_DIR/bin/$name" ]]; then
    printf '%s\n' "$TF2_DIR/bin/$name"
  else
    return 1
  fi
}

VBSP="$(find_tool vbsp.exe)"
VVIS="$(find_tool vvis.exe)"
VRAD="$(find_tool vrad.exe)"

export WINEPREFIX

WIN_GAME="$(winepath -w "$MOD")"
WIN_VMF="$(winepath -w "$VMF")"

wine "$VBSP" -game "$WIN_GAME" "$WIN_VMF"
wine "$VVIS" -game "$WIN_GAME" "$WIN_VMF"
wine "$VRAD" -game "$WIN_GAME" "$WIN_VMF"

mkdir -p "$MOD/maps"
if [[ -f "$ROOT/hammer/vmf/$MAP.bsp" ]]; then
  mv "$ROOT/hammer/vmf/$MAP.bsp" "$MOD/maps/$MAP.bsp"
fi

echo "[compile] wrote $MOD/maps/$MAP.bsp"
