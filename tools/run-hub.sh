#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" hub 27015 ov_hub 48 openvibe_hub.cfg
