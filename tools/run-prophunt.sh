#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/run-server.sh" prophunt 27016 ph_openvibe_dev 24 openvibe_prophunt.cfg
