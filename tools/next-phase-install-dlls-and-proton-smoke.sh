#!/usr/bin/env bash
set -euo pipefail

say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }

ROOT="${OPENVIBE_ROOT:-$(pwd)}"
if [[ ! -d "$ROOT/.git" ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "$ROOT" || ! -d "$ROOT/.git" ]]; then
  echo "Run this from inside ~/src/openvibe-source" >&2
  exit 1
fi
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -x tools/openvibe-gh-repo.sh ]]; then
  REPO="$(tools/openvibe-gh-repo.sh)"
else
  REPO="$(git config --get remote.origin.url | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
fi
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"

say "next phase: install successful Windows DLL artifact + smoke helpers"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

mkdir -p tools docs artifacts

cat > tools/install-latest-successful-windows-dlls.sh <<'INSTALL'
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
  strings -a "$file" | grep -Fq -- "$needle"
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
INSTALL
chmod +x tools/install-latest-successful-windows-dlls.sh

cat > tools/proton-openvibe-smoke-test.sh <<'SMOKE'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"
HOST="${1:-127.0.0.1}"
PORT="${2:-27015}"

echo "[openvibe] smoke test root=$ROOT"
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
fi

if [[ -x tools/check-openvibe-platform-binaries.sh ]]; then
  tools/check-openvibe-platform-binaries.sh || true
fi

cat <<EOF
[openvibe] Windows DLLs are installed. Next in-game console checks:
  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers
  ov_auth_steam

[openvibe] To launch now, run:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh $HOST $PORT
EOF

if [[ "${OPENVIBE_RUN_GAME:-0}" == "1" ]]; then
  echo "[openvibe] OPENVIBE_RUN_GAME=1 set; launching Proton client"
  OPENVIBE_PROTON_LOG="${OPENVIBE_PROTON_LOG:-1}" OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh "$HOST" "$PORT"
fi
SMOKE
chmod +x tools/proton-openvibe-smoke-test.sh

# Patch the older debug downloader/installer so it no longer false-rejects the successful artifact.
if [[ -f tools/windows-workflow-debug-and-install.sh ]]; then
python3 - <<'PY'
from pathlib import Path
p = Path('tools/windows-workflow-debug-and-install.sh')
s = p.read_text()
s = s.replace('if strings "$CLIENT" | grep -Eq \'ov_join|ov_menu|OpenVibe\'; then', 'if strings -a "$CLIENT" | grep -Eq \'ov_join|ov_menu|OpenVibe\' && strings -a "$SERVER" | grep -Eq \'ov_js_status|ov_js_cmd|OpenVibe\'; then')
s = s.replace('strings game/openvibe.games/bin/client.dll | grep -E', 'strings -a game/openvibe.games/bin/client.dll | grep -E')
p.write_text(s)
PY
  chmod +x tools/windows-workflow-debug-and-install.sh
fi

cat > docs/NEXT_PHASE_WINDOWS_DLL_INSTALL_AND_SMOKE.md <<'DOC'
# Next phase: install successful Windows DLL artifacts and smoke test Proton

The Windows GitHub Actions build now produces `openvibe-windows-dlls` with patched `client.dll` and `server.dll`.

Use:

```bash
tools/install-latest-successful-windows-dlls.sh
```

That downloads the latest successful `windows-source-sdk-dlls.yml` artifact for the current branch, verifies OpenVibe strings, backs up old local DLLs, and installs into:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

Then run:

```bash
tools/proton-openvibe-smoke-test.sh
```

To actually launch from the smoke helper:

```bash
OPENVIBE_RUN_GAME=1 tools/proton-openvibe-smoke-test.sh 127.0.0.1 27015
```

Expected in-game console checks:

```text
ov_help
ov_join hub
ov_menu
ov_menu_servers
ov_auth_steam
```

Do not blindly commit installed DLL binaries unless that is intentional. The repeatable source of truth is the Actions artifact.
DOC

say "git diff summary"
git diff --stat -- tools/install-latest-successful-windows-dlls.sh tools/proton-openvibe-smoke-test.sh tools/windows-workflow-debug-and-install.sh docs/NEXT_PHASE_WINDOWS_DLL_INSTALL_AND_SMOKE.md || true

git add \
  tools/install-latest-successful-windows-dlls.sh \
  tools/proton-openvibe-smoke-test.sh \
  tools/windows-workflow-debug-and-install.sh \
  docs/NEXT_PHASE_WINDOWS_DLL_INSTALL_AND_SMOKE.md \
  "$0" 2>/dev/null || git add tools/install-latest-successful-windows-dlls.sh tools/proton-openvibe-smoke-test.sh tools/windows-workflow-debug-and-install.sh docs/NEXT_PHASE_WINDOWS_DLL_INSTALL_AND_SMOKE.md

if ! git diff --cached --quiet; then
  git commit -m "Install successful Windows DLL artifacts and add Proton smoke helper"
  say "pushing $BRANCH"
  git push -u origin "$BRANCH"
else
  say "no helper changes to commit"
fi

say "installing latest successful Windows DLL artifact"
tools/install-latest-successful-windows-dlls.sh

say "running smoke helper without launching game"
tools/proton-openvibe-smoke-test.sh 127.0.0.1 27015

cat <<'DONE'
[openvibe] next manual launch:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

[openvibe] or launch through helper:
  OPENVIBE_RUN_GAME=1 tools/proton-openvibe-smoke-test.sh 127.0.0.1 27015
DONE
