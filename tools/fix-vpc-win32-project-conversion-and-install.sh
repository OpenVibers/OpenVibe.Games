#!/usr/bin/env bash
set -euo pipefail
say(){ echo "[openvibe] $*"; }
warn(){ echo "[openvibe warn] $*" >&2; }
fail(){ echo "[openvibe error] $*" >&2; exit 1; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"

say "fix VPC Win32 project conversion + install 32-bit Proton DLLs"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

[[ -f tools/build-sdk-windows.ps1 ]] || fail "tools/build-sdk-windows.ps1 missing"
command -v python3 >/dev/null 2>&1 || fail "python3 missing"
command -v gh >/dev/null 2>&1 || fail "GitHub CLI gh missing"

git checkout "$BRANCH" >/dev/null 2>&1 || true

python3 - <<'PY'
from pathlib import Path
p = Path('tools/build-sdk-windows.ps1')
s = p.read_text()
orig = s

# Fix broken/unused TargetArch variable block from the earlier quick patch.
s = s.replace('''# OPENVIBE_TARGET_ARCH_NORMALIZE_AFTER_VALIDATE
$script:TargetArch = ([string]$script:TargetArch).Trim()
$env:OPENVIBE_WINDOWS_TARGET_ARCH = $script:TargetArch

''', '''# OPENVIBE_TARGET_ARCH_NORMALIZE_AFTER_VALIDATE
$script:OpenVibeTargetArch = ([string]$script:OpenVibeTargetArch).Trim().ToLowerInvariant()
$env:OPENVIBE_WINDOWS_TARGET_ARCH = $script:OpenVibeTargetArch

''')

# Make the arch parsing itself trim and not preserve CR/LF/spaces from cmd/set/vcvars.
s = s.replace('''$script:OpenVibeTargetArch = if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { $env:OPENVIBE_WINDOWS_TARGET_ARCH.ToLowerInvariant() } else { "x86" }''',
'''$script:OpenVibeTargetArch = if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { ([string]$env:OPENVIBE_WINDOWS_TARGET_ARCH).Trim().ToLowerInvariant() } else { "x86" }''')

func = r'''

# OPENVIBE_FORCE_WIN32_FROM_VPC_WIN64_PROJECTS
function Convert-GeneratedVcxprojsToWin32 {
  if ($script:OpenVibeTargetArch -ne "x86") { return }

  $log = Join-Path $LogDir "win32-vcxproj-conversion.txt"
  "target=x86" | Out-File $log
  Say "converting VPC-generated vcxproj files from x64/win64 metadata to Win32"

  $projects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*.vcxproj" -ErrorAction SilentlyContinue)
  foreach ($proj in $projects) {
    $text = Get-Content -Raw $proj.FullName
    $before = $text

    # Convert project configuration/platform names. VPC on current hosted runners emits win64 project files
    # even from an x86 VS shell, so build the same project bodies as Win32.
    $text = $text -replace '\|x64', '|Win32'
    $text = $text -replace '\|Win64', '|Win32'
    $text = $text -replace '<Platform>x64</Platform>', '<Platform>Win32</Platform>'
    $text = $text -replace '<Platform>Win64</Platform>', '<Platform>Win32</Platform>'
    $text = $text -replace '<PlatformTarget>x64</PlatformTarget>', '<PlatformTarget>x86</PlatformTarget>'
    $text = $text -replace '<PlatformTarget>Win64</PlatformTarget>', '<PlatformTarget>x86</PlatformTarget>'
    $text = $text -replace '<TargetMachine>MachineX64</TargetMachine>', '<TargetMachine>MachineX86</TargetMachine>'
    $text = $text -replace 'MachineX64', 'MachineX86'

    # Remove 64-bit preprocessor defines baked into the generated project and add the 32-bit one.
    foreach ($def in @('PLATFORM_64BITS','WIN64','_WIN64','COMPILER_MSVC64')) {
      $text = $text -replace (";" + [regex]::Escape($def) + ";"), ";"
      $text = $text -replace ("(^|>)" + [regex]::Escape($def) + ";"), '$1'
      $text = $text -replace (";" + [regex]::Escape($def) + "(<|$)"), '$1'
    }
    $text = [regex]::Replace($text, '<PreprocessorDefinitions>(?![^<]*COMPILER_MSVC32)', '<PreprocessorDefinitions>COMPILER_MSVC32;')
    $text = $text -replace ';;+', ';'

    # Make x86 link against the normal public lib folder, not lib/public/x64.
    $text = $text -replace '\\lib\\public\\x64', '\lib\public'
    $text = $text -replace '/lib/public/x64', '/lib/public'

    # Avoid Win32 warnings-as-errors while we are building modern VS2022 against old Source SDK code.
    $text = $text -replace '<TreatWarningAsError>true</TreatWarningAsError>', '<TreatWarningAsError>false</TreatWarningAsError>'
    $text = $text -replace '<TreatWarningsAsErrors>true</TreatWarningsAsErrors>', '<TreatWarningsAsErrors>false</TreatWarningsAsErrors>'
    $text = $text -replace '<TreatWarningAsError>Yes \(/WX\)</TreatWarningAsError>', '<TreatWarningAsError>false</TreatWarningAsError>'

    if ($text -ne $before) {
      Set-Content -Encoding utf8 -Path $proj.FullName -Value $text
      "converted $($proj.FullName)" | Out-File $log -Append
    }
  }
}
'''

if 'function Convert-GeneratedVcxprojsToWin32' not in s:
    marker = 'function Patch-GeneratedPythonCustomBuildCommands {'
    if marker not in s:
        raise SystemExit('Could not find Patch-GeneratedPythonCustomBuildCommands marker')
    s = s.replace(marker, func + '\n' + marker, 1)

# Call conversion after VPC project generation and before config discovery/build.
call = '''
if ($script:OpenVibeTargetArch -eq "x86") {
  Convert-GeneratedVcxprojsToWin32
  $clientProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*client*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
  $serverProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*server*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
}
'''
if 'Convert-GeneratedVcxprojsToWin32' in s and 'win32-vcxproj-conversion.txt' in s and 'Convert-GeneratedVcxprojsToWin32\n  $clientProjects' not in s:
    marker = '''"=== normalized solutions ===" | Out-File (Join-Path $LogDir "normalized-solutions.txt")'''
    if marker not in s:
        raise SystemExit('Could not find normalized solutions marker')
    s = s.replace(marker, call + '\n' + marker, 1)

# Force the msbuild invocation to keep warnings from killing Win32 and make PlatformTarget explicit.
old = '''& msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log | Out-Host'''
new = '''$extraProps = @()
    if ($script:OpenVibeTargetArch -eq "x86") {
      $extraProps += "/p:TreatWarningsAsErrors=false"
      $extraProps += "/p:PlatformTarget=x86"
    }
    & msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" @extraProps /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log | Out-Host'''
if old in s:
    s = s.replace(old, new, 1)

if s != orig:
    p.write_text(s)
    print('[patched] tools/build-sdk-windows.ps1')
else:
    print('[noop] tools/build-sdk-windows.ps1 already patched')
PY

mkdir -p docs
cat > docs/WINDOWS_VPC_WIN32_PROJECT_CONVERSION.md <<'EOF_DOC'
# Windows Win32 VPC project conversion

Current Valve Source SDK 2013 VPC output on GitHub's Windows runner can still emit `*_win64_*.vcxproj` projects even when the build is relaunched through an x86 Visual Studio shell. For Proton compatibility with 32-bit Source SDK Base installs, the Windows build script converts generated vcxproj platform/config metadata to Win32 before MSBuild runs.

The conversion changes project configurations from x64/Win64 to Win32, switches the linker target to MachineX86, removes 64-bit preprocessor defines, adds COMPILER_MSVC32, points public library paths back to `lib/public`, and disables warning-as-error behavior for the modern VS2022 Win32 pass.
EOF_DOC

say "git diff summary"
git diff --stat

git add tools/build-sdk-windows.ps1 docs/WINDOWS_VPC_WIN32_PROJECT_CONVERSION.md
if git diff --cached --quiet; then
  say "nothing new to commit"
else
  git commit -m "Convert VPC win64 projects to Win32 for Proton DLLs"
  git push
fi

HEAD_SHA="$(git rev-parse HEAD)"
say "head=$HEAD_SHA"
say "triggering Win32 workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1
sleep 8
RUN_ID=""
for i in {1..30}; do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --commit "$HEAD_SHA" --limit 5 --json databaseId,event,status --jq '[.[] | select(.event=="workflow_dispatch" or .event=="push")][0].databaseId' 2>/dev/null || true)"
  [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] && break
  sleep 3
done
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "could not find workflow run for $HEAD_SHA"

say "watching run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  warn "workflow failed; downloading diagnostics"
  tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  fail "Win32 DLL workflow failed"
fi

say "workflow passed; installing x86 DLL artifact"
OPENVIBE_EXPECT_DLL_ARCH=x86 tools/install-latest-openvibe-windows-dlls.sh "$RUN_ID"

say "installed. final local DLL architecture:"
file game/openvibe.games/bin/client.dll game/openvibe.games/bin/server.dll || true
say "next: fully quit Proton/hl2.exe, then relaunch:"
echo 'OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015'
echo
say "in-game console smoke test:"
echo 'ov_help'
echo 'ov_join hub'
echo 'ov_menu'
echo 'ov_menu_servers'
