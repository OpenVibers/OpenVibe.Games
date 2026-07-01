#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

linux_bin="$ROOT/game/openvibe.games/bin/linux64"
win_bin="$ROOT/game/openvibe.games/bin"

echo "[openvibe] platform binary check"
echo

check_file() {
  local label="$1"
  local file="$2"
  if [[ -f "$file" || -L "$file" ]]; then
    echo "[ok]      $label: ${file#$ROOT/}"
    file "$file" 2>/dev/null | sed 's/^/          /' || true
  else
    echo "[missing] $label: ${file#$ROOT/}"
  fi
}

check_file "Linux client" "$linux_bin/client.so"
check_file "Linux server" "$linux_bin/server.so"
check_file "Windows client" "$win_bin/client.dll"
check_file "Windows server" "$win_bin/server.dll"

echo
if [[ -f "$win_bin/client.dll" ]]; then
  echo "[openvibe] Proton Windows hl2.exe should be able to load the OpenVibe client DLL."
else
  echo "[openvibe] Proton Windows hl2.exe will NOT have in-game ov_* client commands until client.dll exists."
fi

echo
echo "[openvibe] Deep DLL content check:"
if [[ -x "${OPENVIBE_ROOT:-$HOME/src/openvibe-source}/tools/verify-openvibe-dll-content.sh" ]]; then
  "${OPENVIBE_ROOT:-$HOME/src/openvibe-source}/tools/verify-openvibe-dll-content.sh" || true
else
  echo "tools/verify-openvibe-dll-content.sh missing"
fi
