#!/usr/bin/env bash
# OpenVibe: Source — One-shot launcher
# Starts API (if not running), hub SRCDS (if not running), then opens the Electron menu

set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LAUNCHER_DIR="$ROOT/launcher"

export OPENVIBE_ROOT="$ROOT"
export OPENVIBE_SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"

echo "=== OpenVibe: Source ==="
echo "ROOT: $ROOT"
echo ""

# ── 1. Database ───────────────────────────────────────────────────────────────
echo "[1/4] Checking database…"
if podman container exists openvibe-postgres 2>/dev/null; then
  podman start openvibe-postgres >/dev/null 2>&1 || true
  for i in {1..20}; do
    podman exec openvibe-postgres pg_isready -U openvibe -d openvibe >/dev/null 2>&1 && break || sleep 1
  done
  echo "      ✓ PostgreSQL ready"
else
  echo "      ⚠️  No postgres container — using in-memory backend"
fi

# ── 2. API ────────────────────────────────────────────────────────────────────
echo "[2/4] Checking API…"
if curl -fs http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "      ✓ API already running"
else
  echo "      Starting API…"
  cd "$ROOT/backend"
  [[ ! -f .env ]] && cp .env.example .env 2>/dev/null || true
  npm run migrate >/dev/null 2>&1 || true
  npm run dev > /tmp/ov-api.log 2>&1 &
  API_PID=$!
  echo "      API PID: $API_PID"
  for i in {1..30}; do
    curl -fs http://127.0.0.1:3000/health >/dev/null 2>&1 && break || sleep 1
  done
  if curl -fs http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "      ✓ API started"
  else
    echo "      ⚠️  API failed to start (check /tmp/ov-api.log)"
  fi
  cd "$ROOT"
fi

# Register servers with API
"$ROOT/tools/register-local-servers.sh" >/dev/null 2>&1 || true

# ── 3. Hub SRCDS ──────────────────────────────────────────────────────────────
echo "[3/4] Checking Hub SRCDS…"
if ss -tulnp 2>/dev/null | grep -q ':27015'; then
  echo "      ✓ Hub already running on :27015"
else
  if [[ -f "$ROOT/game/openvibe.games/maps/ov_hub.bsp" ]]; then
    "$ROOT/tools/setup-openvibe-bin.sh" >/dev/null 2>&1 || true
    "$ROOT/tools/run-server.sh" hub 27015 ov_hub 48 openvibe_hub.cfg \
      > /tmp/ov-hub.log 2>&1 &
    echo "      Hub PID: $!"
    sleep 4
    if ss -tulnp 2>/dev/null | grep -q ':27015'; then
      echo "      ✓ Hub SRCDS started on :27015"
    else
      echo "      ⚠️  Hub SRCDS failed (check /tmp/ov-hub.log)"
    fi
  else
    echo "      ⚠️  No ov_hub.bsp — skipping SRCDS (compile maps first)"
  fi
fi

# ── 4. Electron launcher ──────────────────────────────────────────────────────
echo "[4/4] Launching OpenVibe menu (embedded Chromium via Electron)…"
echo ""

cd "$LAUNCHER_DIR"

exec node_modules/.bin/electron . \
  --no-sandbox \
  --disable-gpu-sandbox \
  --display="${DISPLAY:-:0}"
