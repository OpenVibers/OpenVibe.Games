$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

$SrcQjs = Join-Path $Root 'sdk/openvibe/third_party/quickjs'
$SdkQjs = Join-Path $Sdk 'src/game/shared/openvibe/third_party/quickjs'
$Out = Join-Path $SdkQjs 'build'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'

function Say($m) { Write-Host "[openvibe-qjs-win] $m" }
function FirstExistingCommand([string[]]$names) {
  foreach ($name in $names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}
function FirstExistingPath([string[]]$paths) {
  foreach ($p in $paths) {
    if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path }
  }
  return $null
}

if (!(Test-Path (Join-Path $SrcQjs 'quickjs.c'))) {
  throw "Missing $SrcQjs/quickjs.c. Run tools/vendor-quickjs.sh first."
}
if (!(Get-Command lib.exe -ErrorAction SilentlyContinue)) {
  throw "lib.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}

New-Item -ItemType Directory -Force -Path $SdkQjs, $Out, $LogDir | Out-Null
Copy-Item -Path (Join-Path $SrcQjs '*') -Destination $SdkQjs -Recurse -Force

$CompatInclude = Join-Path $Out 'compat/include'
$CompatSys = Join-Path $CompatInclude 'sys'
New-Item -ItemType Directory -Force -Path $CompatInclude, $CompatSys | Out-Null

# QuickJS is written for GCC/clang C, not plain MSVC C. Prefer clang-cl because it
# emits MSVC-compatible COFF .obj files while accepting GNU/C99 constructs that
# QuickJS uses heavily. Keep cl.exe only as a last-resort fallback.
$clangCandidates = @(
  (FirstExistingCommand @('clang-cl.exe','clang-cl')),
  (Join-Path ${env:ProgramFiles} 'LLVM/bin/clang-cl.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/Enterprise/VC/Tools/Llvm/x86/bin/clang-cl.exe'),
  (Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio/2022/Enterprise/VC/Tools/Llvm/x86/bin/clang-cl.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/BuildTools/VC/Tools/Llvm/x86/bin/clang-cl.exe'),
  (Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio/2022/BuildTools/VC/Tools/Llvm/x86/bin/clang-cl.exe')
)
$ClangCl = FirstExistingPath $clangCandidates
$ClExe = FirstExistingCommand @('cl.exe')
if ($ClangCl) { Say "using clang-cl=$ClangCl" }
elseif ($ClExe) { Say "clang-cl not found; falling back to cl.exe=$ClExe" }
else { throw "Neither clang-cl.exe nor cl.exe was found." }

# Windows sys/time.h shim for upstream QuickJS.
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
#endif
'@ | Set-Content -Encoding ascii $TimeHeader

# pthread.h shim. We also disable CONFIG_ATOMICS below, so this is only to satisfy
# accidental includes from vendored QuickJS variants.
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
#endif
'@ | Set-Content -Encoding ascii $PThreadHeader

# Forced include for clang-cl. Do NOT redefine __attribute__ or __builtin_* here;
# clang handles those and QuickJS needs them.
$ClangCompat = Join-Path $CompatInclude 'openvibe_qjs_clangcl_compat.h'
@'
#ifndef OPENVIBE_QJS_CLANGCL_COMPAT_H
#define OPENVIBE_QJS_CLANGCL_COMPAT_H
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <stdint.h>
#include <stdlib.h>
#include <malloc.h>
#ifndef alloca
#define alloca _alloca
#endif
#ifndef strdup
#define strdup _strdup
#endif
#endif
#endif
'@ | Set-Content -Encoding ascii $ClangCompat

# Forced include for emergency cl.exe fallback only.
$MsvcCompat = Join-Path $CompatInclude 'openvibe_qjs_msvc_compat.h'
@'
#ifndef OPENVIBE_QJS_MSVC_COMPAT_H
#define OPENVIBE_QJS_MSVC_COMPAT_H
#if defined(_MSC_VER) && !defined(__clang__)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <stdint.h>
#include <stdlib.h>
#include <malloc.h>
#include <intrin.h>
#ifndef __attribute__
#define __attribute__(x)
#endif
#ifndef __builtin_expect
#define __builtin_expect(x, y) (x)
#endif
#ifndef __builtin_frame_address
#define __builtin_frame_address(x) ((void*)0)
#endif
static __inline int openvibe_qjs_clz32(unsigned int v) { unsigned long idx; if (_BitScanReverse(&idx, v)) return 31 - (int)idx; return 32; }
static __inline int openvibe_qjs_ctz32(unsigned int v) { unsigned long idx; if (_BitScanForward(&idx, v)) return (int)idx; return 32; }
static __inline int openvibe_qjs_clz64(uint64_t v) { uint32_t hi = (uint32_t)(v >> 32); uint32_t lo = (uint32_t)v; if (hi) return openvibe_qjs_clz32(hi); return 32 + openvibe_qjs_clz32(lo); }
static __inline int openvibe_qjs_ctz64(uint64_t v) { uint32_t hi = (uint32_t)(v >> 32); uint32_t lo = (uint32_t)v; if (lo) return openvibe_qjs_ctz32(lo); return 32 + openvibe_qjs_ctz32(hi); }
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
#endif
#endif
'@ | Set-Content -Encoding ascii $MsvcCompat

# Disable QuickJS atomics/workers for the embedded game runtime.
$QuickJsC = Join-Path $SdkQjs 'quickjs.c'
if (Test-Path $QuickJsC) {
  $q = Get-Content -Raw $QuickJsC
  $q2 = [regex]::Replace($q, '(?m)^\s*#\s*define\s+CONFIG_ATOMICS\s*$', '/* OpenVibe Windows embedded build: CONFIG_ATOMICS disabled */')
  if ($q2 -ne $q) {
    Set-Content -Encoding ascii $QuickJsC $q2
    Say 'disabled CONFIG_ATOMICS in SDK quickjs.c copy'
  } else {
    Say 'CONFIG_ATOMICS define not found in quickjs.c copy; pthread shim remains available'
  }
}

Say "compat include=$CompatInclude"
Say "compat sys/time.h=$TimeHeader"
Say "compat pthread.h=$PThreadHeader"
Say "clang forced include=$ClangCompat"
Say "msvc forced include=$MsvcCompat"

$sources = @('quickjs.c','libregexp.c','libunicode.c','cutils.c')
if (Test-Path (Join-Path $SdkQjs 'dtoa.c')) { $sources += 'dtoa.c' }
if (Test-Path (Join-Path $SdkQjs 'libbf.c')) { $sources += 'libbf.c' }

Remove-Item (Join-Path $Out '*.obj') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Out 'libquickjs_openvibe.lib') -Force -ErrorAction SilentlyContinue

if ($ClangCl) {
  $Compiler = $ClangCl
  $Common = @(
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
    "/FI$ClangCompat",
    "/I$CompatInclude",
    "/I$SdkQjs",
    '/clang:-std=gnu11',
    '/clang:-Wno-everything'
  )
} else {
  $Compiler = $ClExe
  $Common = @(
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
}

$objects = @()
foreach ($src in $sources) {
  $srcPath = Join-Path $SdkQjs $src
  $obj = Join-Path $Out ([IO.Path]::GetFileNameWithoutExtension($src) + '.obj')
  Say "$([IO.Path]::GetFileName($Compiler)) $src -> $obj"
  & $Compiler @Common /c "$srcPath" "/Fo$obj"
  if ($LASTEXITCODE -ne 0) { throw "$Compiler failed for $src" }
  if (!(Test-Path $obj)) { throw "$Compiler reported success but did not produce $obj" }
  $objects += $obj
}

$outLib = Join-Path $Out 'libquickjs_openvibe.lib'
Say "lib -> $outLib"
& lib.exe /nologo "/OUT:$outLib" $objects
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed" }
if (!(Test-Path $outLib)) { throw "lib.exe did not produce $outLib" }
Say "built $outLib"
