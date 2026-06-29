#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="${OPENVIBE_REPO:-$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')}"
REPO="${REPO%.git}"
WORKFLOW="windows-source-sdk-dlls.yml"

echo "[openvibe] fix Windows bootstrap: use Valve master zip/download fallback"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=$BRANCH"
echo "[openvibe] repo=$REPO"

mkdir -p tools docs .github/workflows

cat > tools/bootstrap-source-sdk-2013-windows.ps1 <<'PS'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $Deps, $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function Dump-Dir($path, $outName) {
  try {
    if (Test-Path $path) {
      Get-ChildItem -Force $path | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir $outName)
    } else {
      "[missing] $path" | Out-File (Join-Path $LogDir $outName)
    }
  } catch {
    "dump failed: $($_.Exception.Message)" | Out-File (Join-Path $LogDir $outName)
  }
}
function Assert-UsableSdk($prefix) {
  if ((Test-Path (Join-Path $Src 'game/client/hl2mp')) -and (Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
    Say "$prefix SDK tree looks usable"
    return $true
  }
  return $false
}
function Copy-SdkRoot($sourceRoot) {
  Say "copying SDK root $sourceRoot -> $Sdk"
  if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
  New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $Sdk -Recurse -Force
  Dump-Dir $Sdk 'sdk-root-after-copy.txt'
  if (!(Assert-UsableSdk 'copied')) {
    throw "Copied SDK is missing expected HL2MP folders under $Src"
  }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "deps=$Deps"

if (Assert-UsableSdk 'existing') { exit 0 }

# ValveSoftware/source-sdk-2013 currently uses the default/master layout with src/ at the repository root.
# Do not assume an mp branch or mp/src folder. Downloading the zip avoids git/extraheader/auth weirdness on Actions runners.
$zip = Join-Path $Deps 'source-sdk-2013-master.zip'
$extractParent = Join-Path $Deps 'source-sdk-2013-zip'
$zipRoot = Join-Path $extractParent 'source-sdk-2013-master'
$zipUrl = 'https://codeload.github.com/ValveSoftware/source-sdk-2013/zip/refs/heads/master'

$zipOk = $false
try {
  Say "downloading Valve SDK master zip from $zipUrl"
  if (Test-Path $zip) { Remove-Item -Force $zip }
  if (Test-Path $extractParent) { Remove-Item -Recurse -Force $extractParent }
  New-Item -ItemType Directory -Force -Path $extractParent | Out-Null

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --retry 4 --retry-delay 3 --connect-timeout 30 -o $zip $zipUrl 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-curl-master-zip.log')
    if ($LASTEXITCODE -ne 0) { throw "curl.exe failed with exit code $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-iwr-master-zip.log')
  }

  $zipInfo = Get-Item $zip
  Say "zip bytes=$($zipInfo.Length)"
  if ($zipInfo.Length -lt 1000000) { throw "downloaded zip is suspiciously small" }

  Expand-Archive -Path $zip -DestinationPath $extractParent -Force
  Dump-Dir $extractParent 'zip-extract-parent.txt'
  Dump-Dir $zipRoot 'zip-root.txt'

  if (Test-Path (Join-Path $zipRoot 'src/game/client/hl2mp')) {
    Copy-SdkRoot $zipRoot
    $zipOk = $true
  } else {
    throw "zip did not contain expected src/game/client/hl2mp at $zipRoot"
  }
} catch {
  Say "zip bootstrap failed: $($_.Exception.Message)"
  $_ | Out-String | Out-File (Join-Path $LogDir 'bootstrap-zip-exception.txt')
}

if ($zipOk) { Say 'SDK bootstrapped successfully from zip'; exit 0 }

# Last-resort git fallback. Clear possible GitHub Actions extraheaders and force public HTTPS.
$gitRepo = Join-Path $Deps 'source-sdk-2013-git'
try {
  Say "trying git clone fallback"
  git config --global --unset-all http.https://github.com/.extraheader 2>$null
  git config --global --unset-all http.https://github.com/ValveSoftware/source-sdk-2013.extraheader 2>$null
  if (Test-Path $gitRepo) { Remove-Item -Recurse -Force $gitRepo }
  & git -c http.https://github.com/.extraheader= clone --depth 1 --single-branch https://github.com/ValveSoftware/source-sdk-2013.git $gitRepo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-clone-master.log')
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
  Dump-Dir $gitRepo 'git-root.txt'
  if (Test-Path (Join-Path $gitRepo 'src/game/client/hl2mp')) {
    Copy-SdkRoot $gitRepo
    Say 'SDK bootstrapped successfully from git'
    exit 0
  }
  throw "git clone did not contain src/game/client/hl2mp"
} catch {
  Say "git bootstrap failed: $($_.Exception.Message)"
  $_ | Out-String | Out-File (Join-Path $LogDir 'bootstrap-git-exception.txt')
}

Dump-Dir $Deps 'deps-after-bootstrap-failure.txt'
throw "Could not bootstrap ValveSoftware/source-sdk-2013. Check openvibe-windows-build-debug artifact, especially bootstrap-curl-master-zip.log, bootstrap-zip-exception.txt, and bootstrap-git-clone-master.log."
PS

cat > docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md <<'MD'
# Windows Source SDK bootstrap

The Windows GitHub Actions runner is fresh and does not have Alex's local `engine/source-sdk-2013` checkout.

The workflow bootstraps Valve's public Source SDK 2013 repository into:

```text
engine/source-sdk-2013
```

The expected SDK layout is:

```text
engine/source-sdk-2013/src/game/client/hl2mp
engine/source-sdk-2013/src/game/server/hl2mp
```

The bootstrap intentionally downloads the default/master zip first:

```text
https://codeload.github.com/ValveSoftware/source-sdk-2013/zip/refs/heads/master
```

This avoids brittle branch assumptions and avoids GitHub Actions `git` auth/header issues. A git clone fallback is still present for debugging.
MD

# Make sure the workflow has the bootstrap step before build, without rewriting the whole file if it already does.
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/windows-source-sdk-dlls.yml')
s = p.read_text()
if 'Bootstrap Source SDK 2013 MP' not in s and 'Bootstrap Source SDK 2013' not in s:
    marker = '      - name: Build Windows Source SDK DLLs\n'
    insert = '''      - name: Bootstrap Source SDK 2013\n        run: |\n          $ErrorActionPreference = 'Stop'\n          powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-source-sdk-2013-windows.ps1 *>&1 | Tee-Object -FilePath artifacts/windows-build-debug/bootstrap-source-sdk-2013.log\n\n'''
    if marker not in s:
        raise SystemExit('could not find Build Windows Source SDK DLLs step marker')
    s = s.replace(marker, insert + marker, 1)
# Normalize the old step label if present.
s = s.replace('Bootstrap Source SDK 2013 MP', 'Bootstrap Source SDK 2013')
p.write_text(s)
PY

# Improve debug helper to print the new bootstrap files if the run fails.
python3 - <<'PY'
from pathlib import Path
p = Path('tools/windows-workflow-debug-and-install.sh')
if not p.exists():
    raise SystemExit(0)
s = p.read_text()
needle = 'grep -RInE "(error|failed|fatal|C[0-9]{4}|LNK[0-9]{4}|MSB[0-9]{4}|No patched OpenVibe DLLs)" "$OUT" 2>/dev/null | head -n 80 || true'
replacement = '''grep -RInE "(error|failed|fatal|C[0-9]{4}|LNK[0-9]{4}|MSB[0-9]{4}|No patched OpenVibe DLLs|Could not bootstrap|suspiciously small)" "$OUT" 2>/dev/null | head -n 120 || true

for f in \
  "$OUT"/openvibe-windows-build-debug/bootstrap-source-sdk-2013.log \
  "$OUT"/openvibe-windows-build-debug/bootstrap-curl-master-zip.log \
  "$OUT"/openvibe-windows-build-debug/bootstrap-zip-exception.txt \
  "$OUT"/openvibe-windows-build-debug/bootstrap-git-clone-master.log \
  "$OUT"/openvibe-windows-build-debug/bootstrap-git-exception.txt \
  "$OUT"/openvibe-windows-build-debug/build-sdk-windows.log; do
  if [[ -f "$f" ]]; then
    echo
    echo "[openvibe] tail: ${f#$ROOT/}"
    tail -n 80 "$f" || true
  fi
done'''
if needle in s:
    s = s.replace(needle, replacement)
elif 'bootstrap-curl-master-zip.log' not in s:
    s += '\n\n# Extra bootstrap tails for current Windows workflow debugging.\n'
p.write_text(s)
PY

echo "[openvibe] git diff summary"
git diff --stat

if ! git diff --quiet; then
  git add tools/bootstrap-source-sdk-2013-windows.ps1 docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md .github/workflows/windows-source-sdk-dlls.yml tools/windows-workflow-debug-and-install.sh
  git commit -m "Fix Windows SDK bootstrap download path"
  git push origin "$BRANCH"
else
  echo "[openvibe] no changes to commit"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[openvibe] gh missing; install/authenticate GitHub CLI, then run tools/windows-workflow-debug-and-install.sh after triggering workflow."
  exit 0
fi

echo "[openvibe] triggering workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" || true
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "[openvibe] watching run $RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  echo "[openvibe] workflow passed"
else
  echo "[openvibe warn] workflow failed; downloading diagnostics"
fi

tools/windows-workflow-debug-and-install.sh || true

echo
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh || true
fi

echo
cat <<'EOF'
[openvibe] next if patched DLLs are installed:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

In game console:
  ov_join hub
  ov_menu
  ov_menu_servers
EOF
