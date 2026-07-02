#!/usr/bin/env bash
# Launch an OpenVibe Node.js JS runtime host for a realm.
#   tools/run-js-runtime.sh server sandbox        # server realm, sandbox mode
#   tools/run-js-runtime.sh client sandbox        # client realm
# Ports: server=41999, client=41998 (override with OV_JS_PORT).
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
REALM="${1:-server}"
MODE="${2:-sandbox}"
if [[ "$REALM" == "client" ]]; then PORT="${OV_JS_PORT:-41998}"; else PORT="${OV_JS_PORT:-41999}"; fi
exec node "$ROOT/engine/openvibe-js-runtime/ov-runtime.js" \
  --realm "$REALM" --mode "$MODE" --port "$PORT" --root "$ROOT"
