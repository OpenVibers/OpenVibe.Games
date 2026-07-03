#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" traitortown "${OPENVIBE_TRAITORTOWN_PORT:-27019}" tt_openvibe_dev "${OPENVIBE_TRAITORTOWN_MAXPLAYERS:-24}" openvibe_traitortown.cfg
