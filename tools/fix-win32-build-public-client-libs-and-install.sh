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
BUILD="tools/build-sdk-windows.ps1"

say "fix Win32 build: build/copy public client static libs before client link"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

[[ -f "$BUILD" ]] || fail "missing $BUILD"
command -v gh >/dev/null 2>&1 || fail "gh missing"
command -v python3 >/dev/null 2>&1 || fail "python3 missing"

python3 - <<'PY'
from pathlib import Path
p = Path("tools/build-sdk-windows.ps1")
s = p.read_text()

# 1) Expand dependency project patterns so VPC-converted Win32 builds produce
# the static libs the HL2MP client links from ..\..\lib\public.
old_patterns = '''  $patterns = @(
    "tier1*.vcxproj",
    "mathlib*.vcxproj",
    "raytrace*.vcxproj",
    "vgui_controls*.vcxproj",
    "matsys_controls*.vcxproj",
    "fgdlib*.vcxproj",
    "bitmap*.vcxproj"
  )'''
new_patterns = '''  # OPENVIBE_WIN32_PUBLIC_CLIENT_LIB_DEPS
  # HL2MP client links a bunch of static libs from ..\\\\..\\\\lib\\\\public.
  # VPC is still naming projects *_win64, but we convert their project
  # platforms to Win32 before MSBuild, so include the public static-lib
  # projects here and let Invoke-MSBuildProject select Release|Win32.
  $patterns = @(
    "tier1*.vcxproj",
    "tier2*.vcxproj",
    "mathlib*.vcxproj",
    "raytrace*.vcxproj",
    "bitmap*.vcxproj",
    "choreoobjects*.vcxproj",
    "dmxloader*.vcxproj",
    "dmserializers*.vcxproj",
    "datamodel*.vcxproj",
    "particles*.vcxproj",
    "appframework*.vcxproj",
    "vgui_controls*.vcxproj",
    "vgui_surfacelib*.vcxproj",
    "matsys_controls*.vcxproj",
    "fgdlib*.vcxproj"
  )'''
if old_patterns in s:
    s = s.replace(old_patterns, new_patterns)
elif "OPENVIBE_WIN32_PUBLIC_CLIENT_LIB_DEPS" not in s:
    # Fallback: insert the extra patterns after the current known pattern lines.
    for needle in ['    "bitmap*.vcxproj"', '    "fgdlib*.vcxproj"']:
        if needle in s:
            s = s.replace(needle, needle + ',\n    "choreoobjects*.vcxproj",\n    "tier2*.vcxproj",\n    "dmxloader*.vcxproj",\n    "dmserializers*.vcxproj",\n    "datamodel*.vcxproj",\n    "particles*.vcxproj",\n    "appframework*.vcxproj",\n    "vgui_surfacelib*.vcxproj"', 1)
            s = s.replace("$patterns = @(", "# OPENVIBE_WIN32_PUBLIC_CLIENT_LIB_DEPS\n  $patterns = @(", 1)
            break

# 2) Make Copy-LibIfNeeded prefer the correct arch, so Win32 does not silently
# copy a stale x64 lib into lib/public.
old_filter = '''  $found = Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1'''
new_filter = '''  $foundCandidates = @(Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps" })
  if ($script:OpenVibeTargetArch -eq "x86") {
    $foundCandidates = @($foundCandidates | Where-Object { $_.FullName -notmatch "\\\\x64\\\\|_x64|win64|Release_mod_hl2mp_x64|Debug_mod_hl2mp_x64" })
  } else {
    $foundCandidates = @($foundCandidates | Where-Object { $_.FullName -match "\\\\x64\\\\|_x64|win64|Release_mod_hl2mp_x64|Debug_mod_hl2mp_x64" })
  }
  $found = $foundCandidates |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1'''
if old_filter in s:
    s = s.replace(old_filter, new_filter)

# 3) Copy all common client public static libs after dependency builds.
old_copies = '''  Copy-LibIfNeeded "mathlib.lib" $publicLibDir
  Copy-LibIfNeeded "tier1.lib" $publicLibDir
  Copy-LibIfNeeded "raytrace.lib" $publicLibDir
  Copy-LibIfNeeded "vgui_controls.lib" $publicLibDir
  Copy-LibIfNeeded "matsys_controls.lib" $publicLibDir
  Copy-LibIfNeeded "bitmap.lib" $publicLibDir'''
new_copies = '''  # OPENVIBE_WIN32_COPY_PUBLIC_CLIENT_LIBS
  foreach ($lib in @(
    "tier1.lib",
    "tier2.lib",
    "mathlib.lib",
    "raytrace.lib",
    "bitmap.lib",
    "choreoobjects.lib",
    "dmxloader.lib",
    "dmserializers.lib",
    "datamodel.lib",
    "particles.lib",
    "appframework.lib",
    "vgui_controls.lib",
    "vgui_surfacelib.lib",
    "matsys_controls.lib"
  )) {
    Copy-LibIfNeeded $lib $publicLibDir
  }'''
if old_copies in s:
    s = s.replace(old_copies, new_copies)
elif "OPENVIBE_WIN32_COPY_PUBLIC_CLIENT_LIBS" not in s:
    needle = '  Copy-LibIfNeeded "bitmap.lib" $publicLibDir'
    if needle in s:
        s = s.replace(needle, new_copies, 1)

# 4) Add a log to prove whether the libs exist before client link.
marker = 'Build-SourceSdkDependencyProjects\n\n$beforeBuild = Get-Date'
insert = '''Build-SourceSdkDependencyProjects

# OPENVIBE_WIN32_PRE_CLIENT_LINK_LIB_AUDIT
$publicLibDirAudit = if ($script:OpenVibeTargetArch -eq "x86") { Join-Path $Src "lib/public" } else { Join-Path $Src "lib/public/x64" }
"=== public lib dir before client link ===" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt")
"target arch=$script:OpenVibeTargetArch" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
"dir=$publicLibDirAudit" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
foreach ($lib in @("bitmap.lib","choreoobjects.lib","tier1.lib","tier2.lib","mathlib.lib","raytrace.lib","dmxloader.lib","dmserializers.lib","datamodel.lib","particles.lib","appframework.lib","vgui_controls.lib","vgui_surfacelib.lib","matsys_controls.lib")) {
  $lp = Join-Path $publicLibDirAudit $lib
  if (Test-Path $lp) {
    $item = Get-Item $lp
    "[ok] $lib $($item.Length) $($item.LastWriteTime)" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
  } else {
    "[miss] $lib" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
  }
}

$beforeBuild = Get-Date'''
if marker in s and "OPENVIBE_WIN32_PRE_CLIENT_LINK_LIB_AUDIT" not in s:
    s = s.replace(marker, insert, 1)

p.write_text(s)
PY

mkdir -p docs
cat > docs/WINDOWS_WIN32_PUBLIC_CLIENT_LIBS_FIX.md <<'EOF'
# Windows Win32 public client libs fix

The Proton-compatible Source SDK Base 2013 path needs 32-bit PE32 DLLs. After converting VPC's generated win64 project metadata to Win32, the HL2MP client link began looking in `src/lib/public` instead of `src/lib/public/x64`.

The previous fix added `bitmap.lib`; the next missing public lib was `choreoobjects.lib`.

This patch expands the Windows dependency build list to cover common Source SDK public static libraries used by the client:

- `bitmap.lib`
- `choreoobjects.lib`
- `tier1.lib`
- `tier2.lib`
- `mathlib.lib`
- `raytrace.lib`
- `dmxloader.lib`
- `dmserializers.lib`
- `datamodel.lib`
- `particles.lib`
- `appframework.lib`
- `vgui_controls.lib`
- `vgui_surfacelib.lib`
- `matsys_controls.lib`

It also audits `src/lib/public` before the client link so the next missing library is obvious from diagnostics.
EOF

if ! git diff --quiet; then
  say "git diff summary"
  git diff --stat
  git add "$BUILD" docs/WINDOWS_WIN32_PUBLIC_CLIENT_LIBS_FIX.md
  git commit -m "Build Win32 public client static libs"
else
  say "no source diff; continuing"
fi

say "pushing $BRANCH"
git push origin "$BRANCH"

HEAD="$(git rev-parse HEAD)"
say "head=$HEAD"
say "triggering Win32 workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1 || true

RUN_ID=""
for i in $(seq 1 40); do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --commit "$HEAD" --limit 5 --json databaseId,status,createdAt,event --jq 'sort_by(.createdAt) | reverse | .[0].databaseId // empty' 2>/dev/null || true)"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    break
  fi
  sleep 3
done

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  warn "could not find run by commit; falling back to latest branch workflow run"
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi

[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "could not find workflow run"
say "watching run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  warn "workflow failed; downloading diagnostics"
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  fail "Win32 DLL workflow failed"
fi

say "workflow passed; downloading/installing latest DLL artifact"
OPENVIBE_EXPECT_DLL_ARCH=x86 tools/install-latest-openvibe-windows-dlls.sh "$RUN_ID"

say "final local DLL check"
file game/openvibe.games/bin/client.dll || true
file game/openvibe.games/bin/server.dll || true
tools/verify-openvibe-dll-content.sh

cat <<'MSG'

[openvibe] installed Win32 patched DLLs.

Fully close hl2.exe/Proton first:
  pkill -f hl2.exe || true
  pkill -f proton || true

Then launch:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

In console test:
  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers

MSG
