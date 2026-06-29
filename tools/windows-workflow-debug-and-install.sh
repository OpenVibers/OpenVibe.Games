#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
REPO="${OPENVIBE_GITHUB_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
RUN_ID="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "[openvibe] missing gh. Install with: sudo apt install gh" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi

OUT="$ROOT/artifacts/windows-workflow-debug/run-$RUN_ID-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[openvibe] run=$RUN_ID"
echo "[openvibe] downloading logs/artifacts into $OUT"

gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/full-run.log" || true
gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" || true

find "$OUT" -maxdepth 3 -type f | sort > "$OUT/file-list.txt"

echo
echo "[openvibe] likely errors:"
grep -RniE "error MSB|fatal error|undefined reference|unresolved external|LNK[0-9]+|C[0-9]{4}:|throw |Missing:|not found|could not|failed|No Visual Studio solution|No patched" "$OUT" | tail -n 120 || true

echo
echo "[openvibe] artifact files:"
sed -n '1,160p' "$OUT/file-list.txt"

DLLDIR="$OUT/openvibe-windows-dlls"
if [[ -f "$DLLDIR/client.dll" && -f "$DLLDIR/server.dll" ]]; then
  if strings "$DLLDIR/client.dll" | grep -Eq 'ov_join|ov_menu|OpenVibe'; then
    mkdir -p game/openvibe.games/bin
    cp -f "$DLLDIR/client.dll" game/openvibe.games/bin/client.dll
    cp -f "$DLLDIR/server.dll" game/openvibe.games/bin/server.dll
    echo "[openvibe] installed patched Windows DLLs"
    tools/verify-openvibe-dll-content.sh || true
  else
    echo "[openvibe] refused to install DLL artifact because client.dll lacks OpenVibe strings" >&2
    exit 2
  fi
else
  echo "[openvibe] no DLL artifact available yet" >&2
  exit 3
fi


# Extra bootstrap tails for current Windows workflow debugging.
