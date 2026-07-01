#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
TF2_SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"
MOD_BIN="$ROOT/game/openvibe.games/bin"
MOD_LINUX_BIN="$MOD_BIN/linux64"
SDK_HL2MP_LINUX_BIN="$ROOT/engine/source-sdk-2013/game/mod_hl2mp/bin/linux64"
SDK_LIB_BIN="$ROOT/engine/source-sdk-2013/src/lib/public/linux64"
TF2_BIN="$TF2_SRCDS/bin/linux64"
SDK_HL2MP_WIN_BIN="$ROOT/engine/source-sdk-2013/game/mod_hl2mp/bin"

mkdir -p "$MOD_LINUX_BIN" "$MOD_BIN"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    exit 1
  fi
}

link_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    ln -sfn "$src" "$dst"
    echo "[openvibe] linked ${dst#$ROOT/} -> $src"
  fi
}

copy_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    install -D -m 0644 "$src" "$dst"
    echo "[openvibe] copied ${dst#$ROOT/}"
    return 0
  fi
  return 1
}

# Linux native / Linux dedicated server modules.
require_file "$SDK_HL2MP_LINUX_BIN/client.so"
require_file "$SDK_HL2MP_LINUX_BIN/server.so"
require_file "$SDK_HL2MP_LINUX_BIN/game_shader_generic_example.so"
require_file "$SDK_LIB_BIN/libtier0.so"
require_file "$SDK_LIB_BIN/libvstdlib.so"
require_file "$SDK_LIB_BIN/libsteam_api.so"

ln -sfn "$SDK_HL2MP_LINUX_BIN/client.so" "$MOD_LINUX_BIN/client.so"
ln -sfn client.so "$MOD_LINUX_BIN/client_srv.so"
ln -sfn "$SDK_HL2MP_LINUX_BIN/server.so" "$MOD_LINUX_BIN/server.so"
ln -sfn server.so "$MOD_LINUX_BIN/server_srv.so"
ln -sfn "$SDK_HL2MP_LINUX_BIN/game_shader_generic_example.so" "$MOD_LINUX_BIN/game_shader_generic_example_srv.so"
ln -sfn "$SDK_LIB_BIN/libtier0.so" "$MOD_LINUX_BIN/libtier0.so"
ln -sfn "$SDK_LIB_BIN/libvstdlib.so" "$MOD_LINUX_BIN/libvstdlib.so"
ln -sfn "$SDK_LIB_BIN/libsteam_api.so" "$MOD_LINUX_BIN/libsteam_api.so"

if [[ -d "$TF2_BIN" ]]; then
  for module in soundemittersystem scenefilecache datacache materialsystem studiorender vphysics vscript replay shaderapiempty; do
    if [[ -f "$TF2_BIN/${module}_srv.so" ]]; then
      ln -sfn "$TF2_BIN/${module}_srv.so" "$MOD_LINUX_BIN/${module}.so"
    fi
  done
fi

echo "[openvibe] linux bin/linux64 compatibility links ready"

# Windows/Proton modules. These are optional on Linux until a Windows build has run.
# OPENVIBE_GUARDED_WINDOWS_DLL_COPY_BEGIN
# Do NOT blindly copy any client.dll/server.dll found under the SDK tree. The
# Linux build produces client.so/server.so; Proton needs a separate 32-bit
# Windows PE client.dll from the GitHub Actions Windows workflow. Copying a
# stock/stale DLL here makes Proton launch but leaves ov_join/ov_menu unknown.
win_client_candidates=(
  "$SDK_HL2MP_WIN_BIN/client.dll"
  "$SDK_HL2MP_WIN_BIN/win32/client.dll"
  "$ROOT/engine/source-sdk-2013/src/game/client/Release_hl2mp/client.dll"
  "$ROOT/engine/source-sdk-2013/src/game/client/Release/client.dll"
)
win_server_candidates=(
  "$SDK_HL2MP_WIN_BIN/server.dll"
  "$SDK_HL2MP_WIN_BIN/win32/server.dll"
  "$ROOT/engine/source-sdk-2013/src/game/server/Release_hl2mp/server.dll"
  "$ROOT/engine/source-sdk-2013/src/game/server/Release/server.dll"
)

is_patched_openvibe_client_dll() {
  local dll="$1"
  [[ -f "$dll" ]] || return 1
  command -v strings >/dev/null 2>&1 || return 1
  strings -a "$dll" | grep -Eq 'ov_join|ov_menu|OpenVibe'
}

is_patched_openvibe_server_dll() {
  local dll="$1"
  [[ -f "$dll" ]] || return 1
  command -v strings >/dev/null 2>&1 || return 1
  strings -a "$dll" | grep -Eq 'ov_js_status|ov_js_cmd|OpenVibe'
}

try_copy_windows_pair() {
  local client="$1" server="$2"
  [[ -f "$client" && -f "$server" ]] || return 1
  if ! is_patched_openvibe_client_dll "$client"; then
    echo "[openvibe] skipping stale Windows client.dll candidate: $client"
    return 1
  fi
  if ! is_patched_openvibe_server_dll "$server"; then
    echo "[openvibe] skipping stale Windows server.dll candidate: $server"
    return 1
  fi
  install -D -m 0644 "$client" "$MOD_BIN/client.dll"
  install -D -m 0644 "$server" "$MOD_BIN/server.dll"
  echo "[openvibe] copied patched Windows/Proton DLL pair"
  return 0
}

copied_windows=0
for client in "${win_client_candidates[@]}"; do
  for server in "${win_server_candidates[@]}"; do
    if try_copy_windows_pair "$client" "$server"; then
      copied_windows=1
      break 2
    fi
  done
done

if [[ "$copied_windows" != "1" ]]; then
  echo "[openvibe] no patched Windows/Proton DLL pair found in SDK outputs; leaving existing game/openvibe.games/bin/*.dll alone"
fi

if [[ -f "$MOD_BIN/client.dll" ]]; then
  if is_patched_openvibe_client_dll "$MOD_BIN/client.dll"; then
    echo "[openvibe] Windows/Proton client.dll present and patched"
  else
    echo "[openvibe] WARNING: Windows/Proton client.dll present but lacks ov_join/ov_menu/OpenVibe; install CI artifact before Proton testing" >&2
  fi
else
  echo "[openvibe] Windows/Proton client.dll not present yet; install the GitHub Actions Windows DLL artifact to enable Proton in-game commands"
fi

if [[ -f "$MOD_BIN/server.dll" ]]; then
  if is_patched_openvibe_server_dll "$MOD_BIN/server.dll"; then
    echo "[openvibe] Windows server.dll present and patched"
  else
    echo "[openvibe] WARNING: Windows server.dll present but lacks OpenVibe server strings" >&2
  fi
else
  echo "[openvibe] Windows server.dll not present yet"
fi
# OPENVIBE_GUARDED_WINDOWS_DLL_COPY_END

