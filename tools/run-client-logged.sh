#!/usr/bin/env bash
# OpenVibe client launcher with unified logging.
#
# Captures BOTH streams into artifacts/client-logs/ so the game can be monitored
# and self-improved from one place:
#   - proton-latest.log : Proton/DXVK/wine stdout+stderr from this launch
#   - console-latest.log : the in-game Source console (-condebug), copied live
# Also keeps timestamped copies. Usage mirrors run-client-proton-x64.sh:
#   tools/run-client-logged.sh                 # auto: connect local sandbox or load ov_hub
#   tools/run-client-logged.sh 127.0.0.1 27020 # connect to a specific server
#   OPENVIBE_STARTUP_MAP=ov_hub tools/run-client-logged.sh   # local listen world
set -uo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
GAME_CONSOLE="$ROOT/game/openvibe.games/console.log"
LOGDIR="$ROOT/artifacts/client-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
PROTON_LOG="$LOGDIR/proton-$TS.log"
CONSOLE_COPY="$LOGDIR/console-$TS.log"

# Fresh game console each launch so console-latest.log is only this session.
: > "$GAME_CONSOLE" 2>/dev/null || true

ln -sf "$(basename "$PROTON_LOG")"  "$LOGDIR/proton-latest.log"
ln -sf "$(basename "$CONSOLE_COPY")" "$LOGDIR/console-latest.log"

echo "[openvibe] client logs:"
echo "  proton : $LOGDIR/proton-latest.log"
echo "  console: $LOGDIR/console-latest.log"

# Mirror the in-game console.log into the timestamped copy live.
( tail -F "$GAME_CONSOLE" 2>/dev/null > "$CONSOLE_COPY" ) &
TAIL_PID=$!

# Launch the real client, tee Proton output to the stable log.
"$ROOT/tools/run-client-proton-x64.sh" "$@" 2>&1 | tee "$PROTON_LOG"

kill "$TAIL_PID" 2>/dev/null || true
