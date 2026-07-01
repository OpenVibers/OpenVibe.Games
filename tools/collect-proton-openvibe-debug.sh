#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MOD="$ROOT/game/openvibe.games"
STEAM_APP_ID="${SteamAppId:-243750}"
PATTERN='OpenVibe|ov_|client\.dll|server\.dll|GameDLL|ClientDLL|Unknown command|failed|Failed|unable|Unable|error|Error'

printf '[openvibe] collecting Proton/Source debug hints\n'
printf 'root=%s\n' "$ROOT"
printf 'mod=%s\n\n' "$MOD"

candidates=(
  "$MOD/console.log"
  "$MOD/openvibe_proton_console.log"
  "$ROOT/console.log"
  "$ROOT/openvibe_proton_console.log"
  "$HOME/steam-${STEAM_APP_ID}.log"
  "$HOME/steam-${STEAM_APP_ID}.log.last"
)

found=0
for file in "${candidates[@]}"; do
  if [[ -f "$file" ]]; then
    found=1
    echo "--------------------------------------------------------------------------------"
    echo "[log] $file"
    echo "[tail] last matching lines"
    grep -Eia "$PATTERN" "$file" | tail -80 || true
  fi
done

if [[ "$found" -eq 0 ]]; then
  cat <<MSG
No common logs found yet.

Launch with Proton logging enabled:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

Then run this again:
  tools/collect-proton-openvibe-debug.sh
MSG
fi
