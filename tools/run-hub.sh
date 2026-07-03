#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" hub "${OPENVIBE_HUB_PORT:-27015}" ov_hub "${OPENVIBE_HUB_MAXPLAYERS:-48}" openvibe_hub.cfg
