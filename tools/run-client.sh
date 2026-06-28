#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK_GAME="$ROOT/engine/source-sdk-2013/game"
MOD="$ROOT/game/openvibe.games"

cd "$SDK_GAME"

if [[ -x ./mod_tf_linux64 ]]; then
  LAUNCHER="./mod_tf_linux64"
elif [[ -x ./mod_hl2mp_linux64 ]]; then
  LAUNCHER="./mod_hl2mp_linux64"
elif [[ -x ./mod_tf ]]; then
  LAUNCHER="./mod_tf"
elif [[ -x ./mod_hl2mp ]]; then
  LAUNCHER="./mod_hl2mp"
else
  echo "No SDK launcher found. Run tools/build-sdk-linux.sh first." >&2
  exit 1
fi

exec "$LAUNCHER" \
  -game "$MOD" \
  -console \
  -dev \
  -sw \
  -w 1280 \
  -h 720
