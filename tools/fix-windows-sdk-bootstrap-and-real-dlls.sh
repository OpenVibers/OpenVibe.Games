#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="${OPENVIBE_GITHUB_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="windows-source-sdk-dlls.yml"

echo "[openvibe] fix Windows SDK bootstrap + real DLL artifact validation"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=$BRANCH"
echo "[openvibe] repo=$REPO"

mkdir -p tools .github/workflows docs

cat > tools/bootstrap-source-sdk-2013-windows.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$ValveRepo = Join-Path $Deps 'source-sdk-2013'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }

Say "root=$Root"
Say "sdk=$Sdk"

if ((Test-Path (Join-Path $Src 'game/client/hl2mp')) -and (Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
  Say "existing SDK tree looks usable"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Deps | Out-Null

if (!(Test-Path (Join-Path $ValveRepo '.git'))) {
  Say "cloning ValveSoftware/source-sdk-2013"
  if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }
  git clone --depth 1 https://github.com/ValveSoftware/source-sdk-2013.git $ValveRepo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-clone.log')
} else {
  Say "updating cached Valve source-sdk-2013"
  Push-Location $ValveRepo
  git fetch --depth 1 origin 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-fetch.log')
  git reset --hard origin/master 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-reset.log')
  Pop-Location
}

$Mp = Join-Path $ValveRepo 'mp'
if (!(Test-Path (Join-Path $Mp 'src'))) {
  Get-ChildItem -Force $ValveRepo | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'valve-repo-root.txt')
  throw "Valve source-sdk-2013 clone does not contain mp/src at $Mp/src"
}

Say "copying mp branch layout into $Sdk"
if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
Copy-Item -Path (Join-Path $Mp '*') -Destination $Sdk -Recurse -Force

if (!(Test-Path (Join-Path $Src 'game/client/hl2mp')) -or !(Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
  Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
  throw "Bootstrapped SDK is missing expected HL2MP folders"
}

Say "SDK bootstrapped successfully"
PS1

cat > tools/build-sdk-windows.ps1 <<'PS1'
param(
  [switch]$InDevShell
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root "engine/source-sdk-2013" }
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }
function Require($p, $msg) { if (!(Test-Path $p)) { throw "$msg`nMissing: $p" } }

function Enter-MsvcDevShellIfNeeded {
  if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
    Say "cl.exe already available"
    return
  }
  if ($InDevShell) { throw "cl.exe still not found after entering MSVC dev shell" }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
  if (!(Test-Path $vswhere)) { throw "vswhere.exe not found; Visual Studio Build Tools are not installed" }

  $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (!$install) { throw "Could not find Visual Studio installation with VC x86/x64 tools" }

  $vcvars = Join-Path $install "VC/Auxiliary/Build/vcvars32.bat"
  if (!(Test-Path $vcvars)) { throw "vcvars32.bat not found at $vcvars" }

  Say "relaunching through MSVC x86 dev shell: $vcvars"
  $self = $PSCommandPath
  $cmd = "call `"$vcvars`" && powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -InDevShell"
  & cmd.exe /d /s /c $cmd
  exit $LASTEXITCODE
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"

$env:OPENVIBE_ROOT = $Root
$env:OPENVIBE_SDK = $Sdk

if (!(Test-Path $Src)) {
  Say "SDK src missing; bootstrapping Source SDK 2013 MP"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/bootstrap-source-sdk-2013-windows.ps1")
  if ($LASTEXITCODE -ne 0) { throw "bootstrap-source-sdk-2013-windows.ps1 failed with exit code $LASTEXITCODE" }
}

Require $Src "Source SDK checkout is missing from this runner."
Require (Join-Path $Src "game/client/hl2mp") "Source SDK HL2MP client tree missing."
Require (Join-Path $Src "game/server/hl2mp") "Source SDK HL2MP server tree missing."

Enter-MsvcDevShellIfNeeded

# Do not let old/stock repo DLLs get mistaken for a successful new build.
New-Item -ItemType Directory -Force -Path $OutBin | Out-Null
Remove-Item (Join-Path $OutBin "client.dll") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $OutBin "server.dll") -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $Sdk "game/mod_hl2mp/bin") -ErrorAction SilentlyContinue

# Apply OpenVibe source files using Git Bash. Skip the Linux QuickJS build inside apply-openvibe-sdk.sh.
$bash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($bash) {
  Say "applying OpenVibe SDK patch through bash"
  $env:OPENVIBE_SKIP_QJS_BUILD = "1"
  & bash "$Root/tools/apply-openvibe-sdk.sh" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "apply-openvibe-sdk.log")
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed with exit code $LASTEXITCODE" }
} else {
  throw "Git Bash is required on the Windows runner to apply the OpenVibe SDK patch."
}

Say "building QuickJS Windows static library"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/build-quickjs-lib-windows.ps1") 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "quickjs-windows.log")
if ($LASTEXITCODE -ne 0) { throw "build-quickjs-lib-windows.ps1 failed with exit code $LASTEXITCODE" }

Set-Location $Src

# Generate Visual Studio project files if needed.
$solutions = @(Get-ChildItem -Path $Src -Recurse -Filter "*.sln" -ErrorAction SilentlyContinue)
if ($solutions.Count -eq 0) {
  Say "no .sln files found; trying Source SDK project generators"
  $generators = @(
    (Join-Path $Src "creategameprojects.bat"),
    (Join-Path $Src "createallprojects.bat"),
    (Join-Path $Src "createprojects.bat")
  )
  $ran = $false
  foreach ($gen in $generators) {
    if (Test-Path $gen) {
      Say "running $gen"
      & cmd /d /s /c "`"$gen`"" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "project-generation.log")
      $ran = $true
      break
    }
  }

  if (-not $ran) {
    $vpc = Join-Path $Src "devtools/bin/vpc.exe"
    if (Test-Path $vpc) {
      Say "running vpc.exe fallback"
      & $vpc /hl2mp +game /mksln OpenVibe_HL2MP.sln 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "vpc.log")
      $ran = $true
    }
  }

  $solutions = @(Get-ChildItem -Path $Src -Recurse -Filter "*.sln" -ErrorAction SilentlyContinue)
  if ($solutions.Count -eq 0) {
    Get-ChildItem -Path $Src -Force | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir "src-root-after-generator.txt")
    throw "No Visual Studio solution was generated. Check openvibe-windows-build-debug artifact."
  }
}

Say "solutions found:"
$solutions | ForEach-Object { Say "  $($_.FullName)" }

$solution = $solutions |
  Where-Object { $_.Name -match "hl2mp|game|sdk|everything|OpenVibe" } |
  Select-Object -First 1
if (-not $solution) { $solution = $solutions | Select-Object -First 1 }
Say "selected solution=$($solution.FullName)"

$configs = @("Release", "Release_HL2MP", "Release HL2MP")
$platforms = @("Win32", "x86")
$targets = @("client_hl2mp", "server_hl2mp", "client", "server", "Build")

$builtAny = $false
foreach ($cfg in $configs) {
  foreach ($plat in $platforms) {
    foreach ($target in $targets) {
      Say "msbuild cfg=$cfg platform=$plat target=$target"
      $log = Join-Path $LogDir "msbuild-$($cfg -replace '[^A-Za-z0-9]','_')-$plat-$target.log"
      & msbuild $solution.FullName /m /p:Configuration=$cfg /p:Platform=$plat /p:PlatformToolset=v143 /t:$target /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log
      if ($LASTEXITCODE -eq 0) { $builtAny = $true; break }
    }
    if ($builtAny) { break }
  }
  if ($builtAny) { break }
}

if (-not $builtAny) { throw "MSBuild could not build any known Source SDK HL2MP target. Check uploaded msbuild logs." }

New-Item -ItemType Directory -Force -Path $OutBin | Out-Null

$client = Get-ChildItem -Path $Sdk -Recurse -Filter client.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "hl2mp|mod_hl2mp|client" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$server = Get-ChildItem -Path $Sdk -Recurse -Filter server.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "hl2mp|mod_hl2mp|server" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $client) { throw "client.dll was not produced" }
if (-not $server) { throw "server.dll was not produced" }

Say "copy client=$($client.FullName)"
Say "copy server=$($server.FullName)"
Copy-Item $client.FullName (Join-Path $OutBin "client.dll") -Force
Copy-Item $server.FullName (Join-Path $OutBin "server.dll") -Force

$clientText = & strings.exe (Join-Path $OutBin "client.dll") 2>$null | Select-String -Pattern "ov_join|ov_menu|OpenVibe" -Quiet
if (-not $clientText) { throw "Built client.dll does not contain OpenVibe strings; refusing to publish stale/stock DLL" }

Say "done"
PS1

python3 - <<'PY'
from pathlib import Path
p = Path('tools/apply-openvibe-sdk.sh')
s = p.read_text()
old = '''copy_tree() {\n  local src="$1"\n  local dst="$2"\n  mkdir -p "$dst"\n  rsync -a --delete "$src/" "$dst/"\n  echo "[openvibe-sdk] copied tree ${dst#$SDK/}"\n}\n'''
new = '''copy_tree() {\n  local src="$1"\n  local dst="$2"\n  mkdir -p "$dst"\n  if command -v rsync >/dev/null 2>&1; then\n    rsync -a --delete "$src/" "$dst/"\n  else\n    rm -rf "$dst"\n    mkdir -p "$dst"\n    cp -R "$src"/. "$dst"/\n  fi\n  echo "[openvibe-sdk] copied tree ${dst#$SDK/}"\n}\n'''
if old not in s:
    raise SystemExit('Could not patch copy_tree() in tools/apply-openvibe-sdk.sh')
p.write_text(s.replace(old, new))
PY

cat > .github/workflows/windows-source-sdk-dlls.yml <<'YAML'
name: Build Windows Source DLLs

on:
  workflow_dispatch:
    inputs:
      diagnostics:
        description: "Upload verbose build diagnostics"
        required: false
        default: "1"
  push:
    branches:
      - codex/openvibe-next-steps
    paths:
      - ".github/workflows/windows-source-sdk-dlls.yml"
      - "tools/bootstrap-source-sdk-2013-windows.ps1"
      - "tools/build-sdk-windows.ps1"
      - "tools/build-quickjs-lib-windows.ps1"
      - "tools/apply-openvibe-sdk.sh"
      - "sdk/openvibe/**"
      - "game/openvibe.games/js/**"

permissions:
  contents: read
  actions: read

jobs:
  windows-dlls:
    name: Windows client.dll/server.dll
    runs-on: windows-2022
    defaults:
      run:
        shell: pwsh

    steps:
      - name: Checkout OpenVibe
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Configure git line endings
        run: |
          git config --global core.autocrlf false
          git config --global core.eol lf
          git status --short

      - name: Setup MSBuild
        uses: microsoft/setup-msbuild@v2

      - name: Show toolchain and tree
        run: |
          $ErrorActionPreference = 'Continue'
          New-Item -ItemType Directory -Force -Path artifacts/windows-build-debug | Out-Null
          Write-Host "pwd=$(Get-Location)"
          git rev-parse --short HEAD
          where.exe msbuild
          where.exe cl
          where.exe link
          where.exe bash
          where.exe git
          Get-ChildItem -Force | Select-Object Mode,Length,Name | Tee-Object -FilePath artifacts/windows-build-debug/repo-root-before-build.txt
          if (Test-Path engine) { Get-ChildItem -Force engine | Select-Object Mode,Length,Name | Tee-Object -FilePath artifacts/windows-build-debug/engine-before-build.txt } else { Write-Host "[miss] engine directory" }

      - name: Bootstrap Source SDK 2013 MP
        run: |
          $ErrorActionPreference = 'Stop'
          powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-source-sdk-2013-windows.ps1 *>&1 | Tee-Object -FilePath artifacts/windows-build-debug/bootstrap-source-sdk-2013.log

      - name: Build Windows Source SDK DLLs
        id: build
        run: |
          $ErrorActionPreference = 'Stop'
          New-Item -ItemType Directory -Force -Path artifacts/windows-build-debug | Out-Null
          powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-sdk-windows.ps1 *>&1 | Tee-Object -FilePath artifacts/windows-build-debug/build-sdk-windows.log

      - name: Stage build outputs and diagnostics
        if: always()
        run: |
          $ErrorActionPreference = 'Continue'
          New-Item -ItemType Directory -Force -Path artifacts/windows-dlls | Out-Null
          New-Item -ItemType Directory -Force -Path artifacts/windows-build-debug | Out-Null

          "=== repo ===" | Out-File artifacts/windows-build-debug/tree.txt
          Get-ChildItem -Force | Format-Table -AutoSize | Out-File artifacts/windows-build-debug/tree.txt -Append
          "=== dll search ===" | Out-File artifacts/windows-build-debug/dll-search.txt
          Get-ChildItem -Recurse -Force -Include client.dll,server.dll -ErrorAction SilentlyContinue |
            Select-Object FullName,Length,LastWriteTime |
            Format-List | Out-File artifacts/windows-build-debug/dll-search.txt -Append
          "=== project/log search ===" | Out-File artifacts/windows-build-debug/project-search.txt
          Get-ChildItem -Recurse -Force -Include *.sln,*.vcxproj,*.vcproj,*.log -ErrorAction SilentlyContinue |
            Select-Object FullName,Length,LastWriteTime |
            Format-List | Out-File artifacts/windows-build-debug/project-search.txt -Append

          $client = "game/openvibe.games/bin/client.dll"
          $server = "game/openvibe.games/bin/server.dll"
          $clientOk = $false
          if (Test-Path $client) {
            $text = strings.exe $client 2>$null | Select-String -Pattern "ov_join|ov_menu|OpenVibe" -Quiet
            if ($text) { $clientOk = $true }
          }
          if ($clientOk -and (Test-Path $server)) {
            Copy-Item $client artifacts/windows-dlls/client.dll -Force
            Copy-Item $server artifacts/windows-dlls/server.dll -Force
            Write-Host "[ok] staged patched OpenVibe Windows DLLs"
          } else {
            Write-Host "[miss] not staging DLLs because patched OpenVibe client.dll was not produced"
            "No patched OpenVibe DLLs staged. Check build logs." | Out-File artifacts/windows-build-debug/no-patched-dlls.txt
          }

      - name: Upload Windows DLL artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: openvibe-windows-dlls
          path: artifacts/windows-dlls/**
          if-no-files-found: warn

      - name: Upload Windows build diagnostics
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: openvibe-windows-build-debug
          path: artifacts/windows-build-debug/**
          if-no-files-found: warn
YAML

cat > tools/windows-workflow-debug-and-install.sh <<'BASH2'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
REPO="${OPENVIBE_GITHUB_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
RUN_ID="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "[openvibe] missing gh. Install with: sudo apt install gh" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi

OUT="$ROOT/artifacts/windows-workflow-debug/run-$RUN_ID-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[openvibe] run=$RUN_ID"
echo "[openvibe] downloading logs/artifacts into $OUT"

gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/full-run.log" || true
gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" || true

find "$OUT" -maxdepth 3 -type f | sort > "$OUT/file-list.txt"

echo
echo "[openvibe] likely errors:"
grep -RniE "error MSB|fatal error|undefined reference|unresolved external|LNK[0-9]+|C[0-9]{4}:|throw |Missing:|not found|could not|failed|No Visual Studio solution|No patched" "$OUT" | tail -n 120 || true

echo
echo "[openvibe] artifact files:"
sed -n '1,160p' "$OUT/file-list.txt"

DLLDIR="$OUT/openvibe-windows-dlls"
if [[ -f "$DLLDIR/client.dll" && -f "$DLLDIR/server.dll" ]]; then
  if strings "$DLLDIR/client.dll" | grep -Eq 'ov_join|ov_menu|OpenVibe'; then
    mkdir -p game/openvibe.games/bin
    cp -f "$DLLDIR/client.dll" game/openvibe.games/bin/client.dll
    cp -f "$DLLDIR/server.dll" game/openvibe.games/bin/server.dll
    echo "[openvibe] installed patched Windows DLLs"
    tools/verify-openvibe-dll-content.sh || true
  else
    echo "[openvibe] refused to install DLL artifact because client.dll lacks OpenVibe strings" >&2
    exit 2
  fi
else
  echo "[openvibe] no DLL artifact available yet" >&2
  exit 3
fi
BASH2
chmod +x tools/windows-workflow-debug-and-install.sh

cat > docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md <<'MD'
# Windows DLL workflow bootstrap

The Windows GitHub Actions runner does not have the local `engine/source-sdk-2013` checkout that exists on the Linux workstation.

The workflow now bootstraps Valve's Source SDK 2013 multiplayer tree into:

```text
engine/source-sdk-2013
```

Then it applies the OpenVibe SDK patch, skips the Linux QuickJS static-library build, builds QuickJS with MSVC, generates Visual Studio projects, builds `client.dll/server.dll`, and only uploads DLLs when `client.dll` contains OpenVibe command strings such as `ov_join`, `ov_menu`, or `OpenVibe`.

Use:

```bash
tools/gh-windows-build-and-install.sh
```

or debug the latest run with:

```bash
tools/windows-workflow-debug-and-install.sh
```
MD

# Keep gh helper stricter if present: do not install stale DLLs.
if [[ -f tools/gh-windows-build-and-install.sh ]]; then
python3 - <<'PY'
from pathlib import Path
p = Path('tools/gh-windows-build-and-install.sh')
s = p.read_text()
if 'strings "$ARTDIR/openvibe-windows-dlls/client.dll"' not in s and 'refused to install DLL artifact' not in s:
    marker = 'if [[ -f "$ARTDIR/openvibe-windows-dlls/client.dll" && -f "$ARTDIR/openvibe-windows-dlls/server.dll" ]]; then'
    if marker in s:
        repl = marker + '''
  if ! strings "$ARTDIR/openvibe-windows-dlls/client.dll" | grep -Eq 'ov_join|ov_menu|OpenVibe'; then
    echo "[openvibe] refused to install DLL artifact because client.dll lacks OpenVibe strings" >&2
    tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
    exit 2
  fi'''
        s = s.replace(marker, repl)
        p.write_text(s)
PY
fi

# Commit/push and run workflow if gh is available.
echo
echo "[openvibe] git diff summary"
git diff --stat

git add \
  .github/workflows/windows-source-sdk-dlls.yml \
  tools/bootstrap-source-sdk-2013-windows.ps1 \
  tools/build-sdk-windows.ps1 \
  tools/apply-openvibe-sdk.sh \
  tools/windows-workflow-debug-and-install.sh \
  tools/gh-windows-build-and-install.sh \
  docs/WINDOWS_WORKFLOW_SDK_BOOTSTRAP.md 2>/dev/null || true

if ! git diff --cached --quiet; then
  git commit -m "Bootstrap Source SDK for Windows DLL workflow"
  git push origin "$BRANCH"
else
  echo "[openvibe] no changes to commit"
fi

if command -v gh >/dev/null 2>&1; then
  echo "[openvibe] triggering workflow"
  gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1
  sleep 6
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "[openvibe] watching run $RUN_ID"
  gh run watch "$RUN_ID" --repo "$REPO" || true
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
else
  echo "[openvibe] gh missing; run tools/gh-windows-build-and-install.sh after installing/authenticating gh"
fi

echo
echo "[openvibe] next if DLLs installed:"
echo "  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015"
echo "  # in game console: ov_join hub ; ov_menu ; ov_menu_servers"
