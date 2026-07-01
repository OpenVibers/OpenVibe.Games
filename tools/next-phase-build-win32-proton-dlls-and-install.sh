#!/usr/bin/env bash
set -euo pipefail

say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
fail() { echo "[openvibe error] $*" >&2; exit 1; }

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh 2>/dev/null || true)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
RUN_TIMEOUT_MINUTES="${OPENVIBE_RUN_TIMEOUT_MINUTES:-35}"

[[ -n "$REPO" ]] || fail "could not resolve GitHub repo; set OPENVIBE_REPO=OpenVibers/OpenVibe.Games"
[[ -f tools/build-sdk-windows.ps1 ]] || fail "missing tools/build-sdk-windows.ps1"
[[ -f .github/workflows/windows-source-sdk-dlls.yml ]] || fail "missing .github/workflows/windows-source-sdk-dlls.yml"
command -v gh >/dev/null 2>&1 || fail "gh missing; install/auth gh first"
command -v python3 >/dev/null 2>&1 || fail "python3 missing"

say "next phase: build Proton-compatible 32-bit Windows DLLs and install them"
say "root=$ROOT"
say "branch=$BRANCH"
say "repo=$REPO"

mkdir -p docs tools artifacts/manual-dll-backups

python3 - <<'PY'
from pathlib import Path
import re

root = Path.cwd()
ps = root / "tools/build-sdk-windows.ps1"
s = ps.read_text()
orig = s

# Add target-arch default. Proton Source SDK Base 2013 Multiplayer is 32-bit, so default x86.
if "OPENVIBE_PROTON_WIN32_DLL_TARGET" not in s:
    marker = 'function Say($m) { Write-Host "[openvibe-win] $m" }\n'
    insert = marker + r'''
# OPENVIBE_PROTON_WIN32_DLL_TARGET
$script:OpenVibeTargetArch = if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { $env:OPENVIBE_WINDOWS_TARGET_ARCH.ToLowerInvariant() } else { "x86" }
if ($script:OpenVibeTargetArch -notin @("x86", "x64")) {
  throw "OPENVIBE_WINDOWS_TARGET_ARCH must be x86 or x64, got '$script:OpenVibeTargetArch'"
}
Write-Host "[openvibe-win] target arch=$script:OpenVibeTargetArch"
'''
    if marker not in s:
        raise SystemExit("could not find Say() marker")
    s = s.replace(marker, insert, 1)
else:
    # Force default back to x86 if an older variant exists.
    s = re.sub(r'else \{ "x64" \}', 'else { "x86" }', s)

# Add arch-aware vcvars resolver after existing Find-VcVars64 if not present.
if "function Find-VcVarsForOpenVibeArch" not in s:
    m = re.search(r'function Find-VcVars64 \{.*?^\}', s, flags=re.S | re.M)
    if not m:
        raise SystemExit("could not locate Find-VcVars64 block")
    add = r'''

function Find-VcVarsForOpenVibeArch([string]$arch) {
  $editions = @("Enterprise", "Professional", "Community", "BuildTools")
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }

  if ($arch -eq "x86") {
    foreach ($root in $roots) {
      foreach ($ed in $editions) {
        $p = Join-Path $root "Microsoft Visual Studio\2022\$ed\VC\Auxiliary\Build\vcvars32.bat"
        if (Test-Path $p) { return [pscustomobject]@{ Path = $p; Args = "" } }
      }
    }
    foreach ($root in $roots) {
      foreach ($ed in $editions) {
        $p = Join-Path $root "Microsoft Visual Studio\2022\$ed\VC\Auxiliary\Build\vcvarsall.bat"
        if (Test-Path $p) { return [pscustomobject]@{ Path = $p; Args = "x86" } }
      }
    }
  } else {
    foreach ($root in $roots) {
      foreach ($ed in $editions) {
        $p = Join-Path $root "Microsoft Visual Studio\2022\$ed\VC\Auxiliary\Build\vcvars64.bat"
        if (Test-Path $p) { return [pscustomobject]@{ Path = $p; Args = "" } }
      }
    }
    foreach ($root in $roots) {
      foreach ($ed in $editions) {
        $p = Join-Path $root "Microsoft Visual Studio\2022\$ed\VC\Auxiliary\Build\vcvarsall.bat"
        if (Test-Path $p) { return [pscustomobject]@{ Path = $p; Args = "x64" } }
      }
    }
  }

  return $null
}
'''
    s = s[:m.end()] + add + s[m.end():]

old = r'''# VPC is generating *_win64_*.vcxproj on the hosted runner, so use an x64 VS shell.
# clang-cl/lib/msbuild all remain MSVC ABI-compatible.
if (-not $InDevShell -or !(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vcvars = Find-VcVars64
  if (-not $vcvars) { throw "Could not find Visual Studio vcvars64.bat" }
  Say "relaunching through MSVC x64 dev shell: $vcvars"
  $self = $PSCommandPath
  $cmd = "`"$vcvars`" && powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -InDevShell"
  & cmd.exe /d /s /c $cmd
  exit $LASTEXITCODE
}
'''
new = r'''# Proton's Source SDK Base 2013 Multiplayer Windows hl2.exe is 32-bit in normal installs,
# so default to x86 DLLs. Set OPENVIBE_WINDOWS_TARGET_ARCH=x64 only for a native x64 test.
if (-not $InDevShell -or !(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vc = Find-VcVarsForOpenVibeArch $script:OpenVibeTargetArch
  if (-not $vc) { throw "Could not find Visual Studio vcvars for target arch $script:OpenVibeTargetArch" }
  Say "relaunching through MSVC $script:OpenVibeTargetArch dev shell: $($vc.Path) $($vc.Args)"
  $self = $PSCommandPath
  $vcCall = if ($vc.Args) { "`"$($vc.Path)`" $($vc.Args)" } else { "`"$($vc.Path)`"" }
  $cmd = "$vcCall && set OPENVIBE_WINDOWS_TARGET_ARCH=$script:OpenVibeTargetArch && powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -InDevShell"
  & cmd.exe /d /s /c $cmd
  exit $LASTEXITCODE
}
'''
if old in s:
    s = s.replace(old, new, 1)
else:
    s = re.sub(r'# VPC is generating .*?\nif \(-not \$InDevShell.*?exit \$LASTEXITCODE\n\}', new.rstrip(), s, count=1, flags=re.S)

# Fallback project config should match target arch.
s = s.replace('$pairs = @([pscustomobject]@{ Configuration = "Release"; Platform = "x64" })',
              '$pairs = @([pscustomobject]@{ Configuration = "Release"; Platform = if ($script:OpenVibeTargetArch -eq "x86") { "Win32" } else { "x64" } })')

# Prefer platform matching target arch.
s = s.replace('foreach ($plat in @("x64", "Win64", "Win32", "x86")) {',
              '$platformPreference = if ($script:OpenVibeTargetArch -eq "x86") { @("Win32", "x86", "x64", "Win64") } else { @("x64", "Win64", "Win32", "x86") }\n    foreach ($plat in $platformPreference) {')

# Build dependency projects for either win32/no-suffix or win64 names.
s = re.sub(r'\$patterns = @\(\n\s+"tier1\*_win64\.vcxproj",\n\s+"mathlib\*_win64\.vcxproj",\n\s+"raytrace\*_win64\.vcxproj",\n\s+"vgui_controls\*_win64\.vcxproj",\n\s+"matsys_controls\*_win64\.vcxproj",\n\s+"fgdlib\*_win64\.vcxproj"\n\s+\)',
           '$patterns = @(\n    "tier1*.vcxproj",\n    "mathlib*.vcxproj",\n    "raytrace*.vcxproj",\n    "vgui_controls*.vcxproj",\n    "matsys_controls*.vcxproj",\n    "fgdlib*.vcxproj"\n  )', s)

# Use lib/public for x86 and lib/public/x64 for x64.
s = s.replace('$publicX64 = Join-Path $Src "lib/public/x64"\n  Copy-LibIfNeeded "mathlib.lib" $publicX64\n  Copy-LibIfNeeded "tier1.lib" $publicX64\n  Copy-LibIfNeeded "raytrace.lib" $publicX64\n  Copy-LibIfNeeded "vgui_controls.lib" $publicX64\n  Copy-LibIfNeeded "matsys_controls.lib" $publicX64\n\n  "=== public x64 libs after deps ===" | Out-File (Join-Path $LogDir "public-x64-libs-after-deps.txt")\n  if (Test-Path $publicX64) {\n    Get-ChildItem -Path $publicX64 -File -ErrorAction SilentlyContinue |\n      Select-Object FullName,Length,LastWriteTime |\n      Format-List | Out-File (Join-Path $LogDir "public-x64-libs-after-deps.txt") -Append\n  }',
'''$publicLibDir = if ($script:OpenVibeTargetArch -eq "x86") { Join-Path $Src "lib/public" } else { Join-Path $Src "lib/public/x64" }
  Copy-LibIfNeeded "mathlib.lib" $publicLibDir
  Copy-LibIfNeeded "tier1.lib" $publicLibDir
  Copy-LibIfNeeded "raytrace.lib" $publicLibDir
  Copy-LibIfNeeded "vgui_controls.lib" $publicLibDir
  Copy-LibIfNeeded "matsys_controls.lib" $publicLibDir

  "=== public libs after deps ($script:OpenVibeTargetArch) ===" | Out-File (Join-Path $LogDir "public-libs-after-deps.txt")
  if (Test-Path $publicLibDir) {
    Get-ChildItem -Path $publicLibDir -File -ErrorAction SilentlyContinue |
      Select-Object FullName,Length,LastWriteTime |
      Format-List | Out-File (Join-Path $LogDir "public-libs-after-deps.txt") -Append
  }''')

# Project preference: choose win32/no-win64 for x86, win64 for x64.
old_proj = r'''# Prefer the actual HL2MP game projects and prefer win64 because current Valve VPC emitted *_win64_hl2mp.vcxproj on the runner.
$clientProject = $clientProjects |
  Sort-Object @{ Expression = { if ($_.Name -match 'win64') { 0 } else { 1 } } },
              @{ Expression = { if ($_.Name -match '^client') { 0 } else { 1 } } },
              FullName |
  Select-Object -First 1
$serverProject = $serverProjects |
  Sort-Object @{ Expression = { if ($_.Name -match 'win64') { 0 } else { 1 } } },
              @{ Expression = { if ($_.Name -match '^server') { 0 } else { 1 } } },
              FullName |
  Select-Object -First 1
'''
new_proj = r'''# Prefer the actual HL2MP game projects and the requested target architecture.
function Get-OpenVibeProjectArchScore([System.IO.FileInfo]$p) {
  if ($script:OpenVibeTargetArch -eq "x86") {
    if ($p.Name -match 'win64|x64') { return 20 }
    if ($p.Name -match 'win32|x86') { return 0 }
    return 5
  }
  if ($p.Name -match 'win64|x64') { return 0 }
  if ($p.Name -match 'win32|x86') { return 20 }
  return 5
}
$clientProject = $clientProjects |
  Sort-Object @{ Expression = { Get-OpenVibeProjectArchScore $_ } },
              @{ Expression = { if ($_.Name -match '^client') { 0 } else { 1 } } },
              FullName |
  Select-Object -First 1
$serverProject = $serverProjects |
  Sort-Object @{ Expression = { Get-OpenVibeProjectArchScore $_ } },
              @{ Expression = { if ($_.Name -match '^server') { 0 } else { 1 } } },
              FullName |
  Select-Object -First 1
Say "selected client project=$($clientProject.FullName)"
Say "selected server project=$($serverProject.FullName)"
'''
if old_proj in s:
    s = s.replace(old_proj, new_proj, 1)
else:
    # tolerant replacement between comment and Patch-GeneratedPythonCustomBuildCommands
    s = re.sub(r'# Prefer the actual HL2MP game projects.*?\$serverProject = \$serverProjects \|.*?Select-Object -First 1\n', new_proj, s, count=1, flags=re.S)

# When collecting final DLLs, prefer the right arch path by name/path if both exist.
# No hard failure here; installer verifies PE architecture from Linux.

if s != orig:
    ps.write_text(s)
    print(f"[patched] {ps}")
else:
    print(f"[unchanged] {ps}")
PY

python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/windows-source-sdk-dlls.yml')
s = p.read_text()
orig = s
if 'OPENVIBE_WINDOWS_TARGET_ARCH:' not in s:
    needle = '    runs-on: windows-2022\n'
    repl = needle + '    env:\n      OPENVIBE_WINDOWS_TARGET_ARCH: x86\n'
    if needle not in s:
        raise SystemExit('could not find runs-on marker in workflow')
    s = s.replace(needle, repl, 1)
else:
    s = s.replace('OPENVIBE_WINDOWS_TARGET_ARCH: x64', 'OPENVIBE_WINDOWS_TARGET_ARCH: x86')
if s != orig:
    p.write_text(s)
    print(f"[patched] {p}")
else:
    print(f"[unchanged] {p}")
PY

cat > tools/install-latest-openvibe-windows-dlls.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
fail() { echo "[openvibe error] $*" >&2; exit 1; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
RUN_ID="${1:-}"
EXPECTED_ARCH="${OPENVIBE_EXPECT_DLL_ARCH:-x86}"
command -v gh >/dev/null 2>&1 || fail "gh missing"
command -v file >/dev/null 2>&1 || warn "file command missing; architecture check will be weaker"
command -v strings >/dev/null 2>&1 || fail "strings missing; install binutils"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 10 --json databaseId,status,conclusion --jq '[.[] | select(.status=="completed" and .conclusion=="success")][0].databaseId')"
fi
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "no successful workflow run found for $WORKFLOW on $BRANCH"
OUT="$ROOT/artifacts/windows-dll-install/run-$RUN_ID"
rm -rf "$OUT"
mkdir -p "$OUT"
say "downloading openvibe-windows-dlls from run $RUN_ID"
gh run download "$RUN_ID" --repo "$REPO" --name openvibe-windows-dlls --dir "$OUT"
CLIENT="$(find "$OUT" -type f -iname client.dll | sort | head -n1 || true)"
SERVER="$(find "$OUT" -type f -iname server.dll | sort | head -n1 || true)"
[[ -f "$CLIENT" ]] || fail "client.dll missing from artifact"
[[ -f "$SERVER" ]] || fail "server.dll missing from artifact"
say "candidate client=$CLIENT"
say "candidate server=$SERVER"
file "$CLIENT" || true
file "$SERVER" || true
if [[ "$EXPECTED_ARCH" == "x86" ]] && file "$CLIENT" 2>/dev/null | grep -Fq 'PE32+'; then
  fail "artifact client.dll is x64/PE32+. Proton Source SDK Base needs 32-bit PE32 DLLs. Re-run the Win32 build patch."
fi
if [[ "$EXPECTED_ARCH" == "x86" ]] && file "$SERVER" 2>/dev/null | grep -Fq 'PE32+'; then
  fail "artifact server.dll is x64/PE32+. Proton Source SDK Base needs 32-bit PE32 DLLs. Re-run the Win32 build patch."
fi
strings -a "$CLIENT" | grep -Eq 'ov_join|ov_menu|OpenVibe' || fail "artifact client.dll lacks OpenVibe client strings"
strings -a "$SERVER" | grep -Eq 'ov_js_status|ov_js_cmd|OpenVibe' || fail "artifact server.dll lacks OpenVibe server strings"
mkdir -p game/openvibe.games/bin artifacts/manual-dll-backups
STAMP="$(date +%Y%m%d-%H%M%S)"
[[ -f game/openvibe.games/bin/client.dll ]] && cp -f game/openvibe.games/bin/client.dll "artifacts/manual-dll-backups/client.dll.$STAMP.bak" || true
[[ -f game/openvibe.games/bin/server.dll ]] && cp -f game/openvibe.games/bin/server.dll "artifacts/manual-dll-backups/server.dll.$STAMP.bak" || true
cp -f "$CLIENT" game/openvibe.games/bin/client.dll
cp -f "$SERVER" game/openvibe.games/bin/server.dll
say "installed patched Windows DLLs to game/openvibe.games/bin"
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
else
  strings -a game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|OpenVibe' | head
  strings -a game/openvibe.games/bin/server.dll | grep -E 'ov_js_status|ov_js_cmd|OpenVibe' | head
fi
EOS
chmod +x tools/install-latest-openvibe-windows-dlls.sh

cat > tools/proton-openvibe-command-smoke.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
echo "[openvibe] installed DLL architecture/content"
file game/openvibe.games/bin/client.dll game/openvibe.games/bin/server.dll || true
strings -a game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|ov_auth_steam|OpenVibe' | head -20 || true
strings -a game/openvibe.games/bin/server.dll | grep -E 'ov_js_status|ov_js_cmd|OpenVibe' | head -20 || true
cat <<'MSG'
[openvibe] launch command:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

[openvibe] in-game console smoke test:
  ov_help
  ov_join hub
  ov_menu
  ov_menu_servers
  ov_auth_steam

[openvibe] if those are still Unknown command, collect Proton load logs:
  tools/collect-proton-openvibe-debug.sh
MSG
EOS
chmod +x tools/proton-openvibe-command-smoke.sh

cat > docs/WINDOWS_PROTON_32BIT_DLLS.md <<'EOS'
# Windows/Proton Source SDK DLL architecture

The Proton launch path uses the Windows `hl2.exe` from Source SDK Base 2013 Multiplayer. In the normal Steam install this is a 32-bit executable, so the mod must install 32-bit `client.dll` and `server.dll` in `game/openvibe.games/bin`.

The GitHub Actions Windows build therefore defaults `OPENVIBE_WINDOWS_TARGET_ARCH=x86` and uses the x86 Visual Studio developer shell. x64/PE32+ DLLs may build successfully, but Proton/HL2 will not load them for the normal 32-bit SDK Base client.

Use:

```bash
tools/install-latest-openvibe-windows-dlls.sh
```

Then smoke test:

```bash
tools/proton-openvibe-command-smoke.sh
```
EOS

say "git diff summary"
git diff --stat -- .github/workflows/windows-source-sdk-dlls.yml tools/build-sdk-windows.ps1 tools/install-latest-openvibe-windows-dlls.sh tools/proton-openvibe-command-smoke.sh docs/WINDOWS_PROTON_32BIT_DLLS.md tools/next-phase-build-win32-proton-dlls-and-install.sh || true

git add .github/workflows/windows-source-sdk-dlls.yml \
  tools/build-sdk-windows.ps1 \
  tools/install-latest-openvibe-windows-dlls.sh \
  tools/proton-openvibe-command-smoke.sh \
  docs/WINDOWS_PROTON_32BIT_DLLS.md \
  tools/next-phase-build-win32-proton-dlls-and-install.sh 2>/dev/null || true

if ! git diff --cached --quiet; then
  git commit -m "Build Proton-compatible Win32 Source DLLs"
else
  say "no source changes to commit"
fi

say "pushing $BRANCH"
git push

say "triggering clean Windows DLL build"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1
sleep 8
HEAD_SHA="$(git rev-parse HEAD)"
RUN_ID=""
for i in {1..24}; do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 10 --json databaseId,headSha,status --jq --arg sha "$HEAD_SHA" '[.[] | select(.headSha==$sha)][0].databaseId')"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then break; fi
  sleep 5
done
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "could not find new workflow run for head $HEAD_SHA"
say "watching run $RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  say "workflow passed"
else
  warn "workflow failed; downloading diagnostics"
  if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
    tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
  else
    gh run view "$RUN_ID" --repo "$REPO" --log || true
  fi
  exit 2
fi

say "installing latest successful DLL artifact"
OPENVIBE_EXPECT_DLL_ARCH=x86 tools/install-latest-openvibe-windows-dlls.sh "$RUN_ID"

tools/proton-openvibe-command-smoke.sh
say "done"
