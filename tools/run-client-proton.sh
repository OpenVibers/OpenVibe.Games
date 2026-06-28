#!/bin/bash
# OpenVibe: Source - Game Client Launcher via GE-Proton10-34
# Uses GE-Proton10-34 with SteamLinuxRuntime_sniper bypassing d3d probe timeout

set -e

STEAM_PATH="/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation"
GE_PROTON="$STEAM_PATH/compatibilitytools.d/GE-Proton10-34"
STEAM_COMPAT_DATA="$STEAM_PATH/steamapps/compatdata/243750"
HL2_EXE="/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe"
GAME_DIR="/home/workstation/src/openvibe-source/game/openvibe.games"

# Check dependencies
if [ ! -f "$HL2_EXE" ]; then
    echo "ERROR: hl2.exe not found at $HL2_EXE"
    exit 1
fi

if [ ! -d "$GE_PROTON" ]; then
    echo "ERROR: GE-Proton10-34 not found at $GE_PROTON"
    exit 1
fi

# Build connect args if IP/PORT provided
CONNECT_ARGS=""
if [ -n "$1" ] && [ -n "$2" ]; then
    CONNECT_ARGS="+connect $1:$2"
fi

echo "Launching OpenVibe: Source..."
echo "  Game: $GAME_DIR"
echo "  Proton: $GE_PROTON"
[ -n "$CONNECT_ARGS" ] && echo "  Connect: $CONNECT_ARGS"

mkdir -p "$STEAM_COMPAT_DATA"

export DISPLAY="${DISPLAY:-:0}"
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM_PATH"
export STEAM_COMPAT_DATA_PATH="$STEAM_COMPAT_DATA"
export SteamAppId=243750
export PROTON_LOG=0
export DXVK_ASYNC=1

exec "$GE_PROTON/proton" waitforexitandrun \
    "$HL2_EXE" \
    -game "$GAME_DIR" \
    -console -dev -novid -sw -w 1280 -h 720 \
    $CONNECT_ARGS
