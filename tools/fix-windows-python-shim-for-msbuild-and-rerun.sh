#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORKFLOW="windows-source-sdk-dlls.yml"

if [[ -x tools/openvibe-gh-repo.sh ]]; then
  # shellcheck disable=SC1091
  REPO="$(tools/openvibe-gh-repo.sh)"
else
  REPO="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
fi
REPO="${REPO%.git}"

echo "[openvibe] fix Windows MSBuild Python shim + rerun"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=$BRANCH"
echo "[openvibe] repo=$REPO"

# Keep setup-python in the workflow. This is still useful, but vcvars/msbuild can lose PATH,
# so the PowerShell build script will also create its own python.bat shim.
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/windows-source-sdk-dlls.yml')
if p.exists():
    s = p.read_text()
    if 'actions/setup-python@v5' not in s:
        marker = '      - name: Setup MSBuild\n'
        block = """      - name: Setup Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: '3.x'\n\n"""
        if marker in s:
            s = s.replace(marker, block + marker, 1)
        else:
            s += "\n" + block
        p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p = Path('tools/build-sdk-windows.ps1')
s = p.read_text()
marker = 'OPENVIBE_PYTHON_SHIM_FOR_MSBUILD'
func = r'''
# OPENVIBE_PYTHON_SHIM_FOR_MSBUILD
function Ensure-PythonCommandForMSBuild {
  $shimDir = Join-Path $Root "artifacts/python-shim"
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  $log = Join-Path $LogDir "python-version.txt"
  "=== Ensure-PythonCommandForMSBuild ===" | Out-File $log
  "initial PATH=$env:PATH" | Out-File $log -Append
  "pythonLocation=$env:pythonLocation" | Out-File $log -Append
  "Python_ROOT_DIR=$env:Python_ROOT_DIR" | Out-File $log -Append

  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($base in @($env:pythonLocation, $env:Python_ROOT_DIR, $env:Python3_ROOT_DIR)) {
    if ($base) {
      [void]$candidates.Add((Join-Path $base "python.exe"))
      [void]$candidates.Add((Join-Path $base "python3.exe"))
    }
  }

  foreach ($name in @("python.exe", "python3.exe", "py.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { [void]$candidates.Add($cmd.Source) }
  }

  foreach ($rootCandidate in @("C:\hostedtoolcache\windows\Python", "C:\hostedtoolcache\windows\PyPy")) {
    if (Test-Path $rootCandidate) {
      Get-ChildItem -Path $rootCandidate -Recurse -File -Filter "python.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { [void]$candidates.Add($_.FullName) }
    }
  }

  $py = $null
  foreach ($cand in ($candidates | Select-Object -Unique)) {
    if ($cand -and (Test-Path $cand)) {
      $py = (Resolve-Path $cand).Path
      break
    }
  }

  if (-not $py) {
    "candidate list:" | Out-File $log -Append
    $candidates | Out-File $log -Append
    throw "Python executable not found after setup-python/vcvars. Check python-version.txt in the debug artifact."
  }

  $pyDir = Split-Path -Parent $py
  $bat = Join-Path $shimDir "python.bat"
  $cmdFile = Join-Path $shimDir "python.cmd"
  $batContent = @"
@echo off
"$py" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -Encoding ascii -Path $bat -Value $batContent
  Set-Content -Encoding ascii -Path $cmdFile -Value $batContent

  # Put the shim first so custom build steps that literally run `python` find it.
  $env:PATH = "$shimDir;$pyDir;$env:PATH"
  "selected python=$py" | Out-File $log -Append
  "shimDir=$shimDir" | Out-File $log -Append
  "updated PATH=$env:PATH" | Out-File $log -Append
  & $py --version 2>&1 | Tee-Object -FilePath $log -Append
  & cmd.exe /d /s /c "where python" 2>&1 | Tee-Object -FilePath $log -Append
}
'''

if marker not in s:
    # Insert after Require function, before Find-VcVars64.
    needle = 'function Find-VcVars64 {'
    if needle not in s:
        raise SystemExit('Could not find Find-VcVars64 insertion point in tools/build-sdk-windows.ps1')
    s = s.replace(needle, func + '\n' + needle, 1)

# Ensure it is called after tool where dumps in the x64 dev shell, before apply-openvibe-sdk/build.
call = 'Ensure-PythonCommandForMSBuild'
if call not in s.split('# Apply OpenVibe source files', 1)[0]:
    needle = 'where.exe lib | Out-File (Join-Path $LogDir "where-lib.txt")\n'
    if needle in s:
        s = s.replace(needle, needle + call + '\n', 1)
    else:
        needle2 = 'Say "cl.exe already available"\n'
        if needle2 not in s:
            raise SystemExit('Could not find tool setup insertion point in tools/build-sdk-windows.ps1')
        s = s.replace(needle2, needle2 + call + '\n', 1)

p.write_text(s)
PY

# Commit patch.
echo "[openvibe] git diff summary"
git diff --stat .github/workflows/windows-source-sdk-dlls.yml tools/build-sdk-windows.ps1 || true

git add .github/workflows/windows-source-sdk-dlls.yml tools/build-sdk-windows.ps1
if git diff --cached --quiet; then
  echo "[openvibe] no code changes to commit"
else
  git commit -m "Make python available to Windows MSBuild custom steps"
fi

echo "[openvibe] pushing $BRANCH"
git push origin "$BRANCH"

# Trigger and watch/download using the repo helper if available.
if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  echo "[openvibe] triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh
else
  echo "[openvibe] triggering workflow"
  gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"
  sleep 8
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "[openvibe] watching run $RUN_ID"
  gh run watch --repo "$REPO" "$RUN_ID" --exit-status || true
  if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
    tools/windows-workflow-debug-and-install.sh || true
  fi
fi

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  echo "[openvibe] verify DLL content"
  tools/verify-openvibe-dll-content.sh || true
fi

echo "[openvibe] done"
