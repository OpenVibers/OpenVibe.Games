#!/usr/bin/env bash
# OpenVibe.Games — deploy: a thin wrapper around `ovhost deploy games` (OpenVibe.Host, strategy pnpm-build;
# roadmap WS-N task 11; OpenVibe.Host docs/deploy-strategies.md). Run on the host:
#
#   sudo /opt/openvibe.games/deploy/scripts/deploy.sh               ovhost deploy games
#   sudo /opt/openvibe.games/deploy/scripts/deploy.sh --wait-idle   … --wait-idle (hold until nobody plays)
#   sudo /opt/openvibe.games/deploy/scripts/deploy.sh --restart     … --restart (restart even with nothing new)
#   sudo /opt/openvibe.games/deploy/scripts/deploy.sh --rollback    ovhost rollback games
#   DRY_RUN=1 /opt/openvibe.games/deploy/scripts/deploy.sh          ovhost plan games
#
# ovhost does the production procedure (pull, pnpm install --frozen-lockfile, pnpm build, restart
# openvibe-games) with git as the checkout owner instead of sudo git; every workspace package's
# dependencies checked before the restart (the server applies any new migration at boot); /api/ready polled;
# on failure the checkout restored, reinstalled
# and rebuilt (the build writes the served client) and the unit restarted again (exit 3). Players online are
# reported and reconnect (drain policy report); --wait-idle holds the restart until nobody plays. Do not pull
# by hand first: ovhost would find nothing new (pass --restart if you did).
#
set -euo pipefail

SERVICE=games
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi

CMD=deploy
FLAGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait-idle|--restart|--force) FLAGS+=("$1"); shift ;;
        --rollback) CMD=rollback; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--wait-idle] [--restart] [--force] [--rollback]   (DRY_RUN=1 for the plan)"; exit 1 ;;
    esac
done

if ! command -v "$OVHOST" >/dev/null 2>&1; then
    echo "[games] ✗ ovhost not found ($OVHOST); install or configure ovhost before deploying" >&2
    exit 1
fi

if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"; fi
echo "[games] ovhost $CMD $SERVICE ${FLAGS[*]:-}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
