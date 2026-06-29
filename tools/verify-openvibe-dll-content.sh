#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
CLIENT="$ROOT/game/openvibe.games/bin/client.dll"
SERVER="$ROOT/game/openvibe.games/bin/server.dll"

ok=0
fail=0

line() { printf '%s\n' "--------------------------------------------------------------------------------"; }
check_file() {
  local label="$1" file="$2"; shift 2
  line
  echo "[$label] $file"
  if [[ ! -f "$file" ]]; then
    echo "[missing] $file"
    fail=$((fail+1))
    return
  fi
  file "$file" || true
  stat -c '[size] %s bytes' "$file" || true
  sha256sum "$file" | awk '{print "[sha256] "$1}' || true

  local missing=0
  for needle in "$@"; do
    if strings -a "$file" | grep -Fq -- "$needle"; then
      echo "[ok] contains string: $needle"
    else
      echo "[miss] does not contain string: $needle"
      missing=1
    fi
  done

  if [[ "$missing" -eq 0 ]]; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
  fi
}

check_file "Windows/Proton client.dll" "$CLIENT" \
  "ov_join" \
  "ov_auth_steam" \
  "ov_menu" \
  "OpenVibe"

check_file "Windows/Proton server.dll" "$SERVER" \
  "ov_js_status" \
  "ov_js_cmd" \
  "OpenVibe"

line
if [[ "$fail" -eq 0 ]]; then
  echo "[openvibe] DLL content check passed. Proton should load OpenVibe client/server commands if the mod path is correct."
  exit 0
fi

cat <<'MSG'
[openvibe] DLL content check failed.

Meaning:
  - client.dll/server.dll may exist, but they are probably old/stock/unpatched DLLs.
  - If the in-game console says Unknown command "ov_join" or "ov_menu", this is the first thing to fix.

Fix:
  - Trigger the Windows GitHub Actions build, download its artifact, and install the resulting DLLs.
  - Run: tools/gh-windows-build-and-install.sh
MSG
exit 2
