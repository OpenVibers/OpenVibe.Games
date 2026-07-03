#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" fortwars "${OPENVIBE_FORTWARS_PORT:-27018}" fw_openvibe_dev "${OPENVIBE_FORTWARS_MAXPLAYERS:-32}" openvibe_fortwars.cfg
