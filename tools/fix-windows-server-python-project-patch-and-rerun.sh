#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
BRANCH="$(git branch --show-current)"
REPO="$(git remote get-url origin | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"

echo "[openvibe] fix Windows server vcxproj python custom build commands + rerun"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=$BRANCH"
echo "[openvibe] repo=$REPO"

python3 - <<'PY'
from pathlib import Path
p = Path('tools/build-sdk-windows.ps1')
s = p.read_text()
orig = s

# 1) Ensure the robust MSBuild python shim is actually called. The previous patch
# defined Ensure-PythonCommandForMSBuild but only called Ensure-PythonOnPath.
needle = 'Ensure-PythonOnPath\n'
if needle in s and 'Ensure-PythonCommandForMSBuild\n' not in s.split(needle,1)[1][:120]:
    s = s.replace(needle, 'Ensure-PythonOnPath\nEnsure-PythonCommandForMSBuild\n', 1)

# 2) Make Ensure-PythonCommandForMSBuild publish the selected shim path for later project-file patching.
needle2 = '$env:PATH = "$shimDir;$pyDir;$env:PATH"\n'
if needle2 in s and '$script:OpenVibePythonCommand' not in s[s.find(needle2):s.find(needle2)+260]:
    s = s.replace(needle2, needle2 + '  $script:OpenVibePythonCommand = $bat\n', 1)

# 3) Add a generated vcxproj patcher. The Source SDK VPC emits custom build commands
# that literally start with `python ...`. On hosted Windows, MSBuild sometimes does
# not resolve batch shims through PATH for these custom steps. Rewriting generated
# project files to call the absolute shim is deterministic.
marker = 'function Patch-GeneratedPythonCustomBuildCommands'
func = r'''
function Patch-GeneratedPythonCustomBuildCommands {
  if (-not $script:OpenVibePythonCommand -or !(Test-Path $script:OpenVibePythonCommand)) {
    Ensure-PythonCommandForMSBuild
  }

  $py = $script:OpenVibePythonCommand
  Say "patching generated vcxproj python custom build commands to $py"
  $patchLog = Join-Path $LogDir "python-vcxproj-patches.txt"
  "python command=$py" | Out-File $patchLog

  $projects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*.vcxproj" -ErrorAction SilentlyContinue)
  foreach ($proj in $projects) {
    $text = Get-Content -Raw $proj.FullName
    $before = $text

    # XML command bodies can contain python at line start, after XML tags, or after &&.
    # Replace only executable tokens, preserving surrounding whitespace/tags.
    $text = [regex]::Replace($text, '(?im)(^|[>`r`n])([ `t]*)python(\.exe)?([ `t]+)', {
      param($m)
      return $m.Groups[1].Value + $m.Groups[2].Value + '"' + $py + '"' + $m.Groups[4].Value
    })
    $text = [regex]::Replace($text, '(?i)(&amp;&amp;[ `t]*)python(\.exe)?([ `t]+)', {
      param($m)
      return $m.Groups[1].Value + '"' + $py + '"' + $m.Groups[3].Value
    })
    $text = [regex]::Replace($text, '(?i)(&&[ `t]*)python(\.exe)?([ `t]+)', {
      param($m)
      return $m.Groups[1].Value + '"' + $py + '"' + $m.Groups[3].Value
    })

    if ($text -ne $before) {
      Set-Content -Encoding utf8 -Path $proj.FullName -Value $text
      "patched $($proj.FullName)" | Out-File $patchLog -Append
    }
  }
}
'''
if marker not in s:
    insert_after = 'function Invoke-MSBuildProject([System.IO.FileInfo]$proj, [string]$label) {'
    idx = s.find(insert_after)
    if idx == -1:
        raise SystemExit('Could not find Invoke-MSBuildProject insertion point')
    s = s[:idx] + func + '\n\n' + s[idx:]

# 4) Call patcher after project generation/project discovery but before building dependencies/client/server.
call = 'Patch-GeneratedPythonCustomBuildCommands\n\nBuild-SourceSdkDependencyProjects'
if call not in s:
    s = s.replace('Build-SourceSdkDependencyProjects\n\n$beforeBuild = Get-Date', call + '\n\n$beforeBuild = Get-Date', 1)

if s == orig:
    print('[openvibe] build-sdk-windows.ps1 already had python project patch')
else:
    p.write_text(s)
    print('[openvibe] patched tools/build-sdk-windows.ps1')
PY

cat > docs/WINDOWS_SERVER_PYTHON_CUSTOM_BUILD.md <<'EOF_DOC'
# Windows server.vcxproj Python custom build fix

Valve Source SDK's generated server project uses custom build commands that run
`python` while converting `.nut` script resources into generated headers. On
GitHub-hosted Windows runners, `actions/setup-python` may succeed while the VPC
emitted MSBuild custom step still cannot resolve the literal `python` command.

The Windows build script now:

1. creates a deterministic `python.bat`/`python.cmd` shim;
2. prepends it to PATH;
3. rewrites generated `.vcxproj` custom build command bodies so `python ...`
   uses the absolute shim path.

This keeps the generated Source SDK tree disposable while making CI builds
reliable.
EOF_DOC

echo "[openvibe] git diff summary"
git diff --stat

git add tools/build-sdk-windows.ps1 docs/WINDOWS_SERVER_PYTHON_CUSTOM_BUILD.md
if git diff --cached --quiet; then
  echo "[openvibe] no changes to commit"
else
  git commit -m "Patch Windows server Python custom build commands"
fi

echo "[openvibe] pushing $BRANCH"
git push origin "$BRANCH"

if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  echo "[openvibe] triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh || true
else
  echo "[openvibe] triggering workflow via gh"
  gh workflow run windows-source-sdk-dlls.yml --repo "$REPO" --ref "$BRANCH"
  sleep 5
  RUN_ID="$(gh run list --repo "$REPO" --workflow windows-source-sdk-dlls.yml --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "[openvibe] watching run $RUN_ID"
  gh run watch "$RUN_ID" --repo "$REPO" --exit-status || true
fi

if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
  echo "[openvibe] downloading diagnostics/artifacts"
  tools/windows-workflow-debug-and-install.sh || true
fi

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh || true
fi

echo "[openvibe] done"
