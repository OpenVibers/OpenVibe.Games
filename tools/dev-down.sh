#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MOD="$ROOT/game/openvibe.games"

sessions=(
  ov-api
  ov-hub
  ov-prophunt
  ov-deathrun
  ov-fortwars
  ov-traitortown
  ov-sidecar-hub
  ov-sidecar-prophunt
  ov-sidecar-deathrun
  ov-sidecar-fortwars
  ov-sidecar-traitortown
)

for session in "${sessions[@]}"; do
  tmux kill-session -t "$session" 2>/dev/null || true
done

kill_matching() {
  local signal="$1"
  local pattern="$2"
  (pgrep -f "$pattern" 2>/dev/null || true) | while read -r pid; do
    if [[ "$pid" != "$$" ]]; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

kill_matching TERM "srcds_linux64 -game $MOD"
kill_matching TERM "$ROOT/tools/ov-sidecar.mjs"
kill_matching TERM "$ROOT/tools/dev-api.sh"
kill_matching TERM "$ROOT/backend/node_modules/.bin/tsx watch src/index.ts"

sleep 1

kill_matching KILL "srcds_linux64 -game $MOD"
kill_matching KILL "$ROOT/tools/ov-sidecar.mjs"
kill_matching KILL "$ROOT/tools/dev-api.sh"
kill_matching KILL "$ROOT/backend/node_modules/.bin/tsx watch src/index.ts"

"$ROOT/tools/dev-db-down.sh"
