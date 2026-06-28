#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" fortwars 27018 fw_openvibe_dev 32 openvibe_fortwars.cfg
