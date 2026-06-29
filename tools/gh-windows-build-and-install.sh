#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git branch --show-current)}"
ART_DIR="$ROOT/.tmp/windows-dll-artifact"
MOD_BIN="$ROOT/game/openvibe.games/bin"

if ! command -v gh >/dev/null 2>&1; then
  cat <<MSG
[openvibe] gh is missing.

Install/authenticate it:
  sudo apt update
  sudo apt install gh
  gh auth login

Then rerun:
  tools/gh-windows-build-and-install.sh

Manual fallback:
  Open GitHub Actions -> $WORKFLOW -> Run workflow -> branch $BRANCH
  Download the artifact, then copy client.dll/server.dll into:
    $MOD_BIN
MSG
  exit 127
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "[openvibe] gh is installed but not authenticated. Run: gh auth login" >&2
  exit 126
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "[openvibe] repo=$repo"
echo "[openvibe] workflow=$WORKFLOW"
echo "[openvibe] branch=$BRANCH"

git push origin "$BRANCH"

echo "[openvibe] triggering Windows DLL workflow"
gh workflow run "$WORKFLOW" --ref "$BRANCH"

echo "[openvibe] waiting for workflow run to appear"
run_id=""
for _ in {1..30}; do
  run_id="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId,status -q '.[0].databaseId // empty' 2>/dev/null || true)"
  [[ -n "$run_id" ]] && break
  sleep 2
done

if [[ -z "$run_id" ]]; then
  echo "[openvibe] could not find workflow run. Check GitHub Actions manually." >&2
  exit 1
fi

echo "[openvibe] watching run $run_id"
gh run watch "$run_id" --exit-status

rm -rf "$ART_DIR"
mkdir -p "$ART_DIR"
echo "[openvibe] downloading artifacts to $ART_DIR"
gh run download "$run_id" --dir "$ART_DIR"

client="$(find "$ART_DIR" -iname 'client.dll' -type f | head -n 1 || true)"
server="$(find "$ART_DIR" -iname 'server.dll' -type f | head -n 1 || true)"

if [[ -z "$client" || -z "$server" ]]; then
  echo "[openvibe] artifact did not contain client.dll and server.dll" >&2
  find "$ART_DIR" -maxdepth 5 -type f | sort >&2
  exit 1
fi

mkdir -p "$MOD_BIN"
cp -f "$client" "$MOD_BIN/client.dll"
cp -f "$server" "$MOD_BIN/server.dll"

echo "[openvibe] installed:"
ls -lh "$MOD_BIN/client.dll" "$MOD_BIN/server.dll"

tools/verify-openvibe-dll-content.sh

echo "[openvibe] done. Now test:"
echo "  OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015"
echo "Then in the game console:"
echo "  ov_join hub"
echo "  ov_menu"
echo "  ov_menu_servers"
