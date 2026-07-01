#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
BRANCH="${OPENVIBE_BRANCH:-$(git -C "$ROOT" branch --show-current 2>/dev/null || true)}"
REPO="${REPO%.git}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
ARTIFACT_DIR="$ROOT/.tmp/windows-dll-artifacts"
MOD_BIN="$ROOT/game/openvibe.games/bin"

cd "$ROOT"

echo "[openvibe] next phase: finalize multiplatform support + trigger Windows DLL build"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=${BRANCH:-unknown}"

if [[ -z "${BRANCH:-}" ]]; then
  echo "Could not determine current git branch." >&2
  exit 1
fi

echo
echo "[openvibe] current repo state:"
git status --short

echo
echo "[openvibe] staging all intended platform/build helper changes"

# Stage the files created/modified by the prior multiplatform/loading scripts.
# This intentionally avoids generated SDK engine outputs and binary DLL/SO artifacts.
paths=(
  ".github/workflows/windows-source-sdk-dlls.yml"
  "docs/BUILD_WINDOWS_DLLS_FROM_LINUX.md"
  "docs/MULTIPLATFORM_SOURCE_BUILDS.md"
  "launcher/main.js"
  "tools/add-multiplatform-sdk-support.sh"
  "tools/build-quickjs-lib-windows.ps1"
  "tools/build-sdk-all-local.sh"
  "tools/build-sdk-windows.ps1"
  "tools/build-windows-dlls-from-linux-workflow.sh"
  "tools/check-openvibe-platform-binaries.sh"
  "tools/fix-launch-loading-and-explain-clientdll.sh"
  "tools/fix-proton-loading-and-menu-fallback.sh"
  "tools/probe-local-windows-build-on-linux.sh"
  "tools/request-windows-dll-build.sh"
  "tools/run-client-auto.sh"
  "tools/run-client-linux.sh"
  "tools/run-client-proton.sh"
  "tools/run-client-windows.ps1"
  "tools/setup-openvibe-bin.sh"
  "tools/apply-openvibe-sdk.sh"
  "game/openvibe.games/cfg/openvibe_proton_client.cfg"
  "game/openvibe.games/resource/LoadingDialog.res"
  "game/openvibe.games/materialsrc/console/openvibe-loading.svg"
)

for p in "${paths[@]}"; do
  if [[ -e "$p" ]]; then
    git add "$p"
  fi
done

# Also stage removals among tracked files in those areas.
git add -u launcher tools docs .github game/openvibe.games/cfg game/openvibe.games/resource game/openvibe.games/materialsrc 2>/dev/null || true

echo
echo "[openvibe] staged changes:"
git diff --cached --stat || true

if git diff --cached --quiet; then
  echo "[openvibe] no staged changes to commit"
else
  msg="${OPENVIBE_COMMIT_MESSAGE:-Finalize multiplatform client runtime support}"
  echo "[openvibe] committing: $msg"
  git commit -m "$msg"
fi

echo
echo "[openvibe] pushing branch $BRANCH"
git push origin "$BRANCH"

echo
echo "[openvibe] local platform probe"
if [[ -x tools/probe-local-windows-build-on-linux.sh ]]; then
  tools/probe-local-windows-build-on-linux.sh || true
fi

if [[ -x tools/check-openvibe-platform-binaries.sh ]]; then
  tools/check-openvibe-platform-binaries.sh || true
fi

echo
echo "[openvibe] workflow trigger phase"

if ! command -v gh >/dev/null 2>&1; then
  cat <<'MSG'
[openvibe] GitHub CLI 'gh' is not installed, so I cannot trigger/download the Windows build from here.

Install/authenticate it, then run:
  sudo apt install gh
  gh auth login
  tools/request-windows-dll-build.sh

Or open GitHub Actions manually and run:
  windows-source-sdk-dlls.yml
MSG
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'
[openvibe] gh exists but is not authenticated.

Run:
  gh auth login

Then rerun this script:
  tools/next-phase-platform-build-and-fetch.sh
MSG
  exit 0
fi

if ! gh workflow view "$WORKFLOW" >/dev/null 2>&1; then
  cat <<MSG
[openvibe] workflow $WORKFLOW is not visible yet.
This can happen right after pushing a new workflow.

Wait 30-60 seconds, then rerun:
  tools/next-phase-platform-build-and-fetch.sh
MSG
  exit 0
fi

echo "[openvibe] triggering workflow $WORKFLOW on $BRANCH"
gh workflow run "$WORKFLOW" --ref "$BRANCH"

echo "[openvibe] waiting for GitHub to create the workflow run"
sleep 10

run_id=""
for _ in {1..18}; do
  run_id="$(gh run list \
    --workflow "$WORKFLOW" \
    --branch "$BRANCH" \
    --limit 1 \
    --json databaseId,status,conclusion,createdAt \
    --jq '.[0].databaseId // empty' 2>/dev/null || true)"

  if [[ -n "$run_id" ]]; then
    break
  fi

  sleep 5
done

if [[ -z "$run_id" ]]; then
  echo "[openvibe] could not find workflow run id. Check manually:"
  echo "  gh run list --workflow $WORKFLOW --branch $BRANCH"
  exit 1
fi

echo "[openvibe] watching workflow run: $run_id"
if ! gh run watch "$run_id" --exit-status; then
  echo
  echo "[openvibe] Windows DLL workflow failed. Inspect with:"
  echo "  gh run view $run_id --log-failed"
  exit 1
fi

echo
echo "[openvibe] downloading artifacts from run $run_id"
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
gh run download "$run_id" -D "$ARTIFACT_DIR"

echo
echo "[openvibe] downloaded artifact tree:"
find "$ARTIFACT_DIR" -maxdepth 4 -type f | sort

client_dll="$(find "$ARTIFACT_DIR" -type f -iname 'client.dll' | head -n 1 || true)"
server_dll="$(find "$ARTIFACT_DIR" -type f -iname 'server.dll' | head -n 1 || true)"

if [[ -z "$client_dll" || -z "$server_dll" ]]; then
  echo
  echo "[openvibe] artifact did not contain both client.dll and server.dll."
  echo "Paste this output plus:"
  echo "  gh run view $run_id --log"
  exit 1
fi

mkdir -p "$MOD_BIN"
cp -f "$client_dll" "$MOD_BIN/client.dll"
cp -f "$server_dll" "$MOD_BIN/server.dll"

echo
echo "[openvibe] installed Windows/Proton DLLs:"
ls -lh "$MOD_BIN/client.dll" "$MOD_BIN/server.dll"

if command -v file >/dev/null 2>&1; then
  file "$MOD_BIN/client.dll" "$MOD_BIN/server.dll" || true
fi

echo
if [[ -x tools/check-openvibe-platform-binaries.sh ]]; then
  tools/check-openvibe-platform-binaries.sh || true
fi

cat <<'MSG'

[openvibe] next runtime test:

  OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

In the game console test:

  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers

If those still say Unknown command, the DLL either failed to load or the artifact is not the patched OpenVibe client.dll.
Check Source console for client.dll load errors and run:

  file game/openvibe.games/bin/client.dll
  strings game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu' | head
MSG
