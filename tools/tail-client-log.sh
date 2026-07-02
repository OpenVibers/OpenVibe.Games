#!/usr/bin/env bash
# Tail the latest OpenVibe client logs (in-game console + Proton output).
# Usage: tools/tail-client-log.sh [console|proton|both]
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
LOGDIR="$ROOT/artifacts/client-logs"
WHICH="${1:-console}"
case "$WHICH" in
  console) exec tail -F "$LOGDIR/console-latest.log" ;;
  proton)  exec tail -F "$LOGDIR/proton-latest.log" ;;
  both)    exec tail -F "$LOGDIR/console-latest.log" "$LOGDIR/proton-latest.log" ;;
  *) echo "usage: $0 [console|proton|both]" >&2; exit 2 ;;
esac
