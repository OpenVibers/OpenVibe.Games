#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

REPO="${REPO%.git}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
ARTIFACT="${OPENVIBE_WINDOWS_ARTIFACT:-openvibe-windows-dlls}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
OUT_DIR="${OPENVIBE_WINDOWS_ARTIFACT_DIR:-$ROOT/.tmp/windows-dll-artifact}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing GitHub CLI: gh" >&2
  echo "Install it, then run: gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[openvibe] WARNING: working tree has uncommitted changes."
  echo "[openvibe] GitHub Actions builds the pushed branch, not your uncommitted local files."
  echo
  git status --short
  echo
  read -r -p "Continue anyway? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

echo "[openvibe] triggering GitHub Actions Windows DLL build"
echo "[openvibe] workflow=$WORKFLOW branch=$BRANCH"

gh workflow run "$WORKFLOW" --ref "$BRANCH"

echo "[openvibe] waiting for run to appear..."
RUN_ID=""
for _ in {1..30}; do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId,status,event -q '.[0].databaseId // empty' 2>/dev/null || true)"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done

if [[ -z "$RUN_ID" ]]; then
  echo "Could not find the workflow run. Check GitHub Actions UI." >&2
  exit 1
fi

echo "[openvibe] watching run $RUN_ID"
gh run watch "$RUN_ID" --exit-status

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "[openvibe] downloading artifact $ARTIFACT"
gh run download "$RUN_ID" --name "$ARTIFACT" --dir "$OUT_DIR"

echo "[openvibe] downloaded files:"
find "$OUT_DIR" -type f -maxdepth 8 -print | sort

echo
echo "[openvibe] installing Windows DLLs into game/openvibe.games/bin"
mkdir -p "$ROOT/game/openvibe.games/bin"

find "$OUT_DIR" -type f \( -iname 'client.dll' -o -iname 'server.dll' -o -iname 'client.pdb' -o -iname 'server.pdb' \) -print0 |
while IFS= read -r -d '' file; do
  cp -f "$file" "$ROOT/game/openvibe.games/bin/$(basename "$file")"
  echo "  installed $(basename "$file")"
done

echo
"$ROOT/tools/check-openvibe-platform-binaries.sh" || true

echo
echo "[openvibe] done."
echo "Proton/Windows can use:"
echo "  game/openvibe.games/bin/client.dll"
echo "  game/openvibe.games/bin/server.dll"
