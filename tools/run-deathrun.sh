#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" deathrun 27017 dr_openvibe_dev 24 openvibe_deathrun.cfg
