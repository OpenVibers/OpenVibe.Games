#!/usr/bin/env bash
set -euo pipefail

export WINEPREFIX="$HOME/.wine-openvibe-hammer"
export TF2_DIR="$HOME/.steam/steam/steamapps/common/Team Fortress 2"

unset LD_PRELOAD
unset LD_LIBRARY_PATH

export FONTCONFIG_PATH=/etc/fonts
export FONTCONFIG_FILE=/etc/fonts/fonts.conf

export WINEDLLOVERRIDES="dxgi,d3d9,d3d10core,d3d11=b"

cd "$TF2_DIR/bin/x64"
exec wine ./hammerplusplus.exe
