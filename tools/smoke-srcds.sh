#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

"$ROOT/tools/setup-openvibe-bin.sh"

run_check() {
  local name="$1"
  local script="$2"
  local map="$3"
  local port_env="$4"
  local smoke_port="$5"
  local log="/tmp/openvibe-srcds-$name.log"

  rm -f "$log"

  set +e
  env "$port_env=$smoke_port" \
    OPENVIBE_CLIENTPORT="$((smoke_port + 1000))" \
    OPENVIBE_TV_PORT="$((smoke_port + 2000))" \
    OPENVIBE_STEAMPORT="$((smoke_port - 115))" \
    timeout "${OPENVIBE_SRCDS_SMOKE_TIMEOUT:-70}s" "$ROOT/tools/$script" >"$log" 2>&1
  local code=$?
  set -e

  if [[ "$code" != "0" && "$code" != "124" ]]; then
    echo "[srcds:$name] failed with exit code $code"
    tail -80 "$log"
    exit 1
  fi

  if grep -Eiq "segmentation fault|core dumped|failed to dlopen|failed to load the launcher|Unable to load Steam support library|Could not load library server" "$log"; then
    echo "[srcds:$name] reported a fatal startup error"
    tail -120 "$log"
    exit 1
  fi

  if grep -Eiq "AN ERROR HAS OCCURRED|Error running script named" "$log"; then
    echo "[srcds:$name] reported a VScript startup error"
    tail -160 "$log"
    exit 1
  fi

  if grep -Eiq "WARNING: Port|Socket bound to non-default|Failed to load 32-bit|CLocalizedStringTable::AddFile|Failed to load custom font|Hud element .*doesn't have an entry|Couldn't parse script sequence|Unknown command|Missing Vgui material|material \".*\" not found" "$log"; then
    echo "[srcds:$name] reported a startup log warning/error"
    grep -Ein "WARNING: Port|Socket bound to non-default|Failed to load 32-bit|CLocalizedStringTable::AddFile|Failed to load custom font|Hud element .*doesn't have an entry|Couldn't parse script sequence|Unknown command|Missing Vgui material|material \".*\" not found" "$log"
    exit 1
  fi

  if ! grep -Eq "Started map \"$map\"|Spawn Server: $map|Loading map \"$map\"|SV_ActivateServer|ov_.*\.nut ready" "$log"; then
    echo "[srcds:$name] did not reach map load for $map"
    tail -120 "$log"
    exit 1
  fi

  echo "[srcds:$name] ok ($map)"
}

BASE_PORT="${OPENVIBE_SRCDS_SMOKE_BASE_PORT:-37015}"

run_check hub run-hub.sh ov_hub OPENVIBE_HUB_PORT "$BASE_PORT"
run_check prophunt run-prophunt.sh ph_openvibe_dev OPENVIBE_PROPHUNT_PORT "$((BASE_PORT + 1))"
run_check deathrun run-deathrun.sh dr_openvibe_dev OPENVIBE_DEATHRUN_PORT "$((BASE_PORT + 2))"
run_check fortwars run-fortwars.sh fw_openvibe_dev OPENVIBE_FORTWARS_PORT "$((BASE_PORT + 3))"
run_check traitortown run-traitortown.sh tt_openvibe_dev OPENVIBE_TRAITORTOWN_PORT "$((BASE_PORT + 4))"
