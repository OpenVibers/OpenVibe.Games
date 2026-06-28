#!/usr/bin/env bash
set -euo pipefail

if command -v podman >/dev/null 2>&1 && podman container exists openvibe-postgres; then
  podman stop openvibe-postgres >/dev/null
fi

echo "[openvibe] postgres stopped"
