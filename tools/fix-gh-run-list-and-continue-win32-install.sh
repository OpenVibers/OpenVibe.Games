#!/usr/bin/env bash
set -euo pipefail

say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
fatal() { echo "[openvibe error] $*" >&2; exit 1; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
if [[ -x tools/openvibe-gh-repo.sh ]]; then
  REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
else
  REPO="${OPENVIBE_REPO:-$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')}"
fi

say "fix gh run list --commit + continue Win32 DLL install"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"
say "workflow=$WORKFLOW"

command -v gh >/dev/null 2>&1 || fatal "gh is missing"
command -v git >/dev/null 2>&1 || fatal "git is missing"
command -v file >/dev/null 2>&1 || fatal "file is missing"
command -v strings >/dev/null 2>&1 || fatal "strings is missing"

# The previous script used `gh run list sha ...`, which is not a gh command.
# Patch any committed helper scripts so future runs use `--commit`.
changed=0
for f in \
  tools/next-phase-build-win32-proton-dlls-and-install.sh \
  tools/install-latest-openvibe-windows-dlls.sh \
  tools/windows-workflow-debug-and-install.sh \
  tools/gh-windows-build-and-install.sh; do
  [[ -f "$f" ]] || continue
  before="$(sha256sum "$f" | awk '{print $1}')"
  perl -0pi -e 's/gh\s+run\s+list\s+sha\b/gh run list --commit/g; s/gh\s+run\s+list\s+--sha\b/gh run list --commit/g; s/gh\s+run\s+list\s+-S\b/gh run list --commit/g' "$f"
  after="$(sha256sum "$f" | awk '{print $1}')"
  if [[ "$before" != "$after" ]]; then
    say "patched $f"
    changed=1
  fi
done

# Add a tiny doc so the fix is not mystery state.
mkdir -p docs
cat > docs/WINDOWS_GH_RUN_LIST_COMMIT_FIX.md <<'DOC'
# Windows DLL workflow run lookup fix

GitHub CLI uses `gh run list --commit <sha>` to filter by commit. A previous helper accidentally used `gh run list sha <sha>`, which aborts after triggering the workflow. The Win32 DLL build can still be continued by finding the workflow run with `--commit`, downloading `openvibe-windows-dlls`, rejecting PE32+ x64 DLLs, and installing only PE32 x86 DLLs.
DOC

if [[ "$changed" -eq 1 || -n "$(git status --short docs/WINDOWS_GH_RUN_LIST_COMMIT_FIX.md 2>/dev/null || true)" ]]; then
  git add docs/WINDOWS_GH_RUN_LIST_COMMIT_FIX.md \
    tools/next-phase-build-win32-proton-dlls-and-install.sh \
    tools/install-latest-openvibe-windows-dlls.sh \
    tools/windows-workflow-debug-and-install.sh \
    tools/gh-windows-build-and-install.sh 2>/dev/null || true
  if ! git diff --cached --quiet; then
    git commit -m "Fix GitHub Actions run lookup for Win32 DLL install"
    git push origin "$BRANCH"
  else
    say "no helper-script changes to commit"
  fi
fi

HEAD_SHA="$(git rev-parse HEAD)"
say "head=$HEAD_SHA"

# Trigger a clean run for the current fixed HEAD. The previous run may already exist,
# but a new run avoids ambiguity after committing the helper fix.
say "triggering workflow_dispatch"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"

RUN_ID=""
for i in $(seq 1 90); do
  RUN_ID="$(gh run list \
    --repo "$REPO" \
    --workflow "$WORKFLOW" \
    --branch "$BRANCH" \
    --commit "$HEAD_SHA" \
    --limit 20 \
    --json databaseId,headSha,createdAt,event,status,conclusion \
    --jq 'map(select(.headSha == "'"$HEAD_SHA"'")) | sort_by(.createdAt) | reverse | .[0].databaseId // empty' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    break
  fi
  sleep 4
done

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  warn "could not find run by --commit; falling back to latest run on branch"
  RUN_ID="$(gh run list \
    --repo "$REPO" \
    --workflow "$WORKFLOW" \
    --branch "$BRANCH" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // empty')"
fi

[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fatal "could not find workflow run"
say "watching run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  warn "workflow failed; downloading diagnostics"
  if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
    tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  fi
  fatal "Win32 DLL workflow failed"
fi

say "workflow passed; downloading DLL artifact"
OUT="$ROOT/artifacts/win32-openvibe-dll-install/run-$RUN_ID"
rm -rf "$OUT"
mkdir -p "$OUT"

if ! gh run download "$RUN_ID" --repo "$REPO" --name openvibe-windows-dlls --dir "$OUT" >/dev/null; then
  warn "named DLL artifact download failed; downloading all artifacts"
  gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" >/dev/null
fi
find "$OUT" -type f | sort > "$OUT/file-list.txt"

CLIENT="$(find "$OUT" -type f -iname client.dll | sort | head -n1 || true)"
SERVER="$(find "$OUT" -type f -iname server.dll | sort | head -n1 || true)"
[[ -n "$CLIENT" && -f "$CLIENT" ]] || fatal "client.dll not found in artifact. See $OUT/file-list.txt"
[[ -n "$SERVER" && -f "$SERVER" ]] || fatal "server.dll not found in artifact. See $OUT/file-list.txt"

say "candidate client=$CLIENT"
say "candidate server=$SERVER"
file "$CLIENT"
file "$SERVER"

client_file="$(file "$CLIENT")"
server_file="$(file "$SERVER")"
if grep -Fq 'PE32+' <<<"$client_file$server_file"; then
  fatal "artifact is still x64 PE32+; refusing to install into 32-bit Proton Source SDK Base"
fi
if ! grep -Eq 'PE32 executable.*Intel 80386' <<<"$client_file"; then
  fatal "client.dll is not 32-bit PE32 Intel 80386"
fi
if ! grep -Eq 'PE32 executable.*Intel 80386' <<<"$server_file"; then
  fatal "server.dll is not 32-bit PE32 Intel 80386"
fi

check_strings() {
  local f="$1"; shift
  local missing=0
  for s in "$@"; do
    if strings -a "$f" | grep -Fq -- "$s"; then
      echo "[ok] $(basename "$f") contains $s"
    else
      echo "[miss] $(basename "$f") missing $s" >&2
      missing=1
    fi
  done
  return "$missing"
}

check_strings "$CLIENT" ov_join ov_menu OpenVibe || fatal "client.dll lacks OpenVibe command strings"
check_strings "$SERVER" ov_js_status ov_js_cmd OpenVibe || fatal "server.dll lacks OpenVibe server strings"

mkdir -p game/openvibe.games/bin
BACKUP="game/openvibe.games/bin/backup-before-win32-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
[[ -f game/openvibe.games/bin/client.dll ]] && cp -f game/openvibe.games/bin/client.dll "$BACKUP/client.dll" || true
[[ -f game/openvibe.games/bin/server.dll ]] && cp -f game/openvibe.games/bin/server.dll "$BACKUP/server.dll" || true

cp -f "$CLIENT" game/openvibe.games/bin/client.dll
cp -f "$SERVER" game/openvibe.games/bin/server.dll
say "installed Win32 OpenVibe DLLs; backup=$BACKUP"

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
else
  check_strings game/openvibe.games/bin/client.dll ov_join ov_menu OpenVibe
  check_strings game/openvibe.games/bin/server.dll ov_js_status ov_js_cmd OpenVibe
fi

cat <<'MSG'

[openvibe] Now fully quit Source SDK Base / Proton if it is open, then launch fresh:

OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

In the game console, test:

ov_help
ov_join hub
ov_menu
ov_menu_servers
ov_auth_steam

If ov_join is still unknown after this, run:

tools/proton-openvibe-command-smoke.sh
MSG
