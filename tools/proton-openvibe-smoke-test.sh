#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
HOST="${1:-127.0.0.1}"
PORT="${2:-27015}"

echo "[openvibe] smoke test root=$ROOT"
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
fi

if [[ -x tools/check-openvibe-platform-binaries.sh ]]; then
  tools/check-openvibe-platform-binaries.sh || true
fi

cat <<EOF
[openvibe] Windows DLLs are installed. Next in-game console checks:
  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers
  ov_auth_steam

[openvibe] To launch now, run:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh $HOST $PORT
EOF

if [[ "${OPENVIBE_RUN_GAME:-0}" == "1" ]]; then
  echo "[openvibe] OPENVIBE_RUN_GAME=1 set; launching Proton client"
  OPENVIBE_PROTON_LOG="${OPENVIBE_PROTON_LOG:-1}" OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh "$HOST" "$PORT"
fi
