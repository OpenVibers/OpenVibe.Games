#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" prophunt "${OPENVIBE_PROPHUNT_PORT:-27016}" ph_openvibe_dev "${OPENVIBE_PROPHUNT_MAXPLAYERS:-24}" openvibe_prophunt.cfg
