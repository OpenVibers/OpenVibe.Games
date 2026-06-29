#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
cd "$ROOT"

echo "[openvibe] fix QuickJS MSVC sys/time.h shim + rerun Windows DLL workflow"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=${BRANCH:-unknown}"

mkdir -p tools docs

cat > tools/build-quickjs-lib-windows.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

$SrcQjs = Join-Path $Root 'sdk/openvibe/third_party/quickjs'
$SdkQjs = Join-Path $Sdk 'src/game/shared/openvibe/third_party/quickjs'
$Out = Join-Path $SdkQjs 'build'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'

function Say($m) { Write-Host "[openvibe-qjs-win] $m" }

if (!(Test-Path (Join-Path $SrcQjs 'quickjs.c'))) {
  throw "Missing $SrcQjs/quickjs.c. Run tools/vendor-quickjs.sh first."
}
if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw "cl.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}
if (!(Get-Command lib.exe -ErrorAction SilentlyContinue)) {
  throw "lib.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}

New-Item -ItemType Directory -Force -Path $SdkQjs, $Out, $LogDir | Out-Null
Copy-Item -Path (Join-Path $SrcQjs '*') -Destination $SdkQjs -Recurse -Force

# Upstream QuickJS includes <sys/time.h>. MSVC does not ship that POSIX header.
# Provide a tiny compatibility header that exposes timeval + gettimeofday for quickjs.c.
$CompatInclude = Join-Path $Out 'compat/include'
$CompatSys = Join-Path $CompatInclude 'sys'
New-Item -ItemType Directory -Force -Path $CompatSys | Out-Null
$TimeHeader = Join-Path $CompatSys 'time.h'
@'
#ifndef OPENVIBE_QUICKJS_COMPAT_SYS_TIME_H
#define OPENVIBE_QUICKJS_COMPAT_SYS_TIME_H

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef _TIMEVAL_DEFINED
#define _TIMEVAL_DEFINED
typedef long suseconds_t;
struct timeval {
    long tv_sec;
    long tv_usec;
};
#endif

static __inline int gettimeofday(struct timeval *tv, void *tz)
{
    FILETIME ft;
    ULARGE_INTEGER uli;
    unsigned long long usec;
    const unsigned long long unix_epoch = 116444736000000000ULL;
    (void)tz;
    if (!tv) return -1;
    GetSystemTimeAsFileTime(&ft);
    uli.LowPart = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    usec = (uli.QuadPart - unix_epoch) / 10ULL;
    tv->tv_sec = (long)(usec / 1000000ULL);
    tv->tv_usec = (long)(usec % 1000000ULL);
    return 0;
}

#ifdef __cplusplus
}
#endif
#else
#include_next <sys/time.h>
#endif

#endif /* OPENVIBE_QUICKJS_COMPAT_SYS_TIME_H */
'@ | Set-Content -Encoding ascii $TimeHeader

Say "compat include=$CompatInclude"
Say "compat header=$TimeHeader"

$sources = @('quickjs.c','libregexp.c','libunicode.c','cutils.c')
if (Test-Path (Join-Path $SdkQjs 'dtoa.c')) { $sources += 'dtoa.c' }
if (Test-Path (Join-Path $SdkQjs 'libbf.c')) { $sources += 'libbf.c' }

Remove-Item (Join-Path $Out '*.obj') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Out 'libquickjs_openvibe.lib') -Force -ErrorAction SilentlyContinue

$common = @(
  '/nologo',
  '/TC',
  '/O2',
  '/MT',
  '/W3',
  '/D_CRT_SECURE_NO_WARNINGS',
  '/DWIN32',
  '/D_WINDOWS',
  '/DNOMINMAX',
  '/DWIN32_LEAN_AND_MEAN',
  "/DCONFIG_VERSION=`\`"openvibe`\`"",
  "/I$CompatInclude",
  "/I$SdkQjs"
)

$objects = @()
foreach ($src in $sources) {
  $srcPath = Join-Path $SdkQjs $src
  $obj = Join-Path $Out ([IO.Path]::GetFileNameWithoutExtension($src) + '.obj')
  Say "cl $src -> $obj"
  & cl.exe @common /c "$srcPath" "/Fo$obj"
  if ($LASTEXITCODE -ne 0) { throw "cl failed for $src" }
  if (!(Test-Path $obj)) { throw "cl reported success but did not produce $obj" }
  $objects += $obj
}

$outLib = Join-Path $Out 'libquickjs_openvibe.lib'
Say "lib -> $outLib"
& lib.exe /nologo "/OUT:$outLib" $objects
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed" }
if (!(Test-Path $outLib)) { throw "lib.exe did not produce $outLib" }

Say "built $outLib"
PS1

cat > docs/WINDOWS_QUICKJS_MSVC.md <<'MD'
# Windows QuickJS MSVC Build Note

The vendored QuickJS C source includes POSIX `<sys/time.h>`, which MSVC does not provide. The Windows QuickJS build helper now generates a tiny compatibility include directory at build time:

```text
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/compat/include/sys/time.h
```

That shim defines `struct timeval` and `gettimeofday()` using `GetSystemTimeAsFileTime()`, then passes the compatibility include directory to `cl.exe` before compiling QuickJS.

This keeps Linux builds unchanged while allowing the Windows GitHub Actions runner to produce `libquickjs_openvibe.lib` for `client.dll` / `server.dll` builds.
MD

# Keep local generated diagnostics out of future commits.
if [[ -f .gitignore ]]; then
  grep -qxF 'artifacts/' .gitignore || echo 'artifacts/' >> .gitignore
  grep -qxF '_deps/' .gitignore || echo '_deps/' >> .gitignore
  grep -qxF 'engine/source-sdk-2013/' .gitignore || echo 'engine/source-sdk-2013/' >> .gitignore
else
  cat > .gitignore <<'GI'
artifacts/
_deps/
engine/source-sdk-2013/
GI
fi

# Avoid staging downloaded workflow diagnostics again.
git rm -r --cached artifacts >/dev/null 2>&1 || true

git add .gitignore docs/WINDOWS_QUICKJS_MSVC.md tools/build-quickjs-lib-windows.ps1 "$0" 2>/dev/null || \
  git add .gitignore docs/WINDOWS_QUICKJS_MSVC.md tools/build-quickjs-lib-windows.ps1

echo "[openvibe] git diff summary"
git diff --cached --stat || true

if ! git diff --cached --quiet; then
  git commit -m "Fix QuickJS MSVC compatibility build"
  git push
else
  echo "[openvibe] no changes to commit"
fi

if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  echo "[openvibe] triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh
else
  REPO="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
  echo "[openvibe] triggering workflow repo=$REPO"
  gh workflow run windows-source-sdk-dlls.yml --repo "$REPO" --ref "${BRANCH:-codex/openvibe-next-steps}"
  sleep 5
  gh run list --repo "$REPO" --workflow windows-source-sdk-dlls.yml --limit 3
fi

echo "[openvibe] done"
