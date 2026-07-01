#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
echo "[openvibe] installed DLL architecture/content"
file game/openvibe.games/bin/client.dll game/openvibe.games/bin/server.dll || true
strings -a game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|ov_auth_steam|OpenVibe' | head -20 || true
strings -a game/openvibe.games/bin/server.dll | grep -E 'ov_js_status|ov_js_cmd|OpenVibe' | head -20 || true
cat <<'MSG'
[openvibe] launch command:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

[openvibe] in-game console smoke test:
  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers
  ov_auth_steam

[openvibe] if those are still Unknown command, collect Proton load logs:
  tools/collect-proton-openvibe-debug.sh
MSG
