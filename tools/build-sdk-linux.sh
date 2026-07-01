#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="$ROOT/engine/source-sdk-2013"

mkdir -p "$HOME/.ccache"

"$ROOT/tools/apply-openvibe-sdk.sh"

cd "$SDK/src"
dos2unix buildallprojects sdk_container >/dev/null 2>&1 || true
chmod +x buildallprojects sdk_container >/dev/null 2>&1 || true

# OPENVIBE_LINUX_BUILDCALLPROJECTS_STATUS_GUARD
# Valve's sdk_container/podman wrapper can print "forwarding signal 28 ... container has already been removed"
# after Ninja has already finished successfully. Do not hide real compiler errors, but if the expected
# Linux64 outputs exist, treat that post-build container cleanup status as success.
set +e
./buildallprojects
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  if [[ -f "$SDK/game/mod_hl2mp/bin/linux64/client.so" && \
        -f "$SDK/game/mod_hl2mp/bin/linux64/server.so" && \
        -f "$SDK/game/mod_hl2mp/bin/linux64/game_shader_generic_example.so" ]]; then
    echo "[openvibe warn] buildallprojects exited $status after producing required Linux64 outputs; treating as success"
    exit 0
  fi
  echo "[openvibe error] buildallprojects exited $status and required Linux64 outputs are missing" >&2
  exit "$status"
fi
