#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" traitortown 27019 tt_openvibe_dev 24 openvibe_traitortown.cfg
