#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" deathrun "${OPENVIBE_DEATHRUN_PORT:-27017}" dr_openvibe_dev "${OPENVIBE_DEATHRUN_MAXPLAYERS:-24}" openvibe_deathrun.cfg
