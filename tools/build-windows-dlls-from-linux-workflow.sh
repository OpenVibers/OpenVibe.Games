#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

echo "[openvibe] adding Windows DLL build-from-Linux workflow helpers"
echo "[openvibe] root=$ROOT"

mkdir -p .github/workflows tools docs .tmp

cat > .github/workflows/windows-source-sdk-dlls.yml <<'YAML'
name: Build Windows Source DLLs

on:
  workflow_dispatch:
  push:
    branches:
      - codex/openvibe-next-steps
    paths:
      - 'sdk/openvibe/**'
      - 'game/openvibe.games/**'
      - 'tools/build-sdk-windows.ps1'
      - 'tools/build-quickjs-lib-windows.ps1'
      - '.github/workflows/windows-source-sdk-dlls.yml'

jobs:
  windows-dlls:
    name: Windows client.dll/server.dll
    runs-on: windows-2022
    timeout-minutes: 90

    steps:
      - name: Checkout OpenVibe
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Configure git line endings
        shell: pwsh
        run: |
          git config --global core.autocrlf false

      - name: Setup MSBuild
        uses: microsoft/setup-msbuild@v2

      - name: Show toolchain
        shell: pwsh
        run: |
          where msbuild
          where cl
          git --version
          pwsh --version

      - name: Build Windows Source SDK DLLs
        shell: pwsh
        run: |
          powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-sdk-windows.ps1

      - name: Stage artifacts
        shell: pwsh
        run: |
          New-Item -Force -ItemType Directory artifact\game\openvibe.games\bin | Out-Null
          New-Item -Force -ItemType Directory artifact\logs | Out-Null

          $candidates = @(
            "game\openvibe.games\bin\client.dll",
            "game\openvibe.games\bin\server.dll",
            "engine\source-sdk-2013\game\mod_hl2mp\bin\client.dll",
            "engine\source-sdk-2013\game\mod_hl2mp\bin\server.dll",
            "engine\source-sdk-2013\game\mod_hl2mp\bin\client.pdb",
            "engine\source-sdk-2013\game\mod_hl2mp\bin\server.pdb"
          )

          foreach ($file in $candidates) {
            if (Test-Path $file) {
              Copy-Item $file artifact\game\openvibe.games\bin\ -Force
            }
          }

          if (Test-Path "windows-build.log") {
            Copy-Item windows-build.log artifact\logs\windows-build.log -Force
          }

          Get-ChildItem artifact -Recurse | Format-Table FullName,Length

      - name: Upload Windows DLL artifact
        uses: actions/upload-artifact@v4
        with:
          name: openvibe-windows-dlls
          path: artifact/**
          if-no-files-found: error
YAML

cat > tools/request-windows-dll-build.sh <<'REQ'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
ARTIFACT="${OPENVIBE_WINDOWS_ARTIFACT:-openvibe-windows-dlls}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
OUT_DIR="${OPENVIBE_WINDOWS_ARTIFACT_DIR:-$ROOT/.tmp/windows-dll-artifact}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing GitHub CLI: gh" >&2
  echo "Install it, then run: gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[openvibe] WARNING: working tree has uncommitted changes."
  echo "[openvibe] GitHub Actions builds the pushed branch, not your uncommitted local files."
  echo
  git status --short
  echo
  read -r -p "Continue anyway? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

echo "[openvibe] triggering GitHub Actions Windows DLL build"
echo "[openvibe] workflow=$WORKFLOW branch=$BRANCH"

gh workflow run "$WORKFLOW" --ref "$BRANCH"

echo "[openvibe] waiting for run to appear..."
RUN_ID=""
for _ in {1..30}; do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId,status,event -q '.[0].databaseId // empty' 2>/dev/null || true)"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done

if [[ -z "$RUN_ID" ]]; then
  echo "Could not find the workflow run. Check GitHub Actions UI." >&2
  exit 1
fi

echo "[openvibe] watching run $RUN_ID"
gh run watch "$RUN_ID" --exit-status

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "[openvibe] downloading artifact $ARTIFACT"
gh run download "$RUN_ID" --name "$ARTIFACT" --dir "$OUT_DIR"

echo "[openvibe] downloaded files:"
find "$OUT_DIR" -type f -maxdepth 8 -print | sort

echo
echo "[openvibe] installing Windows DLLs into game/openvibe.games/bin"
mkdir -p "$ROOT/game/openvibe.games/bin"

find "$OUT_DIR" -type f \( -iname 'client.dll' -o -iname 'server.dll' -o -iname 'client.pdb' -o -iname 'server.pdb' \) -print0 |
while IFS= read -r -d '' file; do
  cp -f "$file" "$ROOT/game/openvibe.games/bin/$(basename "$file")"
  echo "  installed $(basename "$file")"
done

echo
"$ROOT/tools/check-openvibe-platform-binaries.sh" || true

echo
echo "[openvibe] done."
echo "Proton/Windows can use:"
echo "  game/openvibe.games/bin/client.dll"
echo "  game/openvibe.games/bin/server.dll"
REQ
chmod +x tools/request-windows-dll-build.sh

cat > tools/check-openvibe-platform-binaries.sh <<'CHECK'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

linux_bin="$ROOT/game/openvibe.games/bin/linux64"
win_bin="$ROOT/game/openvibe.games/bin"

echo "[openvibe] platform binary check"
echo

check_file() {
  local label="$1"
  local file="$2"
  if [[ -f "$file" || -L "$file" ]]; then
    echo "[ok]      $label: ${file#$ROOT/}"
    file "$file" 2>/dev/null | sed 's/^/          /' || true
  else
    echo "[missing] $label: ${file#$ROOT/}"
  fi
}

check_file "Linux client" "$linux_bin/client.so"
check_file "Linux server" "$linux_bin/server.so"
check_file "Windows client" "$win_bin/client.dll"
check_file "Windows server" "$win_bin/server.dll"

echo
if [[ -f "$win_bin/client.dll" ]]; then
  echo "[openvibe] Proton Windows hl2.exe should be able to load the OpenVibe client DLL."
else
  echo "[openvibe] Proton Windows hl2.exe will NOT have in-game ov_* client commands until client.dll exists."
fi
CHECK
chmod +x tools/check-openvibe-platform-binaries.sh

cat > tools/probe-local-windows-build-on-linux.sh <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail

echo "[openvibe] local Windows build-on-Linux probe"
echo
echo "Pure MinGW cross-compile is not the recommended route for Source SDK 2013 client.dll."
echo "The Windows Source client DLL needs the MSVC ABI/toolchain and Valve's Windows project layout."
echo
echo "What this host has:"

for tool in wine wine64 cl link msbuild x86_64-w64-mingw32-g++ gh; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "[ok]      $tool -> $(command -v "$tool")"
  else
    echo "[missing] $tool"
  fi
done

echo
echo "Recommended from Linux:"
echo "  1. Commit/push your branch."
echo "  2. Run: tools/request-windows-dll-build.sh"
echo "  3. Let GitHub Actions Windows runner build client.dll/server.dll with MSVC."
echo
echo "Experimental local path:"
echo "  - Windows VM on Linux, or"
echo "  - Wine with Visual Studio Build Tools installed, then run tools/build-sdk-windows.ps1 under that environment."
echo "This is brittle; use the GitHub Actions/Windows runner first."
PROBE
chmod +x tools/probe-local-windows-build-on-linux.sh

cat > docs/BUILD_WINDOWS_DLLS_FROM_LINUX.md <<'DOC'
# Building Windows `client.dll` / `server.dll` from Linux

OpenVibe supports two binary families:

| Runtime | Client binary | Server binary | Notes |
| --- | --- | --- | --- |
| Native Linux Source | `game/openvibe.games/bin/linux64/client.so` | `game/openvibe.games/bin/linux64/server.so` | Built by the Linux SDK build. |
| Windows / Proton Source | `game/openvibe.games/bin/client.dll` | `game/openvibe.games/bin/server.dll` | Must be built with a Windows/MSVC-compatible toolchain. |

## Can Windows DLLs be built on Linux?

Operationally, yes: trigger a Windows build from Linux using GitHub Actions:

```bash
git push
tools/request-windows-dll-build.sh
```

That runs the build on a Windows runner, downloads the `openvibe-windows-dlls` artifact, and installs `client.dll` / `server.dll` into `game/openvibe.games/bin`.

## Why not just MinGW?

Source SDK 2013's Windows client/server DLLs are built around the MSVC ABI, Valve's VPC-generated Visual Studio projects, and Windows import/static libraries. A MinGW cross-compile from Linux is theoretically possible only after significant porting and import-library work, but it is not the practical path.

## Reliable options

1. **GitHub Actions Windows runner**: easiest from a Linux workstation.
2. **Windows VM on Linux**: build with Visual Studio Build Tools/MSBuild, copy DLLs back.
3. **Wine + Visual Studio Build Tools**: possible but brittle; treat as experimental.

## Test

```bash
tools/check-openvibe-platform-binaries.sh
OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015
```

If `client.dll` is present and correct, Proton's Windows `hl2.exe` should load OpenVibe client commands like `ov_join` and `ov_menu`.
DOC

# Make git keep workflows/docs/scripts.
git add .github/workflows/windows-source-sdk-dlls.yml \
  tools/request-windows-dll-build.sh \
  tools/check-openvibe-platform-binaries.sh \
  tools/probe-local-windows-build-on-linux.sh \
  docs/BUILD_WINDOWS_DLLS_FROM_LINUX.md

echo
echo "[openvibe] added Windows DLL build-from-Linux support."
echo
echo "Next:"
echo "  git status"
echo "  git commit -m \"Add Windows DLL build workflow helpers\""
echo "  git push"
echo "  tools/request-windows-dll-build.sh"
echo
echo "Probe this Linux host with:"
echo "  tools/probe-local-windows-build-on-linux.sh"
