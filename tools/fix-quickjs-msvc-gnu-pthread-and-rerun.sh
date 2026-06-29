#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="$(git branch --show-current 2>/dev/null || echo codex/openvibe-next-steps)"

say(){ echo "[openvibe] $*"; }

say "fix QuickJS MSVC GNU builtins/attribute/pthread compat + rerun Windows DLL workflow"
say "root=$ROOT"
say "branch=$BRANCH"

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

$CompatInclude = Join-Path $Out 'compat/include'
$CompatSys = Join-Path $CompatInclude 'sys'
New-Item -ItemType Directory -Force -Path $CompatInclude, $CompatSys | Out-Null

# Upstream QuickJS is mostly GCC/clang oriented. MSVC needs a forced include for:
#   - GCC __attribute__((...)) syntax used in cutils.h
#   - GCC __builtin_* helpers used in cutils.h
#   - a few libc aliases
$MsvcCompat = Join-Path $CompatInclude 'openvibe_qjs_msvc_compat.h'
@'
#ifndef OPENVIBE_QJS_MSVC_COMPAT_H
#define OPENVIBE_QJS_MSVC_COMPAT_H

#if defined(_MSC_VER)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <stdint.h>
#include <stdlib.h>
#include <intrin.h>

#ifndef __attribute__
#define __attribute__(x)
#endif
#ifndef __builtin_expect
#define __builtin_expect(x, y) (x)
#endif

static __inline int openvibe_qjs_clz32(unsigned int v)
{
    unsigned long idx;
    if (_BitScanReverse(&idx, v)) return 31 - (int)idx;
    return 32;
}

static __inline int openvibe_qjs_ctz32(unsigned int v)
{
    unsigned long idx;
    if (_BitScanForward(&idx, v)) return (int)idx;
    return 32;
}

static __inline int openvibe_qjs_clz64(uint64_t v)
{
    uint32_t hi = (uint32_t)(v >> 32);
    uint32_t lo = (uint32_t)v;
    if (hi) return openvibe_qjs_clz32(hi);
    return 32 + openvibe_qjs_clz32(lo);
}

static __inline int openvibe_qjs_ctz64(uint64_t v)
{
    uint32_t hi = (uint32_t)(v >> 32);
    uint32_t lo = (uint32_t)v;
    if (lo) return openvibe_qjs_ctz32(lo);
    return 32 + openvibe_qjs_ctz32(hi);
}

#ifndef __builtin_clz
#define __builtin_clz(x) openvibe_qjs_clz32((unsigned int)(x))
#endif
#ifndef __builtin_ctz
#define __builtin_ctz(x) openvibe_qjs_ctz32((unsigned int)(x))
#endif
#ifndef __builtin_clzll
#define __builtin_clzll(x) openvibe_qjs_clz64((uint64_t)(x))
#endif
#ifndef __builtin_ctzll
#define __builtin_ctzll(x) openvibe_qjs_ctz64((uint64_t)(x))
#endif

#ifndef alloca
#define alloca _alloca
#endif
#ifndef strdup
#define strdup _strdup
#endif

#endif /* _MSC_VER */
#endif /* OPENVIBE_QJS_MSVC_COMPAT_H */
'@ | Set-Content -Encoding ascii $MsvcCompat

# Upstream QuickJS includes <sys/time.h>. MSVC does not provide it.
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

# Stub enough pthread API for accidental includes. CONFIG_ATOMICS is disabled below,
# so this should not be exercised, but the header keeps MSVC moving if upstream includes it.
$PThreadHeader = Join-Path $CompatInclude 'pthread.h'
@'
#ifndef OPENVIBE_QUICKJS_COMPAT_PTHREAD_H
#define OPENVIBE_QUICKJS_COMPAT_PTHREAD_H
#if defined(_WIN32)
typedef int pthread_mutex_t;
typedef int pthread_t;
typedef int pthread_attr_t;
#define PTHREAD_MUTEX_INITIALIZER 0
static __inline int pthread_mutex_init(pthread_mutex_t *m, const void *a) { (void)a; if (m) *m = 0; return 0; }
static __inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
static __inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static __inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static __inline int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*fn)(void *), void *arg) { (void)t; (void)a; (void)fn; (void)arg; return -1; }
static __inline int pthread_join(pthread_t t, void **ret) { (void)t; if (ret) *ret = 0; return 0; }
#else
#include_next <pthread.h>
#endif
#endif /* OPENVIBE_QUICKJS_COMPAT_PTHREAD_H */
'@ | Set-Content -Encoding ascii $PThreadHeader

# Disable QuickJS atomics/workers for this embedded game runtime on MSVC.
# That avoids needing a real pthread implementation and is fine for our scripts.
$QuickJsC = Join-Path $SdkQjs 'quickjs.c'
if (Test-Path $QuickJsC) {
  $q = Get-Content -Raw $QuickJsC
  $q2 = [regex]::Replace($q, '(?m)^\s*#\s*define\s+CONFIG_ATOMICS\s*$', '/* OpenVibe MSVC build: CONFIG_ATOMICS disabled */')
  if ($q2 -ne $q) {
    Set-Content -Encoding ascii $QuickJsC $q2
    Say 'disabled CONFIG_ATOMICS in SDK quickjs.c copy'
  } else {
    Say 'CONFIG_ATOMICS define not found in quickjs.c copy; pthread shim remains available'
  }
}

Say "compat include=$CompatInclude"
Say "compat forced include=$MsvcCompat"
Say "compat sys/time.h=$TimeHeader"
Say "compat pthread.h=$PThreadHeader"

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
  '/D_CRT_NONSTDC_NO_WARNINGS',
  '/DWIN32',
  '/D_WINDOWS',
  '/DNOMINMAX',
  '/DWIN32_LEAN_AND_MEAN',
  "/DCONFIG_VERSION=`\`"openvibe`\`"",
  "/FI$MsvcCompat",
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

The vendored QuickJS source is GCC/clang oriented. On Windows/MSVC it needs compatibility for:

- POSIX `sys/time.h`
- accidental `pthread.h` includes
- GNU `__attribute__((...))`
- GNU `__builtin_clz`, `__builtin_ctz`, and `__builtin_expect`

`tools/build-quickjs-lib-windows.ps1` now generates build-local compatibility headers under:

```text
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/compat/include
```

It also force-includes `openvibe_qjs_msvc_compat.h` for every QuickJS source file and disables `CONFIG_ATOMICS` in the copied SDK-side `quickjs.c` before compiling. Linux builds are unchanged.
MD

# Keep generated diagnostics/build deps out of git.
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

git rm -r --cached artifacts >/dev/null 2>&1 || true

git add .gitignore docs/WINDOWS_QUICKJS_MSVC.md tools/build-quickjs-lib-windows.ps1 "$0" 2>/dev/null || \
  git add .gitignore docs/WINDOWS_QUICKJS_MSVC.md tools/build-quickjs-lib-windows.ps1

say "git diff summary"
git diff --cached --stat || true

if ! git diff --cached --quiet; then
  git commit -m "Fix QuickJS MSVC GNU compatibility"
  git push
else
  say "no changes to commit"
fi

if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  say "triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh
else
  REPO="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
  say "triggering workflow repo=$REPO"
  gh workflow run windows-source-sdk-dlls.yml --repo "$REPO" --ref "$BRANCH"
  sleep 5
  gh run list --repo "$REPO" --workflow windows-source-sdk-dlls.yml --limit 3
fi

say "done"
