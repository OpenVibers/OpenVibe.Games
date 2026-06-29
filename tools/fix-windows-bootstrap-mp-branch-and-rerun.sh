#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="${OPENVIBE_GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
REPO="${REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="windows-source-sdk-dlls.yml"

say(){ printf '[openvibe] %s\n' "$*"; }

say "fix Windows bootstrap to clone the real Source SDK 2013 MP branch"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing gh. Run: sudo apt install gh && gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

mkdir -p tools docs .github/workflows

cat > tools/bootstrap-source-sdk-2013-windows.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function Has-HL2MP($base) {
  return ((Test-Path (Join-Path $base 'src/game/client/hl2mp')) -and (Test-Path (Join-Path $base 'src/game/server/hl2mp')))
}
function Run-Git($args, $logName) {
  $log = Join-Path $LogDir $logName
  Say "git $args"
  & git @args 2>&1 | Tee-Object -FilePath $log
  if ($LASTEXITCODE -ne 0) { throw "git $args failed with exit code $LASTEXITCODE. See $log" }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "logdir=$LogDir"

if (Has-HL2MP $Sdk) {
  Say "existing SDK tree already contains HL2MP client/server"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Deps | Out-Null

# Valve's source-sdk-2013 repository is normally organized by branches: mp and sp.
# Some forks/mirrors use root folders like mp/src. Support both layouts.
$RepoUrl = if ($env:OPENVIBE_SOURCE_SDK_REPO) { $env:OPENVIBE_SOURCE_SDK_REPO } else { 'https://github.com/ValveSoftware/source-sdk-2013.git' }
$ValveRepo = Join-Path $Deps 'source-sdk-2013-mp'

if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }

$cloned = $false
try {
  Say "cloning Valve Source SDK 2013 branch mp"
  Run-Git @('clone','--depth','1','--branch','mp',$RepoUrl,$ValveRepo) 'bootstrap-git-clone-mp.log'
  $cloned = $true
} catch {
  Say "mp branch clone failed: $($_.Exception.Message)"
  if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }
  Say "falling back to default branch clone"
  Run-Git @('clone','--depth','1',$RepoUrl,$ValveRepo) 'bootstrap-git-clone-default.log'
  $cloned = $true
}

if (-not $cloned) { throw "could not clone Source SDK repo" }

"=== Valve repo root ===" | Out-File (Join-Path $LogDir 'valve-repo-root.txt')
Get-ChildItem -Force $ValveRepo | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'valve-repo-root.txt') -Append
"=== candidate src folders ===" | Out-File (Join-Path $LogDir 'valve-candidate-src.txt')
Get-ChildItem -Path $ValveRepo -Recurse -Directory -Filter src -ErrorAction SilentlyContinue |
  Select-Object FullName | Format-List | Out-File (Join-Path $LogDir 'valve-candidate-src.txt') -Append

$candidates = @(
  $ValveRepo,
  (Join-Path $ValveRepo 'mp'),
  (Join-Path $ValveRepo 'srcsdk/mp'),
  (Join-Path $ValveRepo 'source-sdk-2013/mp')
)

$SourceRoot = $null
foreach ($candidate in $candidates) {
  if (Has-HL2MP $candidate) {
    $SourceRoot = $candidate
    break
  }
}

if (-not $SourceRoot) {
  $matches = Get-ChildItem -Path $ValveRepo -Recurse -Directory -Filter hl2mp -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]src[\\/]game[\\/](client|server)[\\/]hl2mp$' }
  $matches | Select-Object FullName | Format-List | Out-File (Join-Path $LogDir 'hl2mp-folder-search.txt')
  throw "Could not find Source SDK 2013 MP HL2MP layout after clone. Check valve-repo-root.txt, valve-candidate-src.txt, and hl2mp-folder-search.txt."
}

Say "source root=$SourceRoot"
Say "copying Source SDK MP layout into $Sdk"
if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
Copy-Item -Path (Join-Path $SourceRoot '*') -Destination $Sdk -Recurse -Force

if (!(Has-HL2MP $Sdk)) {
  Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
  throw "Bootstrapped SDK is missing expected HL2MP folders after copy"
}

"=== SDK root after copy ===" | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt') -Append
"=== SDK src root after copy ===" | Out-File (Join-Path $LogDir 'sdk-src-root-after-copy.txt')
Get-ChildItem -Force (Join-Path $Sdk 'src') | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-src-root-after-copy.txt') -Append

Say "SDK bootstrapped successfully"
PS1

cat > docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md <<'MD'
# Windows Source SDK bootstrap

The GitHub Actions Windows runner does not have Alex's local `engine/source-sdk-2013` checkout. The workflow bootstraps it by cloning ValveSoftware/source-sdk-2013.

Important detail: the Source SDK 2013 multiplayer code is normally on the `mp` branch, not necessarily in a `mp/` directory on the default branch. The bootstrap script now supports both layouts:

- `source-sdk-2013` checked out directly on the `mp` branch, with `src/...` at repo root
- older/mirrored layout with `mp/src/...`

The workflow should not upload or install stock/stale DLLs. A DLL artifact is considered useful only when `client.dll` contains OpenVibe command strings such as `ov_join`, `ov_menu`, or `OpenVibe`.
MD

# Make workflow rerun on bootstrap changes and make bootstrap log more obvious.
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/windows-source-sdk-dlls.yml')
s = p.read_text()
if 'tools/bootstrap-source-sdk-2013-windows.ps1' not in s:
    s = s.replace('      - "tools/build-sdk-windows.ps1"\n', '      - "tools/build-sdk-windows.ps1"\n      - "tools/bootstrap-source-sdk-2013-windows.ps1"\n')
# Ensure bootstrap step captures a specific log and prints it on failure before exiting.
old = '''      - name: Bootstrap Source SDK 2013 MP\n        run: |\n          powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-source-sdk-2013-windows.ps1 *>&1 | Tee-Object -FilePath artifacts/windows-build-debug/bootstrap-source-sdk-2013.log\n'''
new = '''      - name: Bootstrap Source SDK 2013 MP\n        run: |\n          $ErrorActionPreference = 'Continue'\n          New-Item -ItemType Directory -Force -Path artifacts/windows-build-debug | Out-Null\n          powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-source-sdk-2013-windows.ps1 *>&1 | Tee-Object -FilePath artifacts/windows-build-debug/bootstrap-source-sdk-2013.log\n          $code = $LASTEXITCODE\n          if ($code -ne 0) {\n            Write-Host \"[openvibe] bootstrap failed; tail follows\"\n            Get-Content artifacts/windows-build-debug/bootstrap-source-sdk-2013.log -Tail 120\n            exit $code\n          }\n'''
if old in s:
    s = s.replace(old, new)
p.write_text(s)
PY

# Improve debug downloader so it actually prints the useful logs next time.
if [[ -f tools/windows-workflow-debug-and-install.sh ]]; then
python3 - <<'PY'
from pathlib import Path
p = Path('tools/windows-workflow-debug-and-install.sh')
s = p.read_text()
needle = 'say "artifact files:"\nfind "$OUT" -type f | sort || true\n'
insert = '''say "artifact files:"\nfind "$OUT" -type f | sort || true\n\nfor f in \\\n  "$OUT"/openvibe-windows-build-debug/bootstrap-source-sdk-2013.log \\\n  "$OUT"/openvibe-windows-build-debug/build-sdk-windows.log \\\n  "$OUT"/openvibe-windows-build-debug/bootstrap-git-clone-mp.log \\\n  "$OUT"/openvibe-windows-build-debug/valve-repo-root.txt \\\n  "$OUT"/openvibe-windows-build-debug/valve-candidate-src.txt \\\n  "$OUT"/openvibe-windows-build-debug/hl2mp-folder-search.txt; do\n  if [[ -f "$f" ]]; then\n    echo\n    say "tail: ${f#$OUT/}"\n    tail -n 120 "$f" || true\n  fi\ndone\n'''
if needle in s and 'bootstrap-git-clone-mp.log' not in s:
    s = s.replace(needle, insert)
p.write_text(s)
PY
fi

say "git diff summary"
git diff --stat

git add .github/workflows/windows-source-sdk-dlls.yml tools/bootstrap-source-sdk-2013-windows.ps1 docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md tools/windows-workflow-debug-and-install.sh

if git diff --cached --quiet; then
  say "nothing to commit"
else
  git commit -m "Fix Windows Source SDK MP branch bootstrap"
  git push origin "$BRANCH"
fi

say "triggering workflow"
gh workflow run "$WORKFLOW" --ref "$BRANCH"
sleep 6
RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId -q '.[0].databaseId')"
say "watching run $RUN_ID"
set +e
gh run watch "$RUN_ID" --exit-status
STATUS=$?
set -e

say "downloading diagnostics/artifacts"
tools/windows-workflow-debug-and-install.sh || true

if [[ $STATUS -eq 0 ]]; then
  say "workflow succeeded"
else
  say "workflow failed again; paste the tail printed above if it does not clearly show the next compile error"
fi

exit $STATUS
