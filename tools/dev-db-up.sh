#!/usr/bin/env bash
set -euo pipefail

if ! command -v podman >/dev/null 2>&1; then
  echo "podman is required for the local OpenVibe dev database." >&2
  exit 1
fi

podman volume exists openvibe_pg >/dev/null 2>&1 || podman volume create openvibe_pg >/dev/null

if ! podman container exists openvibe-postgres; then
  podman run -d \
    --name openvibe-postgres \
    -e POSTGRES_USER=openvibe \
    -e POSTGRES_PASSWORD=openvibe \
    -e POSTGRES_DB=openvibe \
    -p 5432:5432 \
    -v openvibe_pg:/var/lib/postgresql/data \
    docker.io/library/postgres:16 >/dev/null
else
  podman start openvibe-postgres >/dev/null
fi

echo "[openvibe] waiting for postgres"
for _ in {1..60}; do
  if podman exec openvibe-postgres pg_isready -U openvibe -d openvibe >/dev/null 2>&1; then
    echo "[openvibe] postgres ready"
    exit 0
  fi
  sleep 1
done

echo "postgres did not become ready in time" >&2
exit 1
