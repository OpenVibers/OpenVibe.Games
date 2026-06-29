#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

echo "[openvibe] client mode diagnostic"
echo "Windows/Proton launcher: $ROOT/tools/run-client-proton.sh"
echo "Linux client module: $ROOT/game/openvibe.games/bin/linux64/client.so"
echo "Fallback aliases: $ROOT/game/openvibe.games/cfg/openvibe_proton_client.cfg"
echo
[[ -f game/openvibe.games/bin/linux64/client.so ]] && echo "[ok] Linux client.so exists" || echo "[missing] Linux client.so missing"
[[ -f game/openvibe.games/cfg/openvibe_proton_client.cfg ]] && echo "[ok] Proton fallback aliases exist" || echo "[missing] Proton fallback aliases missing"

echo
cat <<'TXT'
Important:
  Proton Windows hl2.exe loads Windows client.dll, not Linux bin/linux64/client.so.
  If the console says unknown command ov_join/ov_menu, the OpenVibe client DLL is not loaded.

Current reliable custom UI:
  Electron launcher + local Chromium UI.

Current in-game fallback:
  autoexec.cfg loads openvibe_proton_client.cfg aliases.
  Try: ov_help, ov_join_hub, ov_join_prophunt, ov_join_deathrun.

Full in-game HTML/CSS/JS menu requires:
  1) native Linux Source client loading bin/linux64/client.so, or
  2) a Windows client.dll build for Proton hl2.exe.

Full loading image replacement:
  Convert materialsrc/console/openvibe-loading.svg to:
    materials/console/background01.vtf
    materials/console/background01_widescreen.vtf
TXT
