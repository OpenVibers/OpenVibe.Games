#!/bin/bash
# OpenVibe: Source - Game Client Launcher via GE-Proton10-34
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
STEAM_PATH="${OPENVIBE_STEAM_PATH:-/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation}"
GE_PROTON="${OPENVIBE_GE_PROTON:-$STEAM_PATH/compatibilitytools.d/GE-Proton10-34}"
STEAM_COMPAT_DATA="${OPENVIBE_STEAM_COMPAT_DATA:-$STEAM_PATH/steamapps/compatdata/243750}"
HL2_EXE="${OPENVIBE_HL2_EXE:-/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_win64.exe}"
GAME_DIR="${OPENVIBE_GAME_DIR:-$ROOT/game/openvibe.games}"
CLIENT_DLL="$GAME_DIR/bin/x64/client.dll"
SERVER_DLL="$GAME_DIR/bin/x64/server.dll"

if [ ! -f "$HL2_EXE" ]; then
  echo "ERROR: hl2.exe not found at $HL2_EXE" >&2
  exit 1
fi

if [ ! -d "$GE_PROTON" ]; then
  echo "ERROR: GE-Proton not found at $GE_PROTON" >&2
  exit 1
fi

CONNECT_ARGS=""
if [ "${1:-}" != "" ] && [ "${2:-}" != "" ]; then
  CONNECT_ARGS="+connect $1:$2"
fi

# Load straight into a local listen-server world (bypasses the dedicated-server
# travel/token flow) for reliable local testing and crash reproduction:
#   OPENVIBE_STARTUP_MAP=ov_hub tools/run-client-proton-x64.sh
STARTUP_MAP_ARGS=""
if [ -n "${OPENVIBE_STARTUP_MAP:-}" ]; then
  STARTUP_MAP_ARGS="+map ${OPENVIBE_STARTUP_MAP}"
fi

echo "Launching OpenVibe: Source via Proton..."
echo "  Game:   $GAME_DIR"
echo "  Proton: $GE_PROTON"
echo "  HL2:    $HL2_EXE"
[ -n "$CONNECT_ARGS" ] && echo "  Connect: $CONNECT_ARGS"

if [ -f "$CLIENT_DLL" ] && command -v strings >/dev/null 2>&1 && strings -a "$CLIENT_DLL" | grep -Fq "ov_join"; then
  echo "  Client DLL: patched OpenVibe client.dll detected"
elif [ -f "$CLIENT_DLL" ]; then
  echo "  WARNING: client.dll exists, but ov_join string was not found. It may be stock/old." >&2
else
  echo "  WARNING: client.dll missing. Proton will not have OpenVibe client commands." >&2
fi

if [ ! -f "$SERVER_DLL" ]; then
  echo "  WARNING: server.dll missing for Windows listen/server use." >&2
fi

mkdir -p "$STEAM_COMPAT_DATA"

export DISPLAY="${DISPLAY:-:0}"
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM_PATH"
export STEAM_COMPAT_DATA_PATH="$STEAM_COMPAT_DATA"
export SteamAppId="${SteamAppId:-243750}"
export PROTON_LOG="${OPENVIBE_PROTON_LOG:-${PROTON_LOG:-1}}"

# DXVK_ASYNC=1 races async shader pipeline compilation against DXVK swapchain
# teardown on first launch; hl2.exe intermittently dies right after the first
# frame with no error trace. Default off for reliability.
export DXVK_ASYNC="${DXVK_ASYNC:-0}"

exec "$GE_PROTON/proton" waitforexitandrun \
  "$HL2_EXE" \
  -game "$GAME_DIR" \
  -console -dev -condebug -novid -sw -w 1280 -h 720 \
  -port 27115 -clientport 27105 \
  -nojoy -insecure -nohltv \
  +developer 1 \
  +exec openvibe_proton_stability.cfg \
  +con_logfile openvibe_proton_console.log \
  +exec openvibe_proton_client.cfg \
  $CONNECT_ARGS $STARTUP_MAP_ARGS
