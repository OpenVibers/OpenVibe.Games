#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
OUT_DIR="${OPENVIBE_BACKUP_DIR:-$ROOT/backups}"
DATABASE_URL="${DATABASE_URL:-postgres://openvibe:openvibe@127.0.0.1:5432/openvibe}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/openvibe-$STAMP.sql.gz"

mkdir -p "$OUT_DIR"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is required. Install postgresql-client." >&2
  exit 1
fi

pg_dump "$DATABASE_URL" | gzip -9 > "$OUT"
chmod 600 "$OUT"

echo "$OUT"
