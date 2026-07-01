#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$(pwd)}"
if [[ ! -d "$ROOT/.git" ]]; then
  ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
fi
cd "$ROOT"

say(){ printf '[openvibe] %s\n' "$*"; }

say "fix Windows build: build Source SDK deps + make python available"
say "root=$ROOT"
say "branch=$(git branch --show-current)"

python3 - <<'PY'
from pathlib import Path
import re

root = Path.cwd()
workflow = root / '.github/workflows/windows-source-sdk-dlls.yml'
build = root / 'tools/build-sdk-windows.ps1'

# ---------------------------------------------------------------------------
# 1) Workflow: GitHub Windows runner has Python installed in some contexts, but
# Source SDK custom build steps call literal "python" from inside vcvars/msbuild.
# setup-python makes that deterministic.
# ---------------------------------------------------------------------------
y = workflow.read_text()
if 'actions/setup-python@v5' not in y:
    needle = '''      - name: Setup MSBuild\n        uses: microsoft/setup-msbuild@v2\n'''
    repl = needle + '''\n      - name: Setup Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: "3.x"\n'''
    if needle not in y:
        raise SystemExit('Could not find Setup MSBuild block in workflow')
    y = y.replace(needle, repl)
workflow.write_text(y)

# ---------------------------------------------------------------------------
# 2) Build script: install a python command/shim onto PATH after vcvars64.
# ---------------------------------------------------------------------------
s = build.read_text()
helper = r'''
function Ensure-PythonOnPath {
  $pyCmd = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $pyCmd) { $pyCmd = Get-Command python -ErrorAction SilentlyContinue }
  if ($pyCmd) {
    Say "python=$($pyCmd.Source)"
    try { & $pyCmd.Source --version 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "python-version.txt") | Out-Null } catch {}
    return
  }

  $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    $shimDir = Join-Path $Root "_tools/python-shim"
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    $shim = Join-Path $shimDir "python.bat"
    "@echo off`r`npy -3 %*`r`n" | Set-Content -Encoding ascii $shim
    $env:PATH = "$shimDir;$env:PATH"
    Say "python shim=$shim"
    & python --version 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "python-version.txt") | Out-Null
    return
  }

  throw "python was not found on PATH and py.exe was not found. Add actions/setup-python before the build step."
}
'''
if 'function Ensure-PythonOnPath' not in s:
    marker = 'function Require($p, $msg) {\n  if (!(Test-Path $p)) { throw "$msg`nMissing: $p" }\n}\n'
    if marker not in s:
        raise SystemExit('Could not find Require function marker')
    s = s.replace(marker, marker + helper + '\n')

call_marker = 'where.exe lib | Out-File (Join-Path $LogDir "where-lib.txt")\n'
if 'Ensure-PythonOnPath' in s and 'Ensure-PythonOnPath\n\n# Apply OpenVibe' not in s:
    if call_marker not in s:
        raise SystemExit('Could not find where-lib marker')
    s = s.replace(call_marker, call_marker + 'Ensure-PythonOnPath\n\n')

# ---------------------------------------------------------------------------
# 3) Build dependency libs before client/server projects.
# Direct .vcxproj builds do not necessarily build VPC's implicit lib deps.
# Current failure was missing src/lib/public/x64/mathlib.lib.
# ---------------------------------------------------------------------------
deps_block = r'''
function Find-ProjectByPattern([string]$pattern) {
  return @(Get-ChildItem -Path $Src -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue |
    Sort-Object @{ Expression = { if ($_.FullName -match "\\(mathlib|tier1|raytrace|vgui2|fgdlib)\\") { 0 } else { 1 } } }, FullName)
}

function Copy-LibIfNeeded([string]$libName, [string]$destDir) {
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $dest = Join-Path $destDir $libName
  if (Test-Path $dest) { return }
  $found = Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($found) {
    Say "copying fallback lib $($found.FullName) -> $dest"
    Copy-Item $found.FullName $dest -Force
  }
}

function Build-SourceSdkDependencyProjects {
  Say "building Source SDK dependency libraries before HL2MP client/server"

  $patterns = @(
    "tier1*_win64.vcxproj",
    "mathlib*_win64.vcxproj",
    "raytrace*_win64.vcxproj",
    "vgui_controls*_win64.vcxproj",
    "matsys_controls*_win64.vcxproj",
    "fgdlib*_win64.vcxproj"
  )

  $projects = @()
  foreach ($pat in $patterns) {
    $projects += Find-ProjectByPattern $pat
  }
  $projects = @($projects | Sort-Object FullName -Unique)

  "=== dependency projects ===" | Out-File (Join-Path $LogDir "dependency-projects.txt")
  $projects | Select-Object FullName,Length,LastWriteTime | Format-List | Out-File (Join-Path $LogDir "dependency-projects.txt") -Append

  foreach ($dep in $projects) {
    $label = "dep-$($dep.BaseName -replace '[^A-Za-z0-9]+','_')"
    [void](Invoke-MSBuildProject $dep $label)
  }

  $publicX64 = Join-Path $Src "lib/public/x64"
  Copy-LibIfNeeded "mathlib.lib" $publicX64
  Copy-LibIfNeeded "tier1.lib" $publicX64
  Copy-LibIfNeeded "raytrace.lib" $publicX64
  Copy-LibIfNeeded "vgui_controls.lib" $publicX64
  Copy-LibIfNeeded "matsys_controls.lib" $publicX64

  "=== public x64 libs after deps ===" | Out-File (Join-Path $LogDir "public-x64-libs-after-deps.txt")
  if (Test-Path $publicX64) {
    Get-ChildItem -Path $publicX64 -File -ErrorAction SilentlyContinue |
      Select-Object FullName,Length,LastWriteTime |
      Format-List | Out-File (Join-Path $LogDir "public-x64-libs-after-deps.txt") -Append
  }
}
'''
if 'function Build-SourceSdkDependencyProjects' not in s:
    marker = 'function Invoke-MSBuildProject([System.IO.FileInfo]$proj, [string]$label) {'
    idx = s.find(marker)
    if idx == -1:
        raise SystemExit('Could not find Invoke-MSBuildProject function marker')
    # place deps block after Invoke-MSBuildProject function by locating the next Generate projects comment
    gen_marker = '# Generate projects if no relevant vcxproj files exist yet.'
    gen_idx = s.find(gen_marker)
    if gen_idx == -1:
        raise SystemExit('Could not find Generate projects marker')
    s = s[:gen_idx] + deps_block + '\n' + s[gen_idx:]

build_call_marker = '$beforeBuild = Get-Date\n\nif (-not (Invoke-MSBuildProject $clientProject "client")) {'
if 'Build-SourceSdkDependencyProjects\n\n$beforeBuild = Get-Date' not in s:
    if build_call_marker not in s:
        raise SystemExit('Could not find beforeBuild/client build marker')
    s = s.replace(build_call_marker, 'Build-SourceSdkDependencyProjects\n\n$beforeBuild = Get-Date\n\nif (-not (Invoke-MSBuildProject $clientProject "client")) {')

build.write_text(s)
PY

say "git diff summary"
git diff --stat

git add .github/workflows/windows-source-sdk-dlls.yml tools/build-sdk-windows.ps1
if git diff --cached --quiet; then
  say "nothing to commit"
else
  git commit -m "Build Windows Source SDK dependencies before HL2MP DLLs"
fi

git push

say "triggering clean Windows DLL build"
if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  tools/trigger-windows-dll-build-clean.sh
else
  tools/gh-windows-build-and-install.sh
fi
