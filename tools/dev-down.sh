#!/usr/bin/env bash
set -euo pipefail

for session in ov-api ov-hub ov-prophunt ov-deathrun ov-fortwars ov-traitortown; do
  tmux kill-session -t "$session" 2>/dev/null || true
done

"${OPENVIBE_ROOT:-$HOME/src/openvibe-source}/tools/dev-db-down.sh"
