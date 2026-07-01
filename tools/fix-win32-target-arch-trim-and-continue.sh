#!/usr/bin/env bash
set -euo pipefail

say(){ echo "[openvibe] $*"; }
warn(){ echo "[openvibe warn] $*" >&2; }
err(){ echo "[openvibe error] $*" >&2; exit 1; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh 2>/dev/null || git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')}"

say "fix Win32 target arch whitespace + continue install"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

[[ -f tools/build-sdk-windows.ps1 ]] || err "missing tools/build-sdk-windows.ps1"
[[ -f .github/workflows/windows-source-sdk-dlls.yml ]] || err "missing workflow"
command -v gh >/dev/null 2>&1 || err "missing gh"

python3 - <<'PY'
from pathlib import Path
import re

ps = Path('tools/build-sdk-windows.ps1')
s = ps.read_text()
orig = s

# Normalize any explicit arch assignment from env or literal so whitespace cannot survive a relaunch.
s = re.sub(
    r'(\$script:TargetArch\s*=\s*\$env:OPENVIBE_WINDOWS_TARGET_ARCH)(?!\.Trim\(\))',
    r'\1.Trim()',
    s,
)
s = re.sub(
    r'(\$TargetArch\s*=\s*\$env:OPENVIBE_WINDOWS_TARGET_ARCH)(?!\.Trim\(\))',
    r'\1.Trim()',
    s,
)

# If the script has a more complex if/else target arch block, add a defensive trim immediately after first assignment area.
if 'OPENVIBE_TARGET_ARCH_TRIM_GUARD' not in s:
    marker_candidates = [
        '$ErrorActionPreference = "Stop"',
        "$ErrorActionPreference = 'Stop'",
    ]
    insert = r'''
# OPENVIBE_TARGET_ARCH_TRIM_GUARD
if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { $env:OPENVIBE_WINDOWS_TARGET_ARCH = $env:OPENVIBE_WINDOWS_TARGET_ARCH.Trim() }
if ($script:TargetArch) { $script:TargetArch = ([string]$script:TargetArch).Trim() }
'''
    for marker in marker_candidates:
        if marker in s:
            s = s.replace(marker, marker + insert, 1)
            break

# Fix the validation itself to trim before comparing, regardless of where TargetArch came from.
s = re.sub(
    r'if\s*\(\$script:TargetArch\s+-notin\s+@\("x86",\s*"x64"\)\)\s*\{',
    'if (([string]$script:TargetArch).Trim() -notin @("x86", "x64")) {',
    s,
)
s = re.sub(
    r'if\s*\(\$TargetArch\s+-notin\s+@\("x86",\s*"x64"\)\)\s*\{',
    'if (([string]$TargetArch).Trim() -notin @("x86", "x64")) {',
    s,
)

# After validation, force normalized values back into variables/env.
if 'OPENVIBE_TARGET_ARCH_NORMALIZE_AFTER_VALIDATE' not in s:
    # Insert after the first validation throw block if possible, else after Say target arch.
    norm = r'''
# OPENVIBE_TARGET_ARCH_NORMALIZE_AFTER_VALIDATE
$script:TargetArch = ([string]$script:TargetArch).Trim()
$env:OPENVIBE_WINDOWS_TARGET_ARCH = $script:TargetArch
'''
    m = re.search(r'(OPENVIBE_WINDOWS_TARGET_ARCH must be x86 or x64[^\n]*\n\s*\})', s)
    if m:
        s = s[:m.end()] + norm + s[m.end():]
    else:
        s = s.replace('Say "target arch=$script:TargetArch"', norm + '\nSay "target arch=$script:TargetArch"', 1)

if s != orig:
    ps.write_text(s)

wf = Path('.github/workflows/windows-source-sdk-dlls.yml')
w = wf.read_text()
origw = w
# Strip trailing spaces and normalize the env assignment if present.
w = '\n'.join(line.rstrip() for line in w.splitlines()) + '\n'
w = re.sub(r'(OPENVIBE_WINDOWS_TARGET_ARCH:\s*)["\']?x86["\']?\s*$', r'\1x86', w, flags=re.M)
if w != origw:
    wf.write_text(w)
PY

# Add a small note so the commit explains the otherwise dumb whitespace failure.
mkdir -p docs
cat > docs/WINDOWS_TARGET_ARCH_TRIM.md <<'DOC'
# Windows target arch trim fix

The Win32 GitHub Actions build relaunches through `vcvars32.bat`. The target arch value can survive as `x86 ` with a trailing space depending on how the command string/env was composed. `tools/build-sdk-windows.ps1` now trims `OPENVIBE_WINDOWS_TARGET_ARCH` before validation and normalizes it after validation so Win32 builds do not fail before project generation.
DOC

git add tools/build-sdk-windows.ps1 .github/workflows/windows-source-sdk-dlls.yml docs/WINDOWS_TARGET_ARCH_TRIM.md
if git diff --cached --quiet; then
  say "no arch trim changes needed"
else
  git commit -m "Trim Windows target arch for Win32 DLL builds"
  git push origin "$BRANCH"
fi

HEAD_SHA="$(git rev-parse HEAD)"
say "head=$HEAD_SHA"

say "triggering Win32 workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1 >/dev/null
sleep 8

RUN_ID=""
for i in {1..45}; do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --commit "$HEAD_SHA" --limit 5 --json databaseId,event,status,conclusion,headSha --jq 'map(select(.headSha == "'"$HEAD_SHA"'")) | .[0].databaseId // empty' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" ]]; then break; fi
  sleep 4
done
if [[ -z "$RUN_ID" ]]; then
  warn "could not find run for commit, falling back to latest branch workflow run"
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || err "could not find workflow run"

say "watching run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  warn "workflow failed; downloading diagnostics"
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  err "Win32 DLL workflow failed"
fi

say "workflow passed; downloading/installing latest DLL artifact"
if [[ -x tools/install-latest-openvibe-windows-dlls.sh ]]; then
  tools/install-latest-openvibe-windows-dlls.sh "$RUN_ID" || true
else
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
fi

# If the existing installer still rejects valid artifacts, do a strict local install from the downloaded artifact.
OUT="$ROOT/artifacts/windows-workflow-debug/run-${RUN_ID}-artifacts"
if [[ ! -d "$OUT" ]]; then
  mkdir -p "$OUT"
  gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" >/dev/null 2>&1 || true
fi
CLIENT="$(find "$OUT" -type f -iname client.dll | sort | head -n1 || true)"
SERVER="$(find "$OUT" -type f -iname server.dll | sort | head -n1 || true)"

if [[ -n "$CLIENT" && -n "$SERVER" ]]; then
  say "candidate client=$CLIENT"
  say "candidate server=$SERVER"
  file "$CLIENT" || true
  file "$SERVER" || true

  client_file="$(file "$CLIENT" || true)"
  server_file="$(file "$SERVER" || true)"
  if grep -Fq 'PE32+' <<<"$client_file$server_file"; then
    err "artifact is still x64 PE32+; refusing install"
  fi
  if ! grep -Fq 'PE32 executable (DLL)' <<<"$client_file"; then
    err "client.dll is not PE32 x86"
  fi
  if ! grep -Fq 'PE32 executable (DLL)' <<<"$server_file"; then
    err "server.dll is not PE32 x86"
  fi

  # Client command strings are mandatory for fixing Unknown command.
  if ! strings -a "$CLIENT" | grep -Eq 'ov_join|ov_menu|openvibe_menu|OpenVibe'; then
    warn "client.dll is 32-bit but still lacks OpenVibe command strings"
    warn "not installing because it would still say Unknown command"
    err "Win32 artifact exists, but OpenVibe client code is not linked into client.dll"
  fi

  mkdir -p game/openvibe.games/bin artifacts/windows-dll-backups
  ts="$(date +%Y%m%d-%H%M%S)"
  [[ -f game/openvibe.games/bin/client.dll ]] && cp -f game/openvibe.games/bin/client.dll "artifacts/windows-dll-backups/client.dll.$ts.bak" || true
  [[ -f game/openvibe.games/bin/server.dll ]] && cp -f game/openvibe.games/bin/server.dll "artifacts/windows-dll-backups/server.dll.$ts.bak" || true
  cp -f "$CLIENT" game/openvibe.games/bin/client.dll
  cp -f "$SERVER" game/openvibe.games/bin/server.dll
  say "installed Win32 OpenVibe DLLs into game/openvibe.games/bin"
else
  err "no client/server DLLs found in downloaded workflow artifacts"
fi

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh || true
fi

cat <<'MSG'
[openvibe] next:
  1) Fully quit the Source/Proton game process.
  2) Relaunch fresh:

     OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

  3) In console test:

     ov_help
     ov_join hub
     ov_menu
     ov_menu_servers

If ov_join is still unknown after this, run:

     tools/proton-openvibe-command-smoke.sh
     tools/collect-proton-openvibe-debug.sh
MSG
