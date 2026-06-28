#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
API="${OPENVIBE_API_URL:-http://127.0.0.1:3000}"

node "$ROOT/tools/register-local-servers.mjs" "$API" "$ROOT/servers/local-servers.json"
