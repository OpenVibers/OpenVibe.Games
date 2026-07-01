#!/usr/bin/env bash
set -euo pipefail

log(){ printf '[openvibe] %s\n' "$*"; }
warn(){ printf '[openvibe warn] %s\n' "$*" >&2; }

ROOT="${OPENVIBE_ROOT:-$(pwd)}"
cd "$ROOT"
BRANCH="$(git branch --show-current)"
REPO="$(git config --get remote.origin.url | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
: "${REPO:=OpenVibers/OpenVibe.Games}"

log "fix Windows server build: QuickJS C++ header + vscript nut headers + real msbuild failures"
log "root=$ROOT"
log "branch=$BRANCH"
log "repo=$REPO"

python3 - <<'PY'
from pathlib import Path
p = Path('tools/build-sdk-windows.ps1')
text = p.read_text()

# 1) Make Invoke-MSBuildProject stop leaking Tee-Object output into the function return value.
old = '& msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log'
new = '& msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log | Out-Host'
if old in text:
    text = text.replace(old, new)

# 2) Ensure the stronger python shim is actually called and exposes paths for other helpers.
if 'Ensure-PythonOnPath\nEnsure-PythonCommandForMSBuild' not in text and 'Ensure-PythonOnPath\r\nEnsure-PythonCommandForMSBuild' not in text:
    text = text.replace('Ensure-PythonOnPath\n', 'Ensure-PythonOnPath\nEnsure-PythonCommandForMSBuild\n')

# Add script-scoped python vars inside Ensure-PythonCommandForMSBuild if not present.
if '$script:OpenVibePythonExe = $py' not in text:
    text = text.replace('  $pyDir = Split-Path -Parent $py\n', '  $pyDir = Split-Path -Parent $py\n  $script:OpenVibePythonExe = $py\n')
if '$script:OpenVibePythonShim = $bat' not in text:
    text = text.replace('  Set-Content -Encoding ascii -Path $cmdFile -Value $batContent\n', '  Set-Content -Encoding ascii -Path $cmdFile -Value $batContent\n  $script:OpenVibePythonShim = $bat\n')

helper = r'''

# OPENVIBE_FIX_QJS_CPP_AND_NUT_HEADERS
function Patch-QuickJsHeaderForMsvcCpp {
  $header = Join-Path $Sdk "src/game/shared/openvibe/third_party/quickjs/quickjs.h"
  if (!(Test-Path $header)) {
    Say "QuickJS header not present yet, skipping C++ compatibility patch: $header"
    return
  }

  $log = Join-Path $LogDir "quickjs-cpp-header-patch.txt"
  "header=$header" | Out-File $log
  $q = Get-Content -Raw $header
  $orig = $q

  $mkvalOld = '#define JS_MKVAL(tag, val) (JSValue){ (JSValueUnion){ .uint64 = (uint32_t)(val) }, tag }'
  $mkvalNew = @'
#if defined(__cplusplus)
static inline JSValue JS_MKVAL_CPP(int tag, uint32_t val) { JSValue v; v.u.uint64 = (uint32_t)val; v.tag = tag; return v; }
#define JS_MKVAL(tag, val) JS_MKVAL_CPP((tag), (uint32_t)(val))
#else
#define JS_MKVAL(tag, val) (JSValue){ (JSValueUnion){ .uint64 = (uint32_t)(val) }, tag }
#endif
'@
  $q = $q.Replace($mkvalOld, $mkvalNew)

  $mkptrOld = '#define JS_MKPTR(tag, p) (JSValue){ (JSValueUnion){ .ptr = p }, tag }'
  $mkptrNew = @'
#if defined(__cplusplus)
static inline JSValue JS_MKPTR_CPP(int tag, void *p) { JSValue v; v.u.ptr = p; v.tag = tag; return v; }
#define JS_MKPTR(tag, p) JS_MKPTR_CPP((tag), (void *)(p))
#else
#define JS_MKPTR(tag, p) (JSValue){ (JSValueUnion){ .ptr = p }, tag }
#endif
'@
  $q = $q.Replace($mkptrOld, $mkptrNew)

  $nanOld = '#define JS_NAN (JSValue){ .u.float64 = JS_FLOAT64_NAN, JS_TAG_FLOAT64 }'
  $nanNew = @'
#if defined(__cplusplus)
static inline JSValue JS_NAN_CPP(void) { JSValue v; v.u.float64 = JS_FLOAT64_NAN; v.tag = JS_TAG_FLOAT64; return v; }
#define JS_NAN JS_NAN_CPP()
#else
#define JS_NAN (JSValue){ .u.float64 = JS_FLOAT64_NAN, JS_TAG_FLOAT64 }
#endif
'@
  $q = $q.Replace($nanOld, $nanNew)

  $q = $q.Replace('    JSCFunctionType ft = { .generic_magic = func };', '    JSCFunctionType ft; memset(&ft, 0, sizeof(ft)); ft.generic_magic = func;')

  if ($q -ne $orig) {
    Set-Content -Encoding ascii -Path $header -Value $q
    "patched=1" | Out-File $log -Append
    Say "patched QuickJS header for MSVC C++ compound literal/designated initializer compatibility"
  } else {
    "patched=0" | Out-File $log -Append
    Say "QuickJS header C++ patch made no changes"
  }
}

function Ensure-ServerNutHeaders {
  $serverDir = Join-Path $Src "game/server"
  $textToArray = Join-Path $Src "devtools/bin/texttoarray.py"
  $log = Join-Path $LogDir "server-nut-headers.txt"
  "serverDir=$serverDir" | Out-File $log
  "textToArray=$textToArray" | Out-File $log -Append
  "pythonExe=$script:OpenVibePythonExe" | Out-File $log -Append
  "pythonShim=$script:OpenVibePythonShim" | Out-File $log -Append

  if (!(Test-Path $textToArray)) {
    throw "Missing Source SDK texttoarray.py at $textToArray"
  }
  if (-not $script:OpenVibePythonExe -or !(Test-Path $script:OpenVibePythonExe)) {
    throw "Python exe was not captured for nut header generation. Check python-version.txt."
  }

  foreach ($name in @("spawn_helper", "vscript_server")) {
    $input = Join-Path $serverDir "$name.nut"
    $out = Join-Path $serverDir "${name}_nut.h"
    if (!(Test-Path $input)) {
      "missing input $input" | Out-File $log -Append
      continue
    }
    Say "generating $out from $input"
    & $script:OpenVibePythonExe $textToArray $input "g_Script_$name" | Set-Content -Encoding ascii -Path $out
    if ($LASTEXITCODE -ne 0) { throw "texttoarray.py failed for $input" }
    if (!(Test-Path $out)) { throw "Expected generated nut header was not created: $out" }
    "generated $out" | Out-File $log -Append
  }
}
'''

if 'function Patch-QuickJsHeaderForMsvcCpp' not in text:
    marker = 'function Find-VcVars64 {'
    text = text.replace(marker, helper + '\n' + marker)

# Call QuickJS C++ header patch right after QuickJS lib build and before Set-Location.
if 'Patch-QuickJsHeaderForMsvcCpp\n\nSet-Location $Src' not in text:
    text = text.replace('\nSet-Location $Src\n', '\nPatch-QuickJsHeaderForMsvcCpp\n\nSet-Location $Src\n')

# Generate vscript headers after project generation/patches and before dependency/client/server builds.
if 'Ensure-ServerNutHeaders\nBuild-SourceSdkDependencyProjects' not in text:
    text = text.replace('Build-SourceSdkDependencyProjects\n', 'Ensure-ServerNutHeaders\nBuild-SourceSdkDependencyProjects\n')

p.write_text(text)
PY

cat > docs/WINDOWS_SERVER_QJS_CPP_NUT_HEADERS.md <<'EOF'
# Windows server build: QuickJS C++ and vscript nut headers

The Windows HL2MP server build needs two extra fixes on hosted Actions runners:

- The Source SDK custom build step for `vscript_server.nut` can report success without producing `vscript_server_nut.h`, so the build script pre-generates `spawn_helper_nut.h` and `vscript_server_nut.h` with `devtools/bin/texttoarray.py`.
- QuickJS is compiled as C with `clang-cl`, but its header is also included from C++ server files. The script patches the SDK copy of `quickjs.h` so MSVC C++ can compile QuickJS value macros without C compound literals/designated initializers.

The patch is applied only to the generated SDK copy under `engine/source-sdk-2013`, not to the vendored source files.
EOF

log "git diff summary"
git diff --stat

git add tools/build-sdk-windows.ps1 docs/WINDOWS_SERVER_QJS_CPP_NUT_HEADERS.md
if git diff --cached --quiet; then
  log "nothing new to commit"
else
  git commit -m "Fix Windows server QuickJS C++ and nut headers"
fi

log "pushing $BRANCH"
git push origin "$BRANCH"

if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  log "triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh || true
elif [[ -x tools/gh-windows-build-and-install.sh ]]; then
  log "triggering Windows DLL build/install helper"
  tools/gh-windows-build-and-install.sh || true
else
  log "triggering workflow directly"
  gh workflow run windows-source-sdk-dlls.yml --repo "$REPO" --ref "$BRANCH"
  sleep 5
  run_id="$(gh run list --repo "$REPO" --workflow windows-source-sdk-dlls.yml --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
  log "watching run $run_id"
  gh run watch "$run_id" --repo "$REPO" --exit-status || true
  if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
    tools/windows-workflow-debug-and-install.sh "$run_id" || true
  fi
fi

log "done"
