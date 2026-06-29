#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

echo "[openvibe] client mode diagnostic"
echo "Windows/Proton launcher: $ROOT/tools/run-client-proton.sh"
echo "Linux client module expected at: $ROOT/game/openvibe.games/bin/linux64/client.so"

if [[ -f "$ROOT/game/openvibe.games/bin/linux64/client.so" ]]; then
  echo "[ok] Linux client.so exists"
else
  echo "[warn] Linux client.so missing; run tools/build-sdk-linux.sh and tools/setup-openvibe-bin.sh"
fi

cat <<'MSG'

If the in-game console says unknown command "ov_join" or "ov_menu", the OpenVibe client DLL is not loaded.
That is expected when launching Windows hl2.exe through Proton while only Linux client.so exists.

Current reliable UI path:
  - Electron launcher / local Chromium UI
  - server-side GameDLL commands

Full in-game HTML menu requires one of:
  1. Run a native Linux Source client that loads bin/linux64/client.so, or
  2. Build a Windows client.dll/server.dll and place them in game/openvibe.games/bin/ for Proton hl2.exe.
MSG
