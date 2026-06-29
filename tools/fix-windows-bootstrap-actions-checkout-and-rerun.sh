#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

say() { printf '[openvibe] %s\n' "$*"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO=""
if [[ -x tools/openvibe-gh-repo.sh ]]; then
  REPO="$(tools/openvibe-gh-repo.sh || true)"
fi
if [[ -z "$REPO" ]]; then
  REPO="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
else
  REPO="$(printf '%s' "$REPO" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
fi
WORKFLOW="windows-source-sdk-dlls.yml"
WORKFLOW_PATH=".github/workflows/$WORKFLOW"
BOOT="tools/bootstrap-source-sdk-2013-windows.ps1"

say "fix Windows bootstrap by using actions/checkout for Valve SDK"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

mkdir -p .github/workflows tools docs

# Keep downloaded diagnostics and bootstrapped SDK out of git from now on.
touch .gitignore
for line in 'artifacts/' '_deps/' 'engine/source-sdk-2013/'; do
  grep -qxF "$line" .gitignore || echo "$line" >> .gitignore
done

cat > "$BOOT" <<'PS1'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$Checkout = Join-Path $Deps 'source-sdk-2013-upstream'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function WriteTree($path, $name) {
  try {
    if (Test-Path $path) {
      "=== $path ===" | Out-File (Join-Path $LogDir $name)
      Get-ChildItem -Force $path | Select-Object Mode,Length,Name,FullName | Format-Table -AutoSize | Out-File (Join-Path $LogDir $name) -Append
    } else {
      "[missing] $path" | Out-File (Join-Path $LogDir $name)
    }
  } catch {
    "[tree failed] $path $($_.Exception.Message)" | Out-File (Join-Path $LogDir $name)
  }
}
function HasHl2mp($root) {
  $src = Join-Path $root 'src'
  return ((Test-Path (Join-Path $src 'game/client/hl2mp')) -and (Test-Path (Join-Path $src 'game/server/hl2mp')))
}
function CopyLayout($fromRoot, $label) {
  Say "using Valve SDK layout: $label -> $Sdk"
  if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
  New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
  Get-ChildItem -Force $fromRoot | Where-Object { $_.Name -ne '.git' } | ForEach-Object {
    Copy-Item $_.FullName -Destination $Sdk -Recurse -Force
  }
  if (-not (HasHl2mp $Sdk)) {
    WriteTree $Sdk 'sdk-root-after-copy.txt'
    throw "Copied SDK layout is missing expected src/game/client/hl2mp and src/game/server/hl2mp folders"
  }
  Say "SDK bootstrapped successfully"
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "deps=$Deps"
Say "checkout=$Checkout"
WriteTree $Root 'repo-root-before-bootstrap.txt'
WriteTree $Deps 'deps-before-bootstrap.txt'

if (HasHl2mp $Sdk) {
  Say "existing SDK tree looks usable"
  exit 0
}

# Preferred path: GitHub Actions checks out ValveSoftware/source-sdk-2013 into _deps/source-sdk-2013-upstream.
# This avoids flaky codeload/curl behavior and avoids git credential leakage from the OpenVibe checkout.
$candidates = @(
  @{ Root = $Checkout; Label = 'upstream root/src' },
  @{ Root = (Join-Path $Checkout 'mp'); Label = 'upstream mp/src' },
  @{ Root = (Join-Path $Checkout 'sp'); Label = 'upstream sp/src' }
)
foreach ($c in $candidates) {
  if ((Test-Path $c.Root) -and (HasHl2mp $c.Root)) {
    CopyLayout $c.Root $c.Label
    exit 0
  }
}

# Emergency fallback only: try a clean public clone with credentials explicitly disabled.
# The workflow should normally never reach this if the actions/checkout step worked.
Say "actions checkout layout was not found; trying emergency public git clone fallback"
$Fallback = Join-Path $Deps 'source-sdk-2013-git-fallback'
if (Test-Path $Fallback) { Remove-Item -Recurse -Force $Fallback }
New-Item -ItemType Directory -Force -Path $Deps | Out-Null
$cloneLog = Join-Path $LogDir 'bootstrap-git-clone-fallback.log'
& git -c http.https://github.com/.extraheader= clone --depth 1 https://github.com/ValveSoftware/source-sdk-2013.git $Fallback 2>&1 | Tee-Object -FilePath $cloneLog
if ($LASTEXITCODE -ne 0) {
  WriteTree $Deps 'deps-after-bootstrap-failure.txt'
  throw "Could not clone ValveSoftware/source-sdk-2013. Check $cloneLog"
}

foreach ($root in @($Fallback, (Join-Path $Fallback 'mp'), (Join-Path $Fallback 'sp'))) {
  if ((Test-Path $root) -and (HasHl2mp $root)) {
    CopyLayout $root "git fallback $root"
    exit 0
  }
}

WriteTree $Fallback 'fallback-root-after-clone.txt'
throw "ValveSoftware/source-sdk-2013 was fetched, but no usable HL2MP src layout was found."
PS1

python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/windows-source-sdk-dlls.yml')
s = p.read_text()
insert = '''\n      - name: Checkout Valve Source SDK 2013\n        uses: actions/checkout@v4\n        with:\n          repository: ValveSoftware/source-sdk-2013\n          path: _deps/source-sdk-2013-upstream\n          fetch-depth: 1\n          persist-credentials: false\n\n'''
if 'Checkout Valve Source SDK 2013' not in s:
    marker = '      - name: Bootstrap Source SDK 2013\n'
    if marker not in s:
        raise SystemExit('Could not find Bootstrap Source SDK 2013 step in workflow')
    s = s.replace(marker, insert + marker, 1)
# Make the tree/debug step aware of the second checkout path if it exists later in the job.
old = "if (Test-Path engine/source-sdk-2013/src) { Get-ChildItem -Force engine/source-sdk-2013/src | Select-Object Mode,Length,Name } else { Write-Host \"[miss] engine/source-sdk-2013/src\" }"
new = old + "\n          if (Test-Path _deps/source-sdk-2013-upstream) { Get-ChildItem -Force _deps/source-sdk-2013-upstream | Select-Object Mode,Length,Name } else { Write-Host \"[miss] _deps/source-sdk-2013-upstream before checkout step\" }"
if old in s and '_deps/source-sdk-2013-upstream before checkout step' not in s:
    s = s.replace(old, new, 1)
p.write_text(s)
PY

cat > docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md <<'MD'
# Windows Source SDK bootstrap

The Windows DLL workflow uses a two-checkout model:

1. Checkout this OpenVibe repository.
2. Checkout `ValveSoftware/source-sdk-2013` into `_deps/source-sdk-2013-upstream`.
3. Normalize the Valve SDK layout into `engine/source-sdk-2013`.
4. Apply OpenVibe SDK patches.
5. Build `client.dll` and `server.dll` with MSBuild.

The bootstrap script accepts these upstream layouts:

- `_deps/source-sdk-2013-upstream/src/...`
- `_deps/source-sdk-2013-upstream/mp/src/...`
- `_deps/source-sdk-2013-upstream/sp/src/...`

Diagnostics are uploaded under the `openvibe-windows-build-debug` artifact.
MD

say "git diff summary"
git diff --stat -- .gitignore "$WORKFLOW_PATH" "$BOOT" docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md || true

git add .gitignore "$WORKFLOW_PATH" "$BOOT" docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md "$0" 2>/dev/null || \
  git add .gitignore "$WORKFLOW_PATH" "$BOOT" docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md tools/fix-windows-bootstrap-actions-checkout-and-rerun.sh

git commit -m "Use actions checkout for Windows Source SDK bootstrap" || say "nothing to commit"
git push

say "triggering workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
say "watching run $RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  say "workflow passed"
else
  say "workflow failed; downloading diagnostics anyway"
fi

if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
  tools/windows-workflow-debug-and-install.sh || true
fi

say "verify DLL content"
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh || true
fi

say "done"
