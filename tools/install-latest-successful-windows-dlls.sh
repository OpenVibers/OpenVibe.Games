#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }

ROOT="${OPENVIBE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
if [[ -x tools/openvibe-gh-repo.sh ]]; then
  REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
else
  REPO="${OPENVIBE_REPO:-$(git config --get remote.origin.url | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')}"
fi
RUN_ID="${1:-${OPENVIBE_RUN_ID:-}}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing GitHub CLI: gh" >&2
  exit 1
fi
if ! command -v strings >/dev/null 2>&1; then
  echo "Missing strings/binutils" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "Could not find a successful $WORKFLOW run on $BRANCH" >&2
  exit 1
fi

OUT="$ROOT/artifacts/windows-workflow-debug/run-${RUN_ID}-install"
rm -rf "$OUT"
mkdir -p "$OUT"

say "repo=$REPO"
say "workflow=$WORKFLOW"
say "branch=$BRANCH"
say "run=$RUN_ID"
say "downloading openvibe-windows-dlls artifact"

gh run download "$RUN_ID" --repo "$REPO" --name openvibe-windows-dlls --dir "$OUT" >/dev/null
find "$OUT" -type f | sort > "$OUT/file-list.txt"
cat "$OUT/file-list.txt"

CLIENT="$(find "$OUT" -type f -iname 'client.dll' | sort | tail -n 1)"
SERVER="$(find "$OUT" -type f -iname 'server.dll' | sort | tail -n 1)"

if [[ -z "$CLIENT" || -z "$SERVER" || ! -f "$CLIENT" || ! -f "$SERVER" ]]; then
  echo "Artifact did not contain both client.dll and server.dll" >&2
  exit 2
fi

has_string() {
  local file="$1" needle="$2"
  n="$(strings -a "$file" | grep -Fc -- "$needle" || true)"; [[ "${n:-0}" -gt 0 ]]
}
verify_file() {
  local label="$1" file="$2"; shift 2
  echo "--------------------------------------------------------------------------------"
  echo "[$label] $file"
  file "$file" || true
  stat -c '[size] %s bytes' "$file" || true
  sha256sum "$file" | awk '{print "[sha256] "$1}' || true
  local missing=0
  for needle in "$@"; do
    if has_string "$file" "$needle"; then
      echo "[ok] contains string: $needle"
    else
      echo "[miss] does not contain string: $needle"
      missing=1
    fi
  done
  return "$missing"
}

verify_file "artifact client.dll" "$CLIENT" ov_join ov_auth_steam ov_menu OpenVibe
verify_file "artifact server.dll" "$SERVER" ov_js_status ov_js_cmd OpenVibe

BIN="$ROOT/game/openvibe.games/bin"
BACKUP="$ROOT/artifacts/installed-dll-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BIN" "$BACKUP"
[[ -f "$BIN/client.dll" ]] && cp -f "$BIN/client.dll" "$BACKUP/client.dll.old" || true
[[ -f "$BIN/server.dll" ]] && cp -f "$BIN/server.dll" "$BACKUP/server.dll.old" || true

cp -f "$CLIENT" "$BIN/client.dll"
cp -f "$SERVER" "$BIN/server.dll"

say "installed artifact DLLs into $BIN"
say "old DLL backup, if any: $BACKUP"

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
else
  verify_file "installed client.dll" "$BIN/client.dll" ov_join ov_auth_steam ov_menu OpenVibe
  verify_file "installed server.dll" "$BIN/server.dll" ov_js_status ov_js_cmd OpenVibe
fi

cat > "$OUT/install-summary.txt" <<SUMMARY
repo=$REPO
branch=$BRANCH
workflow=$WORKFLOW
run=$RUN_ID
client=$CLIENT
server=$SERVER
installed_bin=$BIN
backup=$BACKUP
SUMMARY

say "install summary: $OUT/install-summary.txt"
warn "Installed DLLs are local runtime artifacts. Do not blindly git add game/openvibe.games/bin/*.dll unless you intentionally want to commit binaries."

git status --short game/openvibe.games/bin || true
