#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

echo "[openvibe] adding multi-platform client/server binary support"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

backup_file() {
  local f="$1"
  [[ -f "$f" ]] && cp "$f" "$f.bak.$STAMP"
}

mkdir -p tools docs game/openvibe.games/bin game/openvibe.games/bin/linux64

# -----------------------------------------------------------------------------
# 1) Make apply-openvibe-sdk.sh usable from Windows/Git Bash by allowing the
#    QuickJS C build step to be skipped. Windows builds create a .lib via MSVC.
# -----------------------------------------------------------------------------
if [[ -f tools/apply-openvibe-sdk.sh ]]; then
  backup_file tools/apply-openvibe-sdk.sh
  python3 <<'PY'
from pathlib import Path
p = Path('tools/apply-openvibe-sdk.sh')
s = p.read_text()
old = '"$ROOT/tools/build-quickjs-lib.sh"'
new = '''if [[ "${OPENVIBE_SKIP_QJS_BUILD:-0}" != "1" ]]; then
  "$ROOT/tools/build-quickjs-lib.sh"
fi'''
if old in s and 'OPENVIBE_SKIP_QJS_BUILD' not in s:
    s = s.replace(old, new)
p.write_text(s)
PY
fi

# -----------------------------------------------------------------------------
# 2) Diagnostic: exactly which binaries exist and which runtime can load them.
# -----------------------------------------------------------------------------
cat > tools/check-openvibe-platform-binaries.sh <<'CHECK'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MOD="$ROOT/game/openvibe.games"
BIN="$MOD/bin"
LINUX_BIN="$BIN/linux64"

find_hl2_linux() {
  local candidates=(
    "${OPENVIBE_HL2_LINUX:-}"
    "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/6tb/ssd_offload/home/$USER/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

find_hl2_exe() {
  local candidates=(
    "${OPENVIBE_HL2_EXE:-}"
    "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe"
    "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe"
    "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -f "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

ok=0
warn=0

echo "[openvibe] platform binary matrix"
echo "mod: $MOD"
echo

check_file() {
  local label="$1" path="$2"
  if [[ -f "$path" || -L "$path" ]]; then
    echo "[ok]   $label: $path"
  else
    echo "[miss] $label: $path"
    warn=1
  fi
}

check_file "Linux native client module" "$LINUX_BIN/client.so"
check_file "Linux native server module" "$LINUX_BIN/server.so"
check_file "Windows/Proton client module" "$BIN/client.dll"
check_file "Windows/Proton server module" "$BIN/server.dll"

echo
if hl2_linux="$(find_hl2_linux 2>/dev/null)"; then
  echo "[ok]   Native Linux client executable: $hl2_linux"
else
  echo "[miss] Native Linux client executable: set OPENVIBE_HL2_LINUX or install Source SDK Base 2013 MP Linux"
  warn=1
fi

if hl2_exe="$(find_hl2_exe 2>/dev/null)"; then
  echo "[ok]   Windows/Proton client executable: $hl2_exe"
else
  echo "[miss] Windows hl2.exe for Proton/Windows client"
  warn=1
fi

echo
cat <<TEXT
Runtime rules:
  Linux native client loads:  game/openvibe.games/bin/linux64/client.so
  Linux native server loads:  game/openvibe.games/bin/linux64/server.so
  Windows native client loads: game/openvibe.games/bin/client.dll
  Proton client loads:        game/openvibe.games/bin/client.dll

If Proton/Windows says unknown command ov_join or ov_menu, client.dll is missing or failed to load.
Linux client.so cannot be loaded by Windows hl2.exe under Proton.
TEXT

exit 0
CHECK
chmod +x tools/check-openvibe-platform-binaries.sh

# -----------------------------------------------------------------------------
# 3) Setup script: keep Linux symlinks and also install/carry Windows DLLs when
#    they have been produced by a Windows build.
# -----------------------------------------------------------------------------
backup_file tools/setup-openvibe-bin.sh
cat > tools/setup-openvibe-bin.sh <<'SETUP'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
TF2_SRCDS="${OPENVIBE_SRCDS:-$HOME/srcds/tf2}"
MOD_BIN="$ROOT/game/openvibe.games/bin"
MOD_LINUX_BIN="$MOD_BIN/linux64"
SDK_HL2MP_LINUX_BIN="$ROOT/engine/source-sdk-2013/game/mod_hl2mp/bin/linux64"
SDK_LIB_BIN="$ROOT/engine/source-sdk-2013/src/lib/public/linux64"
TF2_BIN="$TF2_SRCDS/bin/linux64"
SDK_HL2MP_WIN_BIN="$ROOT/engine/source-sdk-2013/game/mod_hl2mp/bin"

mkdir -p "$MOD_LINUX_BIN" "$MOD_BIN"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    exit 1
  fi
}

link_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    ln -sfn "$src" "$dst"
    echo "[openvibe] linked ${dst#$ROOT/} -> $src"
  fi
}

copy_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    install -D -m 0644 "$src" "$dst"
    echo "[openvibe] copied ${dst#$ROOT/}"
    return 0
  fi
  return 1
}

# Linux native / Linux dedicated server modules.
require_file "$SDK_HL2MP_LINUX_BIN/client.so"
require_file "$SDK_HL2MP_LINUX_BIN/server.so"
require_file "$SDK_HL2MP_LINUX_BIN/game_shader_generic_example.so"
require_file "$SDK_LIB_BIN/libtier0.so"
require_file "$SDK_LIB_BIN/libvstdlib.so"
require_file "$SDK_LIB_BIN/libsteam_api.so"

ln -sfn "$SDK_HL2MP_LINUX_BIN/client.so" "$MOD_LINUX_BIN/client.so"
ln -sfn client.so "$MOD_LINUX_BIN/client_srv.so"
ln -sfn "$SDK_HL2MP_LINUX_BIN/server.so" "$MOD_LINUX_BIN/server.so"
ln -sfn server.so "$MOD_LINUX_BIN/server_srv.so"
ln -sfn "$SDK_HL2MP_LINUX_BIN/game_shader_generic_example.so" "$MOD_LINUX_BIN/game_shader_generic_example_srv.so"
ln -sfn "$SDK_LIB_BIN/libtier0.so" "$MOD_LINUX_BIN/libtier0.so"
ln -sfn "$SDK_LIB_BIN/libvstdlib.so" "$MOD_LINUX_BIN/libvstdlib.so"
ln -sfn "$SDK_LIB_BIN/libsteam_api.so" "$MOD_LINUX_BIN/libsteam_api.so"

if [[ -d "$TF2_BIN" ]]; then
  for module in soundemittersystem scenefilecache datacache materialsystem studiorender vphysics vscript replay shaderapiempty; do
    if [[ -f "$TF2_BIN/${module}_srv.so" ]]; then
      ln -sfn "$TF2_BIN/${module}_srv.so" "$MOD_LINUX_BIN/${module}.so"
    fi
  done
fi

echo "[openvibe] linux bin/linux64 compatibility links ready"

# Windows/Proton modules. These are optional on Linux until a Windows build has run.
win_client_candidates=(
  "$SDK_HL2MP_WIN_BIN/client.dll"
  "$SDK_HL2MP_WIN_BIN/win32/client.dll"
  "$ROOT/engine/source-sdk-2013/src/game/client/Release_hl2mp/client.dll"
  "$ROOT/engine/source-sdk-2013/src/game/client/Release/client.dll"
)
win_server_candidates=(
  "$SDK_HL2MP_WIN_BIN/server.dll"
  "$SDK_HL2MP_WIN_BIN/win32/server.dll"
  "$ROOT/engine/source-sdk-2013/src/game/server/Release_hl2mp/server.dll"
  "$ROOT/engine/source-sdk-2013/src/game/server/Release/server.dll"
)

for src in "${win_client_candidates[@]}"; do
  if copy_if_exists "$src" "$MOD_BIN/client.dll"; then break; fi
done
for src in "${win_server_candidates[@]}"; do
  if copy_if_exists "$src" "$MOD_BIN/server.dll"; then break; fi
done

if [[ -f "$MOD_BIN/client.dll" ]]; then
  echo "[openvibe] Windows/Proton client.dll present"
else
  echo "[openvibe] Windows/Proton client.dll not present yet; build on Windows to enable Proton in-game client DLL commands"
fi

if [[ -f "$MOD_BIN/server.dll" ]]; then
  echo "[openvibe] Windows server.dll present"
else
  echo "[openvibe] Windows server.dll not present yet"
fi
SETUP
chmod +x tools/setup-openvibe-bin.sh

# -----------------------------------------------------------------------------
# 4) Native Linux launcher.
# -----------------------------------------------------------------------------
cat > tools/run-client-linux.sh <<'LINUXRUN'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
GAME_DIR="$ROOT/game/openvibe.games"
CLIENT_SO="$GAME_DIR/bin/linux64/client.so"

find_hl2_linux() {
  local candidates=(
    "${OPENVIBE_HL2_LINUX:-}"
    "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
    "/mnt/6tb/ssd_offload/home/$USER/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

if [[ ! -f "$CLIENT_SO" && ! -L "$CLIENT_SO" ]]; then
  echo "ERROR: Linux client.so missing at $CLIENT_SO" >&2
  echo "Run: tools/build-sdk-linux.sh && tools/setup-openvibe-bin.sh" >&2
  exit 1
fi

HL2_LINUX="$(find_hl2_linux)" || {
  echo "ERROR: could not find hl2_linux. Set OPENVIBE_HL2_LINUX=/path/to/hl2_linux" >&2
  exit 1
}

CONNECT_ARGS=()
if [[ "${1:-}" != "" && "${2:-}" != "" ]]; then
  CONNECT_ARGS=(+connect "$1:$2")
fi

exec "$HL2_LINUX" \
  -game "$GAME_DIR" \
  -console -dev -novid -sw -w 1280 -h 720 \
  -port 27115 -clientport 27105 \
  +exec openvibe_proton_client.cfg \
  "${CONNECT_ARGS[@]}"
LINUXRUN
chmod +x tools/run-client-linux.sh

# -----------------------------------------------------------------------------
# 5) Auto launcher: native Linux when available, Proton when Windows DLL exists,
#    Proton fallback if explicitly requested.
# -----------------------------------------------------------------------------
cat > tools/run-client-auto.sh <<'AUTORUN'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MODE="${OPENVIBE_CLIENT_MODE:-auto}" # auto | linux | proton | proton-fallback
GAME_DIR="$ROOT/game/openvibe.games"
LINUX_SO="$GAME_DIR/bin/linux64/client.so"
WIN_DLL="$GAME_DIR/bin/client.dll"

has_linux_client() {
  [[ -f "$LINUX_SO" || -L "$LINUX_SO" ]] && \
  { [[ -n "${OPENVIBE_HL2_LINUX:-}" && -x "$OPENVIBE_HL2_LINUX" ]] || \
    [[ -x "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]] || \
    [[ -x "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]] || \
    [[ -x "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]]; }
}

has_windows_client_dll() {
  [[ -f "$WIN_DLL" ]]
}

case "$MODE" in
  linux)
    exec "$ROOT/tools/run-client-linux.sh" "${@:-}"
    ;;
  proton)
    if ! has_windows_client_dll; then
      echo "ERROR: Proton mode requires $WIN_DLL for custom in-game client DLL commands/menu." >&2
      echo "Build Windows DLLs first, or use OPENVIBE_CLIENT_MODE=proton-fallback to launch without client DLL." >&2
      exit 1
    fi
    exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    ;;
  proton-fallback)
    echo "WARNING: Proton fallback may launch, but without game/openvibe.games/bin/client.dll the in-game ov_* client commands/menu will not exist." >&2
    exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    ;;
  auto)
    if has_linux_client; then
      echo "[openvibe] auto client mode: native linux"
      exec "$ROOT/tools/run-client-linux.sh" "${@:-}"
    fi
    if has_windows_client_dll; then
      echo "[openvibe] auto client mode: proton with Windows client.dll"
      exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    fi
    echo "[openvibe] auto client mode: proton fallback, but no Windows client.dll exists yet" >&2
    exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    ;;
  *)
    echo "ERROR: unknown OPENVIBE_CLIENT_MODE=$MODE. Use auto, linux, proton, or proton-fallback." >&2
    exit 1
    ;;
esac
AUTORUN
chmod +x tools/run-client-auto.sh

# -----------------------------------------------------------------------------
# 6) Patch Proton launcher to be honest about DLL status and load fallback cfg.
# -----------------------------------------------------------------------------
if [[ -f tools/run-client-proton.sh ]]; then
  backup_file tools/run-client-proton.sh
  python3 <<'PY'
from pathlib import Path
p = Path('tools/run-client-proton.sh')
s = p.read_text()
if 'CLIENT_DLL="$GAME_DIR/bin/client.dll"' not in s:
    s = s.replace('GAME_DIR="/home/workstation/src/openvibe-source/game/openvibe.games"', 'GAME_DIR="/home/workstation/src/openvibe-source/game/openvibe.games"\nCLIENT_DLL="$GAME_DIR/bin/client.dll"')
if 'Proton Windows hl2.exe will not load Linux client.so' not in s:
    marker = 'echo "Launching OpenVibe: Source..."\n'
    s = s.replace(marker, marker + 'if [ ! -f "$CLIENT_DLL" ]; then\n    echo "WARNING: $CLIENT_DLL is missing."\n    echo "WARNING: Proton Windows hl2.exe will not load Linux client.so; in-game ov_* client commands/menu will be unavailable."\nfi\n')
if '+exec openvibe_proton_client.cfg' not in s:
    s = s.replace('-console -dev -novid -sw -w 1280 -h 720 \\\n', '-console -dev -novid -sw -w 1280 -h 720 \\\n    +exec openvibe_proton_client.cfg \\\n')
p.write_text(s)
PY
fi

# -----------------------------------------------------------------------------
# 7) Windows QuickJS static lib builder.
# -----------------------------------------------------------------------------
cat > tools/build-quickjs-lib-windows.ps1 <<'PSQJS'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

$SrcQjs = Join-Path $Root 'sdk/openvibe/third_party/quickjs'
$SdkQjs = Join-Path $Sdk 'src/game/shared/openvibe/third_party/quickjs'
$Out = Join-Path $SdkQjs 'build'

if (!(Test-Path (Join-Path $SrcQjs 'quickjs.c'))) {
  throw "Missing $SrcQjs/quickjs.c. Run tools/vendor-quickjs.sh first."
}

New-Item -ItemType Directory -Force -Path $SdkQjs, $Out | Out-Null
Get-ChildItem $SrcQjs -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $SdkQjs $_.Name) -Force }

if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw "cl.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}
if (!(Get-Command lib.exe -ErrorAction SilentlyContinue)) {
  throw "lib.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}

$sources = @('quickjs.c','libregexp.c','libunicode.c','cutils.c')
if (Test-Path (Join-Path $SdkQjs 'dtoa.c')) { $sources += 'dtoa.c' }
if (Test-Path (Join-Path $SdkQjs 'libbf.c')) { $sources += 'libbf.c' }

Remove-Item (Join-Path $Out '*.obj') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Out 'libquickjs_openvibe.lib') -Force -ErrorAction SilentlyContinue

$objects = @()
foreach ($src in $sources) {
  $obj = Join-Path $Out ([IO.Path]::GetFileNameWithoutExtension($src) + '.obj')
  Write-Host "[openvibe-qjs-win] cl $src -> $obj"
  & cl.exe /nologo /O2 /MT /W3 /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WINDOWS /DCONFIG_VERSION='"openvibe"' /I"$SdkQjs" /c (Join-Path $SdkQjs $src) /Fo"$obj"
  if ($LASTEXITCODE -ne 0) { throw "cl failed for $src" }
  $objects += $obj
}

$outLib = Join-Path $Out 'libquickjs_openvibe.lib'
& lib.exe /nologo /OUT:"$outLib" $objects
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed" }
Write-Host "[openvibe-qjs-win] built $outLib"
PSQJS

# -----------------------------------------------------------------------------
# 8) Windows native/Proton DLL build helper.
# -----------------------------------------------------------------------------
cat > tools/build-sdk-windows.ps1 <<'PSWIN'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

Write-Host "[openvibe-win] root=$Root"
Write-Host "[openvibe-win] sdk=$Sdk"

if (!(Test-Path (Join-Path $Sdk 'src'))) { throw "Source SDK not found at $Sdk" }

# Apply OpenVibe SDK copy/patches through Git Bash, but skip Linux QuickJS .a build.
$bash = Get-Command bash.exe -ErrorAction SilentlyContinue
if ($bash) {
  $rootForBash = $Root
  try {
    $rootForBash = (& $bash.Source -lc "cygpath -u '$Root'" 2>$null).Trim()
  } catch {}
  Write-Host "[openvibe-win] applying SDK patch through bash at $rootForBash"
  & $bash.Source -lc "cd '$rootForBash' && OPENVIBE_SKIP_QJS_BUILD=1 ./tools/apply-openvibe-sdk.sh"
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed" }
} else {
  Write-Warning "bash.exe not found. Skipping apply-openvibe-sdk.sh. Make sure SDK files are already applied."
}

& (Join-Path $Root 'tools/build-quickjs-lib-windows.ps1')

Push-Location (Join-Path $Sdk 'src')
try {
  $vpc = @(
    (Join-Path $Sdk 'src/devtools/bin/vpc.exe'),
    (Join-Path $Sdk 'devtools/bin/vpc.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (Test-Path '.\createallprojects.bat') {
    Write-Host "[openvibe-win] running createallprojects.bat"
    & cmd.exe /c createallprojects.bat
  } elseif ($vpc) {
    Write-Host "[openvibe-win] running VPC: $vpc"
    $ok = $false
    $attempts = @(
      @('/2013','/hl2mp','/game','/mksln','games.sln'),
      @('/hl2mp','/game','/mksln','games.sln'),
      @('+game','/mksln','games.sln')
    )
    foreach ($args in $attempts) {
      & $vpc @args
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    }
    if (!$ok) { throw "VPC solution generation failed" }
  } else {
    throw "Could not find createallprojects.bat or vpc.exe"
  }

  $sln = Get-ChildItem -Path . -Recurse -Filter *.sln | Where-Object { $_.Name -match 'game|hl2mp|everything|sdk' } | Select-Object -First 1
  if (!$sln) { $sln = Get-ChildItem -Path . -Recurse -Filter *.sln | Select-Object -First 1 }
  if (!$sln) { throw "No Visual Studio solution generated" }

  $msbuild = $null
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (Test-Path $vswhere) {
    $msbuild = (& $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1)
  }
  if (!$msbuild) { $msbuild = (Get-Command msbuild.exe -ErrorAction SilentlyContinue).Source }
  if (!$msbuild) { throw "MSBuild not found. Install Visual Studio Build Tools with C++ workload." }

  Write-Host "[openvibe-win] building $($sln.FullName)"
  $built = $false
  foreach ($platform in @('Win32','x86')) {
    foreach ($config in @('Release','Release_HL2MP','Release HL2MP')) {
      Write-Host "[openvibe-win] trying Configuration=$config Platform=$platform"
      & $msbuild $sln.FullName /m /p:Configuration=$config /p:Platform=$platform
      if ($LASTEXITCODE -eq 0) { $built = $true; break }
    }
    if ($built) { break }
  }
  if (!$built) { throw "MSBuild failed for all known configurations" }
}
finally {
  Pop-Location
}

$modBin = Join-Path $Root 'game/openvibe.games/bin'
New-Item -ItemType Directory -Force -Path $modBin | Out-Null

$client = Get-ChildItem $Sdk -Recurse -Filter client.dll -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'mod_hl2mp|hl2mp|game\\client' } | Sort-Object FullName | Select-Object -First 1
$server = Get-ChildItem $Sdk -Recurse -Filter server.dll -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'mod_hl2mp|hl2mp|game\\server' } | Sort-Object FullName | Select-Object -First 1

if ($client) { Copy-Item $client.FullName (Join-Path $modBin 'client.dll') -Force; Write-Host "[openvibe-win] copied client.dll from $($client.FullName)" } else { Write-Warning "client.dll not found after build" }
if ($server) { Copy-Item $server.FullName (Join-Path $modBin 'server.dll') -Force; Write-Host "[openvibe-win] copied server.dll from $($server.FullName)" } else { Write-Warning "server.dll not found after build" }

Write-Host "[openvibe-win] done. Proton/Windows client uses game/openvibe.games/bin/client.dll"
PSWIN

# -----------------------------------------------------------------------------
# 9) Windows launcher helper.
# -----------------------------------------------------------------------------
cat > tools/run-client-windows.ps1 <<'PSRUN'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$GameDir = Join-Path $Root 'game/openvibe.games'
$ClientDll = Join-Path $GameDir 'bin/client.dll'
$Hl2Exe = if ($env:OPENVIBE_HL2_EXE) { $env:OPENVIBE_HL2_EXE } else { 'C:\Program Files (x86)\Steam\steamapps\common\Source SDK Base 2013 Multiplayer\hl2.exe' }

if (!(Test-Path $Hl2Exe)) { throw "hl2.exe not found. Set OPENVIBE_HL2_EXE." }
if (!(Test-Path $ClientDll)) { throw "client.dll missing at $ClientDll. Run tools/build-sdk-windows.ps1 first." }

$args = @('-game', $GameDir, '-console', '-dev', '-novid', '-sw', '-w', '1280', '-h', '720', '+exec', 'openvibe_proton_client.cfg')
if ($args.Count -ge 2 -and $args[0] -match '^\d+\.\d+\.\d+\.\d+$') {
  # no-op; reserved for direct powershell invocation variants
}

if ($args.Count -ge 2) {}

# Accept optional IP PORT positional args from after -File.
$extra = $MyInvocation.UnboundArguments
if ($extra.Count -ge 2) {
  $args += @('+connect', "$($extra[0]):$($extra[1])")
}

Start-Process -FilePath $Hl2Exe -ArgumentList $args -WorkingDirectory (Split-Path $Hl2Exe)
PSRUN

# -----------------------------------------------------------------------------
# 10) Local wrapper to build what can be built on this machine.
# -----------------------------------------------------------------------------
cat > tools/build-sdk-all-local.sh <<'ALLLOCAL'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

if [[ "${RUN_LINUX_BUILD:-1}" == "1" ]]; then
  echo "[openvibe] building Linux .so modules"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build-linux.log"
  tools/setup-openvibe-bin.sh
else
  echo "[openvibe] RUN_LINUX_BUILD=0, skipping Linux build"
fi

echo
if command -v powershell.exe >/dev/null 2>&1; then
  echo "[openvibe] powershell.exe found. To build Windows DLLs, run from Windows Developer PowerShell:"
else
  echo "[openvibe] Windows DLL build requires Windows + Visual Studio Build Tools. Run:"
fi
cat <<TEXT
  cd <repo>
  powershell -ExecutionPolicy Bypass -File tools/build-sdk-windows.ps1
TEXT

tools/check-openvibe-platform-binaries.sh
ALLLOCAL
chmod +x tools/build-sdk-all-local.sh

# -----------------------------------------------------------------------------
# 11) Patch Electron main.js to call run-client-auto.sh / run-client-windows.ps1
#     rather than hardcoding Proton only.
# -----------------------------------------------------------------------------
if [[ -f launcher/main.js ]]; then
  backup_file launcher/main.js
  python3 <<'PY'
from pathlib import Path
p = Path('launcher/main.js')
s = p.read_text()
start = s.find('async function launchGame(')
if start == -1:
    raise SystemExit('Could not find launchGame in launcher/main.js')
brace = s.find('{', start)
if brace == -1:
    raise SystemExit('Could not find launchGame body')
depth = 0
end = None
for i in range(brace, len(s)):
    if s[i] == '{': depth += 1
    elif s[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
if end is None:
    raise SystemExit('Could not parse launchGame body')
new = r'''async function launchGame(serverIp, serverPort) {
  const root = path.resolve(__dirname, '..');

  const uiReady = await ensureClientUiServer(root);
  if (!uiReady) {
    dialog.showErrorBox('OpenVibe Menu Server Failed',
      `Could not start http://127.0.0.1:${CLIENT_UI_PORT}/client for the launcher/in-game HTML menu.`);
    return false;
  }

  const scriptArgs = serverIp && serverPort ? [serverIp, String(serverPort)] : [];
  const isWin = process.platform === 'win32';
  const launcherScript = isWin
    ? path.join(root, 'tools', 'run-client-windows.ps1')
    : path.join(root, 'tools', 'run-client-auto.sh');

  if (!fs.existsSync(launcherScript)) {
    dialog.showErrorBox('OpenVibe Launcher Script Missing', `Could not find:\n${launcherScript}`);
    return false;
  }

  const command = isWin ? 'powershell.exe' : 'bash';
  const args = isWin
    ? ['-ExecutionPolicy', 'Bypass', '-File', launcherScript, ...scriptArgs]
    : [launcherScript, ...scriptArgs];

  console.log('[launcher] spawning client:', command, args.join(' '));

  gameProcess = spawn(command, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      OPENVIBE_ROOT: root,
      DISPLAY: process.env.DISPLAY || ':0',
    },
  });

  gameProcess.stdout.on('data', (d) => console.log('[game]', d.toString().trim()));
  gameProcess.stderr.on('data', (d) => console.error('[game]', d.toString().trim()));
  gameProcess.on('exit', (code) => {
    console.log('[launcher] game exited with code', code);
    gameProcess = null;
    mainWindow?.webContents.send('game-exited', code);
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow?.webContents.send('game-started', gameProcess.pid);

  // Keep Electron visible by default so users are not dumped behind a frozen Source loading window.
  // Advanced: set OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY=1 to hide after a conservative delay.
  if (process.env.OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY === '1') {
    setTimeout(() => {
      if (gameProcess && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    }, Number(process.env.OPENVIBE_GAME_READY_HIDE_DELAY_MS || 12000));
  }

  gameProcess.unref();
  return true;
}'''
s = s[:start] + new + s[end:]
p.write_text(s)
PY
fi

# -----------------------------------------------------------------------------
# 12) Docs for the repo.
# -----------------------------------------------------------------------------
cat > docs/MULTIPLATFORM_SOURCE_BUILDS.md <<'DOC'
# OpenVibe: Source multi-platform build matrix

OpenVibe needs different client/server binaries for different Source runtimes.

| Runtime | Executable | Module loaded by the engine | Output path |
| --- | --- | --- | --- |
| Linux native client | `hl2_linux` | Linux ELF client module | `game/openvibe.games/bin/linux64/client.so` |
| Linux dedicated server | `srcds_linux` | Linux ELF server module | `game/openvibe.games/bin/linux64/server.so` |
| Windows native client | `hl2.exe` | Windows PE client DLL | `game/openvibe.games/bin/client.dll` |
| Proton client | Windows `hl2.exe` under Proton | Windows PE client DLL | `game/openvibe.games/bin/client.dll` |
| Windows dedicated server | `srcds.exe` | Windows PE server DLL | `game/openvibe.games/bin/server.dll` |

Important: Proton does **not** load Linux `client.so`. It runs Windows `hl2.exe`, so it needs `client.dll`.
If the in-game console says `Unknown command "ov_join"` or `Unknown command "ov_menu"`, the OpenVibe client module is not loaded for that runtime.

## Linux build

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
tools/check-openvibe-platform-binaries.sh
```

## Windows DLL build

Run on Windows in a Visual Studio Developer PowerShell with C++ Build Tools installed:

```powershell
cd C:\path\to\openvibe-source
powershell -ExecutionPolicy Bypass -File tools\build-sdk-windows.ps1
```

That script builds QuickJS as `libquickjs_openvibe.lib`, runs VPC/MSBuild, then copies DLLs into:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

Copy those DLLs back to the Linux dev checkout if you build on a separate Windows VM. Proton will then load them.

## Runtime selection

```bash
# Prefer native Linux if hl2_linux + client.so exist, otherwise use Proton if client.dll exists.
tools/run-client-auto.sh 127.0.0.1 27015

# Force native Linux.
OPENVIBE_CLIENT_MODE=linux tools/run-client-auto.sh 127.0.0.1 27015

# Force Proton; requires client.dll.
OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

# Launch Proton even without client.dll, but in-game client commands/menu will not exist.
OPENVIBE_CLIENT_MODE=proton-fallback tools/run-client-auto.sh 127.0.0.1 27015
```
DOC

# Run setup and diagnostic, but do not force a long compile here.
tools/setup-openvibe-bin.sh || true

echo
echo "[openvibe] generated multi-platform support files"
echo
tools/check-openvibe-platform-binaries.sh || true

echo
echo "Next optional local build:"
echo "  RUN_LINUX_BUILD=1 tools/build-sdk-all-local.sh"
echo
echo "Windows DLL build, from Windows Developer PowerShell:"
echo "  powershell -ExecutionPolicy Bypass -File tools/build-sdk-windows.ps1"
