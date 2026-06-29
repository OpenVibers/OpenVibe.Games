#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
REPO="${OPENVIBE_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
OUT="$ROOT/artifacts/windows-workflow-debug"
cd "$ROOT"
mkdir -p "$OUT"
run="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "[openvibe] latest run=$run"
gh run view "$run" --repo "$REPO" --log > "$OUT/run-${run}.log" 2>&1 || true
gh run view "$run" --repo "$REPO" --log-failed > "$OUT/run-${run}-failed.log" 2>&1 || true
gh run download "$run" --repo "$REPO" --dir "$OUT/run-${run}-artifacts" || true
printf '\n[openvibe] tail of failed log:\n'
tail -n 160 "$OUT/run-${run}-failed.log" || true
printf '\n[openvibe] artifacts saved under: %s\n' "$OUT/run-${run}-artifacts"
if [[ -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/client.dll" && -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/server.dll" ]]; then
  mkdir -p game/openvibe.games/bin
  cp -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/client.dll" game/openvibe.games/bin/client.dll
  cp -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/server.dll" game/openvibe.games/bin/server.dll
  echo "[openvibe] installed DLL artifacts"
  tools/verify-openvibe-dll-content.sh || true
else
  echo "[openvibe] no DLL artifact available yet; check debug artifact/logs"
fi
