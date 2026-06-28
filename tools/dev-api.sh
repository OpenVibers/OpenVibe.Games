#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

cd "$ROOT/backend"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

npm run migrate
exec npm run dev
