#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
export OPENVIBE_ROOT="$ROOT"
export OPENVIBE_CLIENT_UI_HOST="${OPENVIBE_CLIENT_UI_HOST:-127.0.0.1}"
export OPENVIBE_CLIENT_UI_PORT="${OPENVIBE_CLIENT_UI_PORT:-5173}"

exec node "$ROOT/tools/serve-client-ui.mjs"
