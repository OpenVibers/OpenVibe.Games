#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
REPO="${OPENVIBE_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
LOG_DIR="$ROOT/artifacts/windows-workflow-debug"

cd "$ROOT"

echo "[openvibe] fix Windows workflow diagnostics + rerun"
echo "[openvibe] root=$ROOT"
echo "[openvibe] repo=$REPO"
echo "[openvibe] workflow=$WORKFLOW"
echo "[openvibe] branch=$BRANCH"

if ! command -v gh >/dev/null 2>&1; then
  echo "[openvibe error] gh is required. Install/auth first:" >&2
  echo "  sudo apt update && sudo apt install gh" >&2
  echo "  gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "[openvibe error] gh is installed but not authenticated. Run:" >&2
  echo "  gh auth login" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

latest_run="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
if [[ -n "$latest_run" ]]; then
  echo "[openvibe] latest workflow run=$latest_run"
  echo "[openvibe] saving failed/full logs into $LOG_DIR"
  gh run view "$latest_run" --repo "$REPO" --log-failed > "$LOG_DIR/run-${latest_run}-failed.log" 2>&1 || true
  gh run view "$latest_run" --repo "$REPO" --log > "$LOG_DIR/run-${latest_run}-full.log" 2>&1 || true

  echo "[openvibe] likely error snippets:"
  grep -Eina "error|fatal|exception|not found|cannot find|MSB[0-9]+|LNK[0-9]+|C[0-9]{4}|No such|missing|failed" \
    "$LOG_DIR/run-${latest_run}-failed.log" "$LOG_DIR/run-${latest_run}-full.log" \
    | tail -n 80 || true
else
  echo "[openvibe warn] no existing workflow run found yet"
fi

echo

echo "[openvibe] rewriting Windows workflow to always upload logs/artifacts"
mkdir -p .github/workflows
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
          Write-Host "pwd=$(Get-Location)"
          git rev-parse --short HEAD
          where.exe msbuild
          where.exe cl
          where.exe link
          where.exe bash
          Get-ChildItem -Force | Select-Object Mode,Length,Name
          if (Test-Path engine) { Get-ChildItem -Force engine | Select-Object Mode,Length,Name } else { Write-Host "[miss] engine directory" }
          if (Test-Path engine/source-sdk-2013/src) { Get-ChildItem -Force engine/source-sdk-2013/src | Select-Object Mode,Length,Name } else { Write-Host "[miss] engine/source-sdk-2013/src" }

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
          "=== vc/sln search ===" | Out-File artifacts/windows-build-debug/project-search.txt
          Get-ChildItem -Recurse -Force -Include *.sln,*.vcxproj,*.vcproj,*.log -ErrorAction SilentlyContinue |
            Select-Object FullName,Length,LastWriteTime |
            Format-List | Out-File artifacts/windows-build-debug/project-search.txt -Append

          $clientCandidates = @(
            "game/openvibe.games/bin/client.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/client.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/win64/client.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/Release/client.dll",
            "engine/source-sdk-2013/src/game/client/Release_hl2mp/client.dll",
            "engine/source-sdk-2013/src/game/client/Release/client.dll"
          )
          $serverCandidates = @(
            "game/openvibe.games/bin/server.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/server.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/win64/server.dll",
            "engine/source-sdk-2013/game/mod_hl2mp/bin/Release/server.dll",
            "engine/source-sdk-2013/src/game/server/Release_hl2mp/server.dll",
            "engine/source-sdk-2013/src/game/server/Release/server.dll"
          )

          $client = $clientCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
          $server = $serverCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
          if ($client) { Copy-Item $client artifacts/windows-dlls/client.dll -Force }
          if ($server) { Copy-Item $server artifacts/windows-dlls/server.dll -Force }

          if (Test-Path artifacts/windows-dlls/client.dll) {
            $clientText = (Select-String -Path artifacts/windows-dlls/client.dll -Pattern "ov_join|ov_menu|OpenVibe" -Encoding Byte -SimpleMatch -Quiet)
            Write-Host "client.dll staged"
          } else {
            Write-Host "[miss] no client.dll staged"
          }
          if (Test-Path artifacts/windows-dlls/server.dll) { Write-Host "server.dll staged" } else { Write-Host "[miss] no server.dll staged" }

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

cat > tools/build-sdk-windows.ps1 <<'PS1'
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Sdk = Join-Path $Root "engine/source-sdk-2013"
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$Qjs = Join-Path $Src "game/shared/openvibe/third_party/quickjs"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }
function Require($p, $msg) {
  if (!(Test-Path $p)) { throw "$msg`nMissing: $p" }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"
Require $Src "Source SDK checkout is missing from this runner. The workflow must have engine/source-sdk-2013 available in the repository/submodule before Windows DLLs can build."

# Apply OpenVibe source files using Git Bash when available. This reuses the Linux patcher on Windows runners.
$bash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($bash) {
  Say "applying OpenVibe SDK patch through bash"
  & bash "$Root/tools/apply-openvibe-sdk.sh"
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed with exit code $LASTEXITCODE" }
} else {
  throw "Git Bash is required on the Windows runner to apply the OpenVibe SDK patch."
}

# Build QuickJS as MSVC objects/lib. The Linux .a cannot be linked into Windows DLLs.
if (Test-Path (Join-Path $Root "tools/build-quickjs-lib-windows.ps1")) {
  Say "building QuickJS Windows static library"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/build-quickjs-lib-windows.ps1")
  if ($LASTEXITCODE -ne 0) { throw "build-quickjs-lib-windows.ps1 failed with exit code $LASTEXITCODE" }
} else {
  Say "no build-quickjs-lib-windows.ps1 found; continuing"
}

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
      & cmd /c "`"$gen`"" | Tee-Object -FilePath (Join-Path $LogDir "project-generation.log")
      $ran = $true
      break
    }
  }

  if (-not $ran) {
    $vpc = Join-Path $Src "devtools/bin/vpc.exe"
    if (Test-Path $vpc) {
      Say "running vpc.exe fallback"
      & $vpc /hl2mp +game /mksln OpenVibe_HL2MP.sln | Tee-Object -FilePath (Join-Path $LogDir "vpc.log")
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

# Pick the most likely HL2MP/game solution.
$solution = $solutions |
  Where-Object { $_.Name -match "hl2mp|game|sdk|everything|OpenVibe" } |
  Select-Object -First 1
if (-not $solution) { $solution = $solutions | Select-Object -First 1 }
Say "selected solution=$($solution.FullName)"

# Try common project targets/configurations. Source SDK projects vary by branch/version.
$configs = @("Release", "Release_HL2MP", "Release HL2MP")
$platforms = @("Win32", "x86")
$targets = @("client_hl2mp", "server_hl2mp", "client", "server", "Build")

$builtAny = $false
foreach ($cfg in $configs) {
  foreach ($plat in $platforms) {
    foreach ($target in $targets) {
      Say "msbuild cfg=$cfg platform=$plat target=$target"
      & msbuild $solution.FullName /m /p:Configuration=$cfg /p:Platform=$plat /t:$target /v:minimal /nologo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "msbuild-$($cfg -replace '[^A-Za-z0-9]','_')-$plat-$target.log")
      if ($LASTEXITCODE -eq 0) {
        $builtAny = $true
        break
      }
    }
    if ($builtAny) { break }
  }
  if ($builtAny) { break }
}

if (-not $builtAny) {
  throw "MSBuild could not build any known Source SDK HL2MP target. Check uploaded msbuild logs."
}

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

Say "done"
PS1

# Add a local helper that downloads full logs/artifacts from the last run even when failed.
cat > tools/windows-workflow-debug-and-install.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
REPO="${OPENVIBE_REPO:-OpenVibers/OpenVibe.Games}"
WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
OUT="$ROOT/artifacts/windows-workflow-debug"
cd "$ROOT"
mkdir -p "$OUT"
run="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "[openvibe] latest run=$run"
gh run view "$run" --repo "$REPO" --log > "$OUT/run-${run}.log" 2>&1 || true
gh run view "$run" --repo "$REPO" --log-failed > "$OUT/run-${run}-failed.log" 2>&1 || true
gh run download "$run" --repo "$REPO" --dir "$OUT/run-${run}-artifacts" || true
printf '\n[openvibe] tail of failed log:\n'
tail -n 160 "$OUT/run-${run}-failed.log" || true
printf '\n[openvibe] artifacts saved under: %s\n' "$OUT/run-${run}-artifacts"
if [[ -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/client.dll" && -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/server.dll" ]]; then
  mkdir -p game/openvibe.games/bin
  cp -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/client.dll" game/openvibe.games/bin/client.dll
  cp -f "$OUT/run-${run}-artifacts/openvibe-windows-dlls/server.dll" game/openvibe.games/bin/server.dll
  echo "[openvibe] installed DLL artifacts"
  tools/verify-openvibe-dll-content.sh || true
else
  echo "[openvibe] no DLL artifact available yet; check debug artifact/logs"
fi
SH
chmod +x tools/windows-workflow-debug-and-install.sh

git add .github/workflows/windows-source-sdk-dlls.yml tools/build-sdk-windows.ps1 tools/windows-workflow-debug-and-install.sh

if ! git diff --cached --quiet; then
  echo "[openvibe] committing workflow/build diagnostic patch"
  git commit -m "Improve Windows DLL workflow diagnostics"
  echo "[openvibe] pushing $BRANCH"
  git push origin "$BRANCH"
else
  echo "[openvibe] no workflow/build changes to commit"
fi

echo "[openvibe] triggering updated workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"

echo "[openvibe] waiting for new workflow run to appear"
sleep 5
new_run="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
if [[ -z "$new_run" ]]; then
  echo "[openvibe error] could not find new workflow run" >&2
  exit 1
fi

echo "[openvibe] watching run $new_run"
set +e
gh run watch "$new_run" --repo "$REPO" --exit-status
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "[openvibe] workflow passed; downloading artifacts"
else
  echo "[openvibe warn] workflow still failed; downloading diagnostics anyway"
fi

tools/windows-workflow-debug-and-install.sh

if [[ $status -ne 0 ]]; then
  echo
  echo "[openvibe] next: paste the tail printed above if you want me to patch the exact compile error."
  exit $status
fi
