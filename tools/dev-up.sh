#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for dev-up orchestration." >&2
  exit 1
fi

"$ROOT/tools/dev-db-up.sh"

for session in ov-api ov-client-ui ov-runtime-server ov-runtime-client; do
  if tmux has-session -t "$session" 2>/dev/null; then
    tmux kill-session -t "$session"
  fi
done

tmux new-session -d -s ov-api "$ROOT/tools/dev-api.sh"
tmux new-session -d -s ov-client-ui "$ROOT/tools/run-client-ui.sh"

# GModJS Node runtimes: back the GUI console (SSE logs + eval + npm on
# 41997/41996) and serve as the game bridge when ov_js_backend is "node".
OV_RUNTIME_MODE="${OPENVIBE_RUNTIME_MODE:-hub}"
tmux new-session -d -s ov-runtime-server \
  "node '$ROOT/engine/openvibe-js-runtime/ov-runtime.js' --realm server --mode $OV_RUNTIME_MODE --root '$ROOT'"
tmux new-session -d -s ov-runtime-client \
  "node '$ROOT/engine/openvibe-js-runtime/ov-runtime.js' --realm client --mode $OV_RUNTIME_MODE --root '$ROOT'"

echo "[openvibe] waiting for api"
for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

"$ROOT/tools/register-local-servers.sh"
"$ROOT/tools/setup-openvibe-bin.sh"

declare -A sessions=(
  [ov-hub]=run-hub.sh
  [ov-prophunt]=run-prophunt.sh
  [ov-deathrun]=run-deathrun.sh
  [ov-fortwars]=run-fortwars.sh
  [ov-traitortown]=run-traitortown.sh
)

declare -A sidecars=(
  [ov-sidecar-hub]="local-hub-27015 hub 27015 48"
  [ov-sidecar-prophunt]="local-prophunt-27016 prophunt 27016 24"
  [ov-sidecar-deathrun]="local-deathrun-27017 deathrun 27017 24"
  [ov-sidecar-fortwars]="local-fortwars-27018 fortwars 27018 32"
  [ov-sidecar-traitortown]="local-traitortown-27019 traitortown 27019 24"
)

for session in "${!sessions[@]}" "${!sidecars[@]}"; do
  tmux kill-session -t "$session" 2>/dev/null || true
done

if compgen -G "$ROOT/game/openvibe.games/maps/*.bsp" >/dev/null; then
  for session in "${!sessions[@]}"; do
    tmux new-session -d -s "$session" "$ROOT/tools/${sessions[$session]}"
  done

  for session in "${!sidecars[@]}"; do
    # shellcheck disable=SC2086
    tmux new-session -d -s "$session" "$ROOT/tools/run-sidecar.sh ${sidecars[$session]}"
  done
else
  echo "[openvibe] no BSP maps found yet; skipping SRCDS and sidecar startup"
fi

echo "[openvibe] running sessions:"
tmux ls || true
