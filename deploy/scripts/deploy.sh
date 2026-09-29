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
# dependencies checked and better-sqlite3 loaded under this Node before the restart; /api/ready polled;
# on failure the checkout restored, reinstalled
# and rebuilt (the build writes the served client) and the unit restarted again (exit 3). Players online are
# reported and reconnect (drain policy report); --wait-idle holds the restart until nobody plays. Do not pull
# by hand first: ovhost would find nothing new (pass --restart if you did).
#
# Fallback: deploy-legacy.sh (the procedure as it was run by hand) when ovhost is missing or too old (no
# `capabilities`, deploy-api < 1), or the host inventory does not deploy games with strategy pnpm-build;
# OVHOST_LEGACY=1 forces it. It takes no flags: --rollback, --wait-idle and DRY_RUN=1 are refused there.
set -euo pipefail

SERVICE=games
STRATEGY=pnpm-build
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEGACY="${DEPLOY_LEGACY:-$HERE/deploy-legacy.sh}"
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

legacy() {
    echo "[games] $1 — running deploy-legacy.sh (the previous deploy procedure) instead"
    if [ "$CMD" = rollback ] || [ "${DRY_RUN:-0}" = 1 ] || [[ " ${FLAGS[*]:-} " == *" --wait-idle "* ]]; then
        echo "[games] ✗ deploy-legacy.sh has no --rollback, --wait-idle or DRY_RUN; nothing was done" >&2
        exit 1
    fi
    exec bash "$LEGACY"
}

REASON=""
probe() {
    if [ "${OVHOST_LEGACY:-0}" = 1 ]; then REASON="OVHOST_LEGACY=1"; return 1; fi
    if ! command -v "$OVHOST" >/dev/null 2>&1; then REASON="ovhost not found ($OVHOST)"; return 1; fi
    local caps api
    if ! caps=$("${SUDO[@]}" "$OVHOST" capabilities "$SERVICE" 2>/dev/null); then REASON="this ovhost has no 'capabilities' (too old) or no inventory entry for $SERVICE"; return 1; fi
    api=$(printf '%s\n' "$caps" | sed -n 's/^deploy-api=//p')
    case "$api" in ''|*[!0-9]*) REASON="this ovhost reports no deploy-api (too old)"; return 1 ;; esac
    if [ "$api" -lt 1 ]; then REASON="this ovhost's deploy-api is $api, 1 is needed"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "strategy=$STRATEGY"; then REASON="the host inventory does not deploy $SERVICE with strategy $STRATEGY ($(printf '%s\n' "$caps" | sed -n 's/^strategy=//p'))"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "managed=yes"; then REASON="ovhost does not manage $SERVICE"; return 1; fi
    return 0
}

probe || legacy "$REASON"

if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"; fi
echo "[games] ovhost $CMD $SERVICE ${FLAGS[*]:-}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
