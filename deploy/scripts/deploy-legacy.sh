#!/usr/bin/env bash
# OpenVibe.Games — the production deploy as it was done by hand before `ovhost deploy games`, kept as the
# fallback of deploy/scripts/deploy.sh (roadmap WS-N task 11). The same commands, in the same order:
#
#   sudo git -c safe.directory=/opt/openvibe.games pull
#   pnpm install --frozen-lockfile
#   pnpm build
#   sudo systemctl restart openvibe-games
#
# plus a readiness wait and the best-effort release notification the other repositories' scripts send. It
# has no protected-session check, no dependency check and no rollback: ovhost has those.
set -euo pipefail
REPO="${REPO:-/opt/openvibe.games}"
READY_URL="${READY_URL:-http://127.0.0.1:8000/api/ready}"
cd "$REPO"
sudo git -c safe.directory="$REPO" pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart openvibe-games
for _ in $(seq 1 60); do
    if curl -sf --max-time 2 "$READY_URL" >/dev/null; then echo "[games] ready ($(git -c safe.directory="$REPO" rev-parse --short=12 HEAD))"; break; fi
    sleep 1
done
curl -sf --max-time 2 "$READY_URL" >/dev/null || { echo "[games] ✗ not ready after 60 s: journalctl -u openvibe-games -n 50" >&2; exit 3; }
# Release notification (WS-P task 9): best effort, skipped without an ovhost that has `announce`.
OVHOST_BIN=$(command -v "${OVHOST:-ovhost}" 2>/dev/null || true)
if [ -n "$OVHOST_BIN" ]; then
    case "$("$OVHOST_BIN" --help 2>/dev/null || true)" in
        *"announce <service>"*)
            SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
            timeout 20 $SUDO "$OVHOST_BIN" announce games 2>&1 || echo "release notification not sent (the deploy stands)" ;;
        *) echo "release notification skipped: this ovhost has no announce" ;;
    esac
fi
exit 0
