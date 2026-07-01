#!/usr/bin/env bash
set -euo pipefail

say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORKFLOW="windows-source-sdk-dlls.yml"

say "fix GitHub repo slug + clean committed diagnostics + rerun Windows DLL build"
say "root=$ROOT"
say "branch=$BRANCH"

mkdir -p tools game/openvibe.games/bin

cat > tools/openvibe-gh-repo.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
url="${1:-$(git config --get remote.origin.url)}"
url="${url#git@github.com:}"
url="${url#ssh://git@github.com/}"
url="${url#https://github.com/}"
url="${url#http://github.com/}"
url="${url%.git}"
url="${url%/}"
if [[ ! "$url" =~ ^[^/]+/[^/]+$ ]]; then
  echo "Could not normalize GitHub repo from remote.origin.url: ${url}" >&2
  exit 1
fi
echo "$url"
EOS
chmod +x tools/openvibe-gh-repo.sh

REPO="$(tools/openvibe-gh-repo.sh)"
say "repo=$REPO"

# Make sure debug outputs never get committed again.
touch .gitignore
python3 - <<'PY'
from pathlib import Path
p = Path('.gitignore')
lines = p.read_text().splitlines() if p.exists() else []
want = [
    '',
    '# OpenVibe local/generated build diagnostics',
    'artifacts/',
    '_deps/',
    '*.tmp',
    '*.log',
]
existing = set(lines)
changed = False
for line in want:
    if line and line not in existing:
        lines.append(line)
        existing.add(line)
        changed = True
    elif line == '' and (not lines or lines[-1] != ''):
        lines.append(line)
        changed = True
if changed:
    p.write_text('\n'.join(lines).rstrip() + '\n')
PY

# Remove previously committed workflow debug artifacts from git, but keep local files if present.
if git ls-files artifacts | grep -q .; then
  say "removing committed artifacts/ from git index"
  git rm -r --cached artifacts >/dev/null || true
fi

cat > tools/windows-workflow-debug-and-install.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
RUN_ID="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh is missing. Install/auth it first: sudo apt install gh && gh auth login" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "Could not find a workflow run for $REPO $WORKFLOW on $BRANCH" >&2
  exit 1
fi

OUT="$ROOT/artifacts/windows-workflow-debug/run-${RUN_ID}-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT"

say "repo=$REPO"
say "run=$RUN_ID"
say "downloading logs/artifacts into $OUT"

gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/full-run.log" 2>&1 || true
gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" >/dev/null 2>&1 || true
find "$OUT" -type f | sort > "$OUT/file-list.txt"

say "likely errors:"
if ! grep -RInE "error |error:|fatal:|failed|Exception|No patched|MSB[0-9]+|LNK[0-9]+|C[0-9]{4}" "$OUT" | head -n 80; then
  warn "no obvious errors found in downloaded logs"
fi

say "artifact files:"
cat "$OUT/file-list.txt"

CLIENT=""
SERVER=""
while IFS= read -r f; do
  case "$(basename "$f")" in
    client.dll) CLIENT="$f" ;;
    server.dll) SERVER="$f" ;;
  esac
done < <(find "$OUT" -type f \( -iname 'client.dll' -o -iname 'server.dll' \) | sort)

if [[ -n "$CLIENT" && -n "$SERVER" ]]; then
  say "candidate client=$CLIENT"
  say "candidate server=$SERVER"
  if strings "$CLIENT" | grep -Eq 'ov_join|ov_menu|OpenVibe'; then
    mkdir -p game/openvibe.games/bin
    cp -f "$CLIENT" game/openvibe.games/bin/client.dll
    cp -f "$SERVER" game/openvibe.games/bin/server.dll
    say "installed patched Windows DLLs"
    if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
      tools/verify-openvibe-dll-content.sh || true
    else
      strings game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|OpenVibe' | head || true
    fi
    exit 0
  else
    warn "DLLs were present but do not contain OpenVibe strings; not installing stale/stock DLLs"
  fi
else
  warn "no client.dll/server.dll artifact available yet"
fi

say "next useful tails:"
for f in \
  "$OUT/full-run.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-source-sdk-2013.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-curl-master-zip.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-git-clone-master.log" \
  "$OUT/openvibe-windows-build-debug/build-sdk-windows.log"; do
  if [[ -f "$f" ]]; then
    echo "----- $f -----"
    tail -n 80 "$f" || true
  fi
done
exit 2
EOS
chmod +x tools/windows-workflow-debug-and-install.sh

cat > tools/trigger-windows-dll-build-clean.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh is missing. Install/auth it first: sudo apt install gh && gh auth login" >&2
  exit 1
fi

gh auth status >/dev/null
say "repo=$REPO"
say "workflow=$WORKFLOW"
say "branch=$BRANCH"

git push
say "triggering workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1

say "waiting for new run to appear"
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
say "watching run $RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  say "workflow passed"
else
  warn_msg="workflow failed; downloading diagnostics anyway"
  echo "[openvibe warn] $warn_msg" >&2
fi

tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
EOS
chmod +x tools/trigger-windows-dll-build-clean.sh

# Try to patch older helper scripts so the .git suffix never breaks gh API calls again.
for f in \
  tools/request-windows-dll-build.sh \
  tools/gh-windows-build-and-install.sh \
  tools/next-phase-platform-build-and-fetch.sh \
  tools/fix-windows-bootstrap-download-master-and-rerun.sh \
  tools/fix-windows-bootstrap-mp-branch-and-rerun.sh \
  tools/fix-windows-sdk-bootstrap-and-real-dlls.sh \
  tools/fix-windows-workflow-diagnostics-and-rerun.sh; do
  [[ -f "$f" ]] || continue
  python3 - "$f" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
s = p.read_text()
# Add a harmless normalization immediately after simple REPO assignments derived from remote.origin.url.
s = re.sub(r'(REPO="\$\([^\n]*remote\.origin\.url[^\n]*\)"\n)', r'\1REPO="${REPO%.git}"\n', s)
s = re.sub(r"(REPO='\$\([^\n]*remote\.origin\.url[^\n]*\)'\n)", r"\1REPO=\"${REPO%.git}\"\n", s)
# Also strip .git after any existing REPO assignment block if not already nearby.
if 'REPO="${REPO%.git}"' not in s and 'gh workflow' in s:
    s = s.replace('WORKFLOW=', 'REPO="${REPO%.git}"\nWORKFLOW=', 1)
p.write_text(s)
PY
  chmod +x "$f" 2>/dev/null || true
done

say "git status after cleanup/patch"
git status --short

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add .gitignore tools/openvibe-gh-repo.sh tools/windows-workflow-debug-and-install.sh tools/trigger-windows-dll-build-clean.sh tools/*.sh 2>/dev/null || true
  if git diff --cached --quiet; then
    say "nothing staged to commit"
  else
    git commit -m "Fix GitHub workflow repo slug and ignore diagnostics"
  fi
else
  say "no cleanup changes to commit"
fi

git push
say "running clean Windows DLL workflow trigger"
tools/trigger-windows-dll-build-clean.sh
