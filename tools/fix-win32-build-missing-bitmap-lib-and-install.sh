#!/usr/bin/env bash
set -euo pipefail

say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
fail() { echo "[openvibe error] $*" >&2; exit 1; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BUILD_PS1="tools/build-sdk-windows.ps1"

say "fix Win32 build: build/copy bitmap.lib before client link"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v gh >/dev/null 2>&1 || fail "GitHub CLI gh is required"
[[ -f "$BUILD_PS1" ]] || fail "missing $BUILD_PS1"

python3 - <<'PY'
from pathlib import Path
p = Path('tools/build-sdk-windows.ps1')
s = p.read_text()
orig = s

# Add bitmap project to the dependency build list. Client links ..\..\lib\public\bitmap.lib.
if '"bitmap*.vcxproj"' not in s:
    anchor = '    "mathlib*.vcxproj",\n'
    if anchor not in s:
        raise SystemExit('could not find dependency patterns anchor near mathlib*.vcxproj')
    s = s.replace(anchor, anchor + '    "bitmap*.vcxproj",\n', 1)

# Ensure bitmap.lib is copied into the public lib dir after dependency builds.
if 'Copy-LibIfNeeded "bitmap.lib"' not in s:
    anchor = '  Copy-LibIfNeeded "mathlib.lib" $publicLibDir\n'
    if anchor not in s:
        raise SystemExit('could not find Copy-LibIfNeeded anchor near mathlib.lib')
    s = s.replace(anchor, anchor + '  Copy-LibIfNeeded "bitmap.lib" $publicLibDir\n', 1)

# Improve fallback search ordering for libs: prefer target arch output dirs over stale x64.
old = '''  $found = Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
'''
new = '''  $found = Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps" } |
    Sort-Object @{ Expression = {
      if ($script:OpenVibeTargetArch -eq "x86") {
        if ($_.FullName -match "\\x64\\|/x64/|win64|x64") { 1 } else { 0 }
      } else {
        if ($_.FullName -match "\\x64\\|/x64/|win64|x64") { 0 } else { 1 }
      }
    } }, LastWriteTime -Descending |
    Select-Object -First 1
'''
if old in s and new not in s:
    s = s.replace(old, new, 1)

# Add an explicit diagnostic line so we can tell this patch ran.
marker = '# OPENVIBE_WIN32_BITMAP_LIB_DEP_PATCH'
if marker not in s:
    s = s.replace('function Build-SourceSdkDependencyProjects {\n', f'{marker}\nfunction Build-SourceSdkDependencyProjects {{\n', 1)

if s != orig:
    p.write_text(s)
    print('[patched] tools/build-sdk-windows.ps1')
else:
    print('[openvibe] tools/build-sdk-windows.ps1 already patched')
PY

mkdir -p docs
cat > docs/WINDOWS_WIN32_BITMAP_LIB_FIX.md <<'DOC'
# Windows Win32 bitmap.lib fix

The Win32/Proton DLL build converts VPC's generated win64 projects to Win32 before MSBuild.
After conversion, the HL2MP client links against `..\..\lib\public\bitmap.lib`.

This patch adds the generated bitmap project to the dependency build list and copies
`bitmap.lib` into the target public library directory before building `client.dll`.
DOC

say "git diff summary"
git diff --stat

git add tools/build-sdk-windows.ps1 docs/WINDOWS_WIN32_BITMAP_LIB_FIX.md tools/fix-win32-build-missing-bitmap-lib-and-install.sh 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "Build bitmap lib for Win32 Proton DLLs"
  git push origin "$BRANCH"
else
  say "no commit needed"
fi

HEAD="$(git rev-parse HEAD)"
say "head=$HEAD"
say "triggering Win32 workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1 || true

RUN_ID=""
for _ in $(seq 1 60); do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --commit "$HEAD" --limit 10 --json databaseId,createdAt,status --jq 'sort_by(.createdAt) | last | .databaseId' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    break
  fi
  sleep 5
done
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "could not find workflow run for commit $HEAD"

say "watching run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  warn "workflow failed; downloading diagnostics"
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  fail "Win32 DLL workflow failed"
fi

say "workflow passed; installing PE32 OpenVibe DLLs"
OPENVIBE_EXPECT_DLL_ARCH=x86 tools/install-latest-openvibe-windows-dlls.sh "$RUN_ID"

say "done. Now fully close hl2.exe/Proton, relaunch, and test:"
echo 'OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015'
echo 'ov_help'
echo 'ov_join hub'
echo 'ov_menu'
