#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

"$ROOT/tools/setup-openvibe-bin.sh"

run_check() {
  local name="$1"
  local script="$2"
  local map="$3"
  local log="/tmp/openvibe-srcds-$name.log"

  set +e
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

  if ! grep -Eq "Started map \"$map\"|Spawn Server: $map|Loading map \"$map\"|SV_ActivateServer" "$log"; then
    echo "[srcds:$name] did not reach map load for $map"
    tail -120 "$log"
    exit 1
  fi

  echo "[srcds:$name] ok ($map)"
}

run_check hub run-hub.sh ov_hub
run_check prophunt run-prophunt.sh ph_openvibe_dev
run_check deathrun run-deathrun.sh dr_openvibe_dev
run_check fortwars run-fortwars.sh fw_openvibe_dev
run_check traitortown run-traitortown.sh tt_openvibe_dev
