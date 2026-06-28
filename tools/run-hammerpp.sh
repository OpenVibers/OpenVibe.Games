#!/usr/bin/env bash
set -euo pipefail

export WINEPREFIX="$HOME/.wine-openvibe-hammer"
export TF2_DIR="$HOME/.steam/steam/steamapps/common/Team Fortress 2"

cd "$TF2_DIR/bin/x64"

exec wine ./hammerplusplus.exe
