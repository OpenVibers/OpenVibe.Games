#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
TF2_SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"
MOD_BIN="$ROOT/game/openvibe.games/bin/linux64"
SDK_HL2MP_BIN="$ROOT/engine/source-sdk-2013/game/mod_hl2mp/bin/linux64"
SDK_LIB_BIN="$ROOT/engine/source-sdk-2013/src/lib/public/linux64"
TF2_BIN="$TF2_SRCDS/bin/linux64"

mkdir -p "$MOD_BIN"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    exit 1
  fi
}

require_file "$SDK_HL2MP_BIN/client.so"
require_file "$SDK_HL2MP_BIN/server.so"
require_file "$SDK_HL2MP_BIN/game_shader_generic_example.so"
require_file "$SDK_LIB_BIN/libtier0.so"
require_file "$SDK_LIB_BIN/libvstdlib.so"
require_file "$SDK_LIB_BIN/libsteam_api.so"
require_file "$TF2_BIN/soundemittersystem_srv.so"
require_file "$TF2_BIN/shaderapiempty_srv.so"

ln -sfn "$SDK_HL2MP_BIN/client.so" "$MOD_BIN/client.so"
ln -sfn client.so "$MOD_BIN/client_srv.so"
ln -sfn "$SDK_HL2MP_BIN/server.so" "$MOD_BIN/server.so"
ln -sfn server.so "$MOD_BIN/server_srv.so"
ln -sfn "$SDK_HL2MP_BIN/game_shader_generic_example.so" "$MOD_BIN/game_shader_generic_example_srv.so"

ln -sfn "$SDK_LIB_BIN/libtier0.so" "$MOD_BIN/libtier0.so"
ln -sfn "$SDK_LIB_BIN/libvstdlib.so" "$MOD_BIN/libvstdlib.so"
ln -sfn "$SDK_LIB_BIN/libsteam_api.so" "$MOD_BIN/libsteam_api.so"

for module in soundemittersystem scenefilecache datacache materialsystem studiorender vphysics vscript replay shaderapiempty; do
  require_file "$TF2_BIN/${module}_srv.so"
  ln -sfn "$TF2_BIN/${module}_srv.so" "$MOD_BIN/${module}.so"
done

echo "[openvibe] bin/linux64 compatibility links ready"
