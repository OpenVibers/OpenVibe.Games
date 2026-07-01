#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="$ROOT/engine/source-sdk-2013"

mkdir -p "$HOME/.ccache"

"$ROOT/tools/apply-openvibe-sdk.sh"

cd "$SDK/src"
dos2unix buildallprojects sdk_container >/dev/null 2>&1 || true
chmod +x buildallprojects sdk_container >/dev/null 2>&1 || true

exec ./buildallprojects
