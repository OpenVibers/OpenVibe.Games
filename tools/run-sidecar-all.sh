#!/usr/bin/env bash
# run-sidecar-all.sh — Send periodic heartbeats for all local servers
set -euo pipefail

API_URL="${OV_API_URL:-http://127.0.0.1:3000}"
SECRET="${OV_SERVER_SECRET:-dev-secret}"

# server_id -> "mode:port:maxPlayers:defaultMap"
declare -A SERVERS=(
  ["local-hub-27015"]="hub:27015:48:ov_hub"
  ["local-prophunt-27016"]="prophunt:27016:24:ph_openvibe_dev"
  ["local-deathrun-27017"]="deathrun:27017:24:dr_openvibe_dev"
  ["local-fortwars-27018"]="fortwars:27018:32:fw_openvibe_dev"
  ["local-traitortown-27019"]="traitortown:27019:24:tt_openvibe_dev"
)

send_heartbeat() {
  local server_id="$1" max_players="$2" map="$3"
  curl -sf -X POST "$API_URL/v1/servers/heartbeat" \
    -H "Content-Type: application/json" \
    -d "{\"serverId\":\"$server_id\",\"serverSecret\":\"$SECRET\",\"playerCount\":0,\"maxPlayers\":$max_players,\"state\":\"open\",\"mapName\":\"$map\"}" \
    > /dev/null 2>&1
}

echo "[sidecar-all] Heartbeat loop started. Interval: 30s"
while true; do
  ok=0; fail=0
  for server_id in "${!SERVERS[@]}"; do
    IFS=':' read -r mode port max_players map <<< "${SERVERS[$server_id]}"
    if send_heartbeat "$server_id" "$max_players" "$map"; then
      ((ok++))
    else
      ((fail++))
      echo "[sidecar-all] Heartbeat failed for $server_id" >&2
    fi
  done
  echo "[sidecar-all] $(date -u +%T) — ok=$ok fail=$fail"
  sleep 30
done
