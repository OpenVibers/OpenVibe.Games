param(
  [switch]$InDevShell
)

$ErrorActionPreference = "Stop"
# OPENVIBE_TARGET_ARCH_TRIM_GUARD
if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { $env:OPENVIBE_WINDOWS_TARGET_ARCH = $env:OPENVIBE_WINDOWS_TARGET_ARCH.Trim() }
if ($script:TargetArch) { $script:TargetArch = ([string]$script:TargetArch).Trim() }


$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root "engine/source-sdk-2013" }
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }

# OPENVIBE_PROTON_WIN32_DLL_TARGET
$script:OpenVibeTargetArch = if ($env:OPENVIBE_WINDOWS_TARGET_ARCH) { ([string]$env:OPENVIBE_WINDOWS_TARGET_ARCH).Trim().ToLowerInvariant() } else { "x86" }
if ($script:OpenVibeTargetArch -notin @("x86", "x64")) {
  throw "OPENVIBE_WINDOWS_TARGET_ARCH must be x86 or x64, got '$script:OpenVibeTargetArch'"
}
# OPENVIBE_TARGET_ARCH_NORMALIZE_AFTER_VALIDATE
$script:OpenVibeTargetArch = ([string]$script:OpenVibeTargetArch).Trim().ToLowerInvariant()
$env:OPENVIBE_WINDOWS_TARGET_ARCH = $script:OpenVibeTargetArch

Write-Host "[openvibe-win] target arch=$script:OpenVibeTargetArch"
function Require($p, $msg) {
  if (!(Test-Path $p)) { throw "$msg`nMissing: $p" }
}

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
  $script:OpenVibePythonExe = $py
  $bat = Join-Path $shimDir "python.bat"
  $cmdFile = Join-Path $shimDir "python.cmd"
  $batContent = @"
@echo off
"$py" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -Encoding ascii -Path $bat -Value $batContent
  Set-Content -Encoding ascii -Path $cmdFile -Value $batContent
  $script:OpenVibePythonShim = $bat

  # Put the shim first so custom build steps that literally run `python` find it.
  $env:PATH = "$shimDir;$pyDir;$env:PATH"
  $script:OpenVibePythonCommand = $bat
  "selected python=$py" | Out-File $log -Append
  "shimDir=$shimDir" | Out-File $log -Append
  "updated PATH=$env:PATH" | Out-File $log -Append
  & $py --version 2>&1 | Tee-Object -FilePath $log -Append
  & cmd.exe /d /s /c "where python" 2>&1 | Tee-Object -FilePath $log -Append
}



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

function Find-VcVars64 {
  $candidates = @(
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

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


Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"

Require $Src "Source SDK checkout is missing from this runner. Bootstrap must create engine/source-sdk-2013 first."

# Proton's Source SDK Base 2013 Multiplayer Windows hl2.exe is 32-bit in normal installs,
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

Say "cl.exe already available"
where.exe cl | Out-File (Join-Path $LogDir "where-cl.txt")
where.exe msbuild | Out-File (Join-Path $LogDir "where-msbuild.txt")
where.exe lib | Out-File (Join-Path $LogDir "where-lib.txt")
Ensure-PythonOnPath
Ensure-PythonCommandForMSBuild


# Apply OpenVibe source files using Git Bash when available. Skip Linux QuickJS build on Windows.
$bash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($bash) {
  Say "applying OpenVibe SDK patch through bash"
  $env:OPENVIBE_ROOT = $Root
  $env:OPENVIBE_SDK = $Sdk
  $env:OPENVIBE_SKIP_QJS_BUILD = "1"
  & bash "$Root/tools/apply-openvibe-sdk.sh" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "apply-openvibe-sdk.log")
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed with exit code $LASTEXITCODE" }
} else {
  throw "Git Bash is required on the Windows runner to apply the OpenVibe SDK patch."
}

# Build QuickJS as MSVC ABI objects/lib. quickjs itself uses clang-cl because the upstream C is GNU/C99-ish.
if (Test-Path (Join-Path $Root "tools/build-quickjs-lib-windows.ps1")) {
  Say "building QuickJS Windows static library"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/build-quickjs-lib-windows.ps1") 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "quickjs-windows.log")
  if ($LASTEXITCODE -ne 0) { throw "build-quickjs-lib-windows.ps1 failed with exit code $LASTEXITCODE" }
} else {
  Say "no build-quickjs-lib-windows.ps1 found; continuing"
}

Patch-QuickJsHeaderForMsvcCpp

Set-Location $Src

function Test-SlnContent([string]$path) {
  if (!(Test-Path $path)) { return $false }
  try {
    $first = Get-Content -Path $path -TotalCount 3 -ErrorAction Stop
    return (($first -join "`n") -match "Microsoft Visual Studio Solution File")
  } catch {
    return $false
  }
}

function Normalize-Solutions {
  $out = New-Object System.Collections.Generic.List[System.IO.FileInfo]

  # Normal .sln files.
  Get-ChildItem -Path $Src -Recurse -File -Filter "*.sln" -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-SlnContent $_.FullName) { [void]$out.Add($_) }
  }

  # VPC sometimes logs "Writing solution file ...\everything." and produces an extensionless-ish file.
  Get-ChildItem -Path $Src -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(everything|games|OpenVibe_HL2MP)(\.?)$' } |
    ForEach-Object {
      if (Test-SlnContent $_.FullName) {
        $fixed = Join-Path $_.DirectoryName ($_.BaseName.TrimEnd('.') + ".sln")
        if ($fixed -ne $_.FullName) {
          Copy-Item $_.FullName $fixed -Force
          Say "normalized extensionless VPC solution $($_.FullName) -> $fixed"
          [void]$out.Add((Get-Item $fixed))
        } else {
          [void]$out.Add($_)
        }
      }
    }

  return @($out | Sort-Object FullName -Unique)
}

function Run-ProjectGenerator {
  Say "generating Source SDK Visual Studio projects"
  $generators = @(
    (Join-Path $Src "createallprojects.bat"),
    (Join-Path $Src "creategameprojects.bat"),
    (Join-Path $Src "createprojects.bat")
  )

  $ran = $false
  foreach ($gen in $generators) {
    if (Test-Path $gen) {
      Say "running $gen"
      & cmd /c "`"$gen`"" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "project-generation.log")
      $ran = $true
      break
    }
  }

  if (-not $ran) {
    $vpc = Join-Path $Src "devtools/bin/vpc.exe"
    if (Test-Path $vpc) {
      Say "running vpc.exe fallback"
      & $vpc /hl2mp /define:SOURCESDK +game /mksln OpenVibe_HL2MP.sln 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "vpc.log")
      $ran = $true
    }
  }

  if (-not $ran) {
    throw "No Source SDK project generator found."
  }
}

function Get-ProjectConfigs([string]$projPath) {
  $text = Get-Content -Raw $projPath
  $matches = [regex]::Matches($text, '<ProjectConfiguration\s+Include="([^|"]+)\|([^"]+)"')
  $pairs = @()
  foreach ($m in $matches) {
    $pairs += [pscustomobject]@{ Configuration = $m.Groups[1].Value; Platform = $m.Groups[2].Value }
  }
  return @($pairs | Sort-Object Configuration,Platform -Unique)
}

function Sort-PreferredConfigs($pairs, [string]$projName) {
  $preferred = @()
  foreach ($cfg in @("Release", "Release_HL2MP", "Release HL2MP", "Debug")) {
    $platformPreference = if ($script:OpenVibeTargetArch -eq "x86") { @("Win32", "x86", "x64", "Win64") } else { @("x64", "Win64", "Win32", "x86") }
    foreach ($plat in $platformPreference) {
      $hit = $pairs | Where-Object { $_.Configuration -eq $cfg -and $_.Platform -eq $plat }
      if ($hit) { $preferred += $hit }
    }
  }
  # Add anything else not covered.
  foreach ($p in $pairs) {
    if (-not ($preferred | Where-Object { $_.Configuration -eq $p.Configuration -and $_.Platform -eq $p.Platform })) {
      $preferred += $p
    }
  }
  return @($preferred)
}




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

    # OPENVIBE_WIN32_REWRITE_64BIT_IMPORT_LIB_NAMES
    # VPC can keep 64-bit import-library names even after platform conversion.
    # Source SDK Base 2013's Proton hl2.exe is 32-bit, so the converted Win32
    # project must link the normal x86 import names.
    $text = $text -replace '(?i)steam_api64\.lib', 'steam_api.lib'
    $text = $text -replace '(?i)tier0_64\.lib', 'tier0.lib'
    $text = $text -replace '(?i)vstdlib_64\.lib', 'vstdlib.lib'

    # OPENVIBE_WIN32_STEAM_API64_TO_STEAM_API_PATCH
    # VPC-generated win64 projects keep steam_api64.lib in AdditionalDependencies.
    # When coercing the project to Win32, force the x86 import/static-lib name.
    $text = $text -replace '(?i)steam_api64\.lib', 'steam_api.lib'
    $text = $text -replace '(?i)\\lib\\public\\x64\\steam_api\.lib', '\lib\public\steam_api.lib'
    $text = $text -replace '(?i)/lib/public/x64/steam_api\.lib', '/lib/public/steam_api.lib'


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


function Invoke-MSBuildProject([System.IO.FileInfo]$proj, [string]$label) {
  Say "building $label project=$($proj.FullName)"
  $pairs = Get-ProjectConfigs $proj.FullName
  if ($pairs.Count -eq 0) {
    $pairs = @([pscustomobject]@{ Configuration = "Release"; Platform = if ($script:OpenVibeTargetArch -eq "x86") { "Win32" } else { "x64" } })
  }
  $pairs = Sort-PreferredConfigs $pairs $proj.Name

  foreach ($p in $pairs) {
    $cfgSafe = ($p.Configuration -replace '[^A-Za-z0-9]+','_')
    $platSafe = ($p.Platform -replace '[^A-Za-z0-9]+','_')
    $log = Join-Path $LogDir "msbuild-$label-$cfgSafe-$platSafe.log"
    Say "msbuild $label cfg=$($p.Configuration) platform=$($p.Platform)"
    $extraProps = @()
    if ($script:OpenVibeTargetArch -eq "x86") {
      $extraProps += "/p:TreatWarningsAsErrors=false"
      $extraProps += "/p:PlatformTarget=x86"
    }
    & msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" @extraProps /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log | Out-Host
    if ($LASTEXITCODE -eq 0) {
      Say "built $label with cfg=$($p.Configuration) platform=$($p.Platform)"
      return $true
    }
  }

  return $false
}


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
    Sort-Object @{ Expression = {
      if ($script:OpenVibeTargetArch -eq "x86") {
        if ($_.FullName -match "\x64\|/x64/|win64|x64") { 1 } else { 0 }
      } else {
        if ($_.FullName -match "\x64\|/x64/|win64|x64") { 0 } else { 1 }
      }
    } }, LastWriteTime -Descending |
    Select-Object -First 1
  if ($found) {
    Say "copying fallback lib $($found.FullName) -> $dest"
    Copy-Item $found.FullName $dest -Force
  }
}


# OPENVIBE_WIN32_STEAM_API_COMPAT_LIBS
function New-OpenVibeEmptyStaticLib([string]$OutLib, [string]$SymbolName) {
  $work = Join-Path $LogDir "win32-empty-static-libs"
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  $src = Join-Path $work "$SymbolName.c"
  $obj = Join-Path $work "$SymbolName.obj"
  "void $SymbolName(void) {}" | Set-Content -Encoding ascii -Path $src

  Say "creating empty x86 compatibility lib $OutLib"
  & cl.exe /nologo /c /TC $src /Fo$obj 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "cl-$SymbolName.log") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "cl.exe failed while creating $OutLib" }

  & lib.exe /nologo /machine:x86 /out:$OutLib $obj 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "lib-$SymbolName.log") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "lib.exe failed while creating $OutLib" }
}

function Ensure-Win32SteamApiCompatibilityLibs {
  if ($script:OpenVibeTargetArch -ne "x86") { return }

  $publicLibDir = Join-Path $Src "lib/public"
  New-Item -ItemType Directory -Force -Path $publicLibDir | Out-Null
  $log = Join-Path $LogDir "win32-steam-api-compat.txt"
  "=== Ensure-Win32SteamApiCompatibilityLibs ===" | Out-File $log
  "publicLibDir=$publicLibDir" | Out-File $log -Append

  foreach ($libName in @("steam_api.lib", "steam_api64.lib")) {
    $dest = Join-Path $publicLibDir $libName
    if (Test-Path $dest) {
      $item = Get-Item $dest
      "[present] $libName length=$($item.Length)" | Out-File $log -Append
      continue
    }

    # Prefer a real x86 lib if Valve's tree/bootstrap provided one somewhere.
    $found = Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps|openvibe\.games" } |
      Sort-Object @{ Expression = { if ($_.FullName -match "\\x64\\|/x64/|\\win64\\|/win64/|64") { 100 } else { 0 } } }, LastWriteTime -Descending |
      Select-Object -First 1

    if ($found) {
      Say "copying Steam API lib $($found.FullName) -> $dest"
      Copy-Item $found.FullName $dest -Force
      "[copied] $libName <- $($found.FullName)" | Out-File $log -Append
      continue
    }

    # The current converted HL2MP client link only needs the archive file to exist;
    # if actual SteamAPI imports appear later, the next linker error will be unresolved
    # externals instead of missing input file. This keeps the build moving and logs it.
    $symbol = ($libName -replace '[^A-Za-z0-9]+','_') + "_openvibe_stub"
    New-OpenVibeEmptyStaticLib $dest $symbol
    if (!(Test-Path $dest)) { throw "Expected compatibility lib was not created: $dest" }
    $item = Get-Item $dest
    "[stubbed] $libName length=$($item.Length)" | Out-File $log -Append
  }
}

# OPENVIBE_WIN32_BITMAP_LIB_DEP_PATCH
function Build-SourceSdkDependencyProjects {
  Say "building Source SDK dependency libraries before HL2MP client/server"

  # OPENVIBE_WIN32_PUBLIC_CLIENT_LIB_DEPS
  $patterns = @(
    "tier1*.vcxproj",
    "mathlib*.vcxproj",
    "bitmap*.vcxproj",
    "choreoobjects*.vcxproj",
    "tier2*.vcxproj",
    "dmxloader*.vcxproj",
    "dmserializers*.vcxproj",
    "datamodel*.vcxproj",
    "particles*.vcxproj",
    "appframework*.vcxproj",
    "vgui_surfacelib*.vcxproj",
    "raytrace*.vcxproj",
    "vgui_controls*.vcxproj",
    "matsys_controls*.vcxproj",
    "fgdlib*.vcxproj"
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

  $publicLibDir = if ($script:OpenVibeTargetArch -eq "x86") { Join-Path $Src "lib/public" } else { Join-Path $Src "lib/public/x64" }
  Copy-LibIfNeeded "mathlib.lib" $publicLibDir
  # OPENVIBE_WIN32_COPY_PUBLIC_CLIENT_LIBS
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
  }
  Copy-LibIfNeeded "tier1.lib" $publicLibDir
  Copy-LibIfNeeded "raytrace.lib" $publicLibDir
  Copy-LibIfNeeded "vgui_controls.lib" $publicLibDir
  Copy-LibIfNeeded "matsys_controls.lib" $publicLibDir

  "=== public libs after deps ($script:OpenVibeTargetArch) ===" | Out-File (Join-Path $LogDir "public-libs-after-deps.txt")
  if (Test-Path $publicLibDir) {
    Get-ChildItem -Path $publicLibDir -File -ErrorAction SilentlyContinue |
      Select-Object FullName,Length,LastWriteTime |
      Format-List | Out-File (Join-Path $LogDir "public-libs-after-deps.txt") -Append
  }
}

# OPENVIBE_RESOLVE_WIN32_PUBLIC_LIB_DEPS
# Dynamically resolves all .lib references in the client/server vcxproj AdditionalDependencies
# and ensures every non-system lib is present in $PublicLibDir before the final link.
# This eliminates the one-at-a-time "missing lib" pattern: instead of hardcoding a list,
# we read what the linker will actually ask for and proactively satisfy every dependency.
function Resolve-OpenVibeWin32PublicLibDependencies {
  param(
    [System.IO.FileInfo[]]$Projects,
    [string]$PublicLibDir
  )

  $log = Join-Path $LogDir "resolve-win32-public-lib-deps.txt"
  "=== Resolve-OpenVibeWin32PublicLibDependencies ===" | Out-File $log
  "publicLibDir=$PublicLibDir" | Out-File $log -Append
  "targetArch=$script:OpenVibeTargetArch" | Out-File $log -Append
  "projects:" | Out-File $log -Append
  $Projects | ForEach-Object { "  $($_.FullName)" | Out-File $log -Append }

  # Windows/CRT system libs that we never build or copy from the SDK.
  $systemLibs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($lib in @(
    'kernel32.lib','user32.lib','gdi32.lib','winspool.lib','comdlg32.lib',
    'advapi32.lib','shell32.lib','ole32.lib','oleaut32.lib','uuid.lib',
    'odbc32.lib','odbccp32.lib','winmm.lib','ws2_32.lib','dbghelp.lib',
    'psapi.lib','comctl32.lib','shlwapi.lib','imm32.lib','version.lib',
    'Rpcrt4.lib','opengl32.lib','legacy_stdio_definitions.lib',
    'libcmt.lib','libcmtd.lib','msvcrt.lib','msvcrtd.lib',
    'libcpmt.lib','libcpmtd.lib','libc.lib','msvcprt.lib','msvcprtd.lib',
    'setupapi.lib','dxguid.lib','dinput8.lib','d3d9.lib','d3dx9.lib',
    'Strmiids.lib','delayimp.lib','ntdll.lib','wldap32.lib','crypt32.lib'
  )) { [void]$systemLibs.Add($lib) }

  # Collect every .lib name mentioned in <AdditionalDependencies> across all
  # configurations in all provided project files.
  $neededLibs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($proj in $Projects) {
    $text = Get-Content -Raw $proj.FullName
    $rxDeps = [regex]::Matches($text, '<AdditionalDependencies>([^<]+)</AdditionalDependencies>')
    foreach ($m in $rxDeps) {
      foreach ($tok in ($m.Groups[1].Value -split ';')) {
        $tok = $tok.Trim()
        # Skip MSBuild variables, empty tokens, non-.lib entries
        if ($tok -eq '' -or $tok -notmatch '\.lib$' -or $tok -match '^\$\(') { continue }
        # Normalise to bare filename (handles paths like ..\..\lib\public\foo.lib)
        $leaf = [System.IO.Path]::GetFileName($tok.TrimStart('\', '/', '.'))
        if ($leaf -and -not $systemLibs.Contains($leaf)) {
          [void]$neededLibs.Add($leaf)
        }
      }
    }
  }

  "needed libs ($($neededLibs.Count)):" | Out-File $log -Append
  $neededLibs | Sort-Object | ForEach-Object { "  $_" | Out-File $log -Append }
  Say "Resolve-OpenVibeWin32PublicLibDependencies: $($neededLibs.Count) SDK lib(s) referenced"

  New-Item -ItemType Directory -Force -Path $PublicLibDir | Out-Null

  # Find the best arch-matching copy of a lib anywhere in the SDK tree.
  function Find-LibInSdkTree([string]$libName) {
    return Get-ChildItem -Path $Sdk -Recurse -File -Filter $libName -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch "artifacts|windows-build-debug|_deps|openvibe\.games" } |
      Sort-Object @{
        Expression = {
          # For x86 target: deprioritise x64 paths so we never copy a 64-bit .lib
          if ($script:OpenVibeTargetArch -eq "x86") {
            if ($_.FullName -match '\\x64\\|/x64/|\\win64\\|/win64/') { 100 } else { 0 }
          } else {
            if ($_.FullName -match '\\x64\\|/x64/|\\win64\\|/win64/') { 0 } else { 100 }
          }
        }
      }, @{ Expression = { $_.LastWriteTime }; Descending = $true } |
      Select-Object -First 1
  }

  $builtProjects = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $stillMissing = [System.Collections.Generic.List[string]]::new()

  foreach ($libName in ($neededLibs | Sort-Object)) {
    $dest = Join-Path $PublicLibDir $libName
    if (Test-Path $dest) {
      "[present] $libName" | Out-File $log -Append
      continue
    }

    # Pass 1: look for the lib in the SDK tree (may have been built by Build-SourceSdkDependencyProjects
    # or pre-shipped in the SDK).
    $found = Find-LibInSdkTree $libName
    if ($found) {
      Say "copying $libName <- $($found.FullName)"
      Copy-Item $found.FullName $dest -Force
      "[copied] $libName <- $($found.FullName)" | Out-File $log -Append
      continue
    }

    # Pass 2: try to find and build the vcxproj whose base name matches the lib.
    $libBase = [System.IO.Path]::GetFileNameWithoutExtension($libName)
    $depProjs = @(Find-ProjectByPattern "$libBase*.vcxproj" |
      Where-Object { $_.FullName -notmatch "hl2mp|game[/\\]client|game[/\\]server|openvibe_client|openvibe_server" } |
      Where-Object { -not $builtProjects.Contains($_.FullName) })

    if ($depProjs.Count -gt 0) {
      $depProj = $depProjs[0]
      Say "building $($depProj.Name) to provide $libName"
      [void]$builtProjects.Add($depProj.FullName)
      [void](Invoke-MSBuildProject $depProj "dep-$libBase")

      # Search again after the build.
      $found = Find-LibInSdkTree $libName
      if ($found) {
        Say "copying built $libName <- $($found.FullName)"
        Copy-Item $found.FullName $dest -Force
        "[built+copied] $libName <- $($found.FullName)" | Out-File $log -Append
        continue
      }
      "[warn-after-build] $libName not found after building $($depProj.Name)" | Out-File $log -Append
      Say "WARNING: $libName not found after building $($depProj.Name)"
    } else {
      "[no-vcxproj] $libName - no matching project; may be pre-built or external" | Out-File $log -Append
    }

    [void]$stillMissing.Add($libName)
  }

  if ($stillMissing.Count -gt 0) {
    "=== unresolved libs ===" | Out-File $log -Append
    $stillMissing | ForEach-Object { "  [MISSING] $_" | Out-File $log -Append }
    Say "WARNING: $($stillMissing.Count) lib(s) could not be resolved: $($stillMissing -join ', ')"
    Say "The linker will report LNK1104 for these. Check resolve-win32-public-lib-deps.txt."
  } else {
    Say "all referenced SDK libs are present in $PublicLibDir"
  }

  "=== public lib dir after resolve ===" | Out-File $log -Append
  Get-ChildItem -Path $PublicLibDir -File -ErrorAction SilentlyContinue |
    Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize | Out-File $log -Append
}


# OPENVIBE_WIN32_LIBZ_STUB_FOR_PROTON
function Ensure-OpenVibeWin32LibZStub {
  param([string]$PublicLibDir)

  if ($script:OpenVibeTargetArch -ne "x86") { return }

  $log = Join-Path $LogDir "win32-libz-stub.txt"
  "=== Ensure-OpenVibeWin32LibZStub ===" | Out-File $log
  "publicLibDir=$PublicLibDir" | Out-File $log -Append

  New-Item -ItemType Directory -Force -Path $PublicLibDir | Out-Null
  $dest = Join-Path $PublicLibDir "libz.lib"
  if (Test-Path $dest) {
    "present=$dest" | Out-File $log -Append
    Say "libz.lib already present: $dest"
    return
  }

  # VPC's HL2MP Windows client project references ..\..\lib\public\libz.lib for Win32,
  # but Valve's public GitHub SDK checkout does not ship/build that x86 library. The current
  # OpenVibe HL2MP client path does not use zlib symbols; the missing input file alone breaks
  # the link. Provide a tiny inert COFF library so link.exe can continue. If future code starts
  # requiring real zlib symbols, the link will fail with unresolved externals and this stub must
  # be replaced with a real zlib build.
  $stubDir = Join-Path $LogDir "libz-stub"
  New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
  $stubC = Join-Path $stubDir "openvibe_libz_stub.c"
  $stubObj = Join-Path $stubDir "openvibe_libz_stub.obj"
  Set-Content -Encoding ascii -Path $stubC -Value "int openvibe_libz_placeholder_symbol = 0;`r`n"

  Say "creating Win32 placeholder libz.lib for Source SDK public lib dir"
  & cl.exe /nologo /c /TC /Fo$stubObj $stubC 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
  if ($LASTEXITCODE -ne 0 -or !(Test-Path $stubObj)) { throw "Failed to compile libz stub object. Check win32-libz-stub.txt." }

  & lib.exe /nologo /machine:X86 /out:$dest $stubObj 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
  if ($LASTEXITCODE -ne 0 -or !(Test-Path $dest)) { throw "Failed to create placeholder libz.lib. Check win32-libz-stub.txt." }

  $item = Get-Item $dest
  "created=$dest length=$($item.Length)" | Out-File $log -Append
  Say "created $dest"
}


# OPENVIBE_WIN32_IMPORT_COMPAT_LIB_STUBS
function Ensure-OpenVibeWin32ImportCompatibilityLibs {
  if ($script:OpenVibeTargetArch -ne "x86") { return }

  $publicLibDir = Join-Path $Src "lib/public"
  New-Item -ItemType Directory -Force -Path $publicLibDir | Out-Null

  $log = Join-Path $LogDir "win32-import-compat-libs.txt"
  "=== Ensure-OpenVibeWin32ImportCompatibilityLibs ===" | Out-File $log
  "publicLibDir=$publicLibDir" | Out-File $log -Append

  $libCmd = Get-Command lib.exe -ErrorAction SilentlyContinue
  if (-not $libCmd) { $libCmd = Get-Command lib -ErrorAction SilentlyContinue }
  if (-not $libCmd) { throw "lib.exe not found in MSVC dev shell; cannot create Win32 compatibility libraries" }

  $clCmd = Get-Command cl.exe -ErrorAction SilentlyContinue
  if (-not $clCmd) { $clCmd = Get-Command cl -ErrorAction SilentlyContinue }
  if (-not $clCmd) { throw "cl.exe not found in MSVC dev shell; cannot create Win32 compatibility libraries" }

  # These are VPC/linker inputs for the game DLLs. Modern public Valve SDK
  # checkouts do not always include their 32-bit import libs, but the generated
  # Win32 project still expects the filenames to exist. Create tiny x86 archives
  # only when the correct file is absent so the linker can continue to the real
  # object/link validation step.
  #
  # tier0/vstdlib/steam_api are pervasively called by real Source engine code
  # (Msg, Warning, g_pMemAlloc, SteamAPI_*, ...). A single-dummy-symbol static
  # archive satisfies the linker's "file exists" check but leaves every real
  # call unresolved (LNK2001). Instead build genuine DEF-based *import*
  # libraries: the resulting .lib has no code of its own, just import thunks
  # that redirect to the real tier0.dll/vstdlib.dll/steam_api.dll the target
  # machine already has installed (any Source SDK 2013 game ships these next
  # to hl2.exe/hl2_win64.exe). tier3/vtf/libz have no observed real symbol
  # usage from this client, so a trivial placeholder archive is enough for
  # those - only file presence is required, not import thunks.
  $defBackedLibs = @{
    "tier0.lib" = @{
      Dll = "tier0"
      Exports = @(
        "CallAssertFailedNotifyFunc","CommandLine_Tier0","COM_TimestampedLog",
        "CreateSimpleThread","DestroyThreadPool","DevMsg","DevWarning",
        "DoNewAssertDialog","Error","ETWBegin","ETWEnd","_ExitOnFatalAssert",
        "g_ClockSpeed","GetCPUFrequencyResults","GetCPUInformation",
        "GetMemoryInformation","GetThreadedLoadLibraryFunc","g_pMemAlloc",
        "g_pThreadPool","g_VProfCurrentProfile","HushAsserts",
        "MemAllocScratch","MemFreeScratch","Msg","Plat_ExitProcess",
        "Plat_FloatTime","Plat_IsInDebugSession","Plat_localtime",
        "Plat_MSTime","ReleaseThreadHandle","ShouldUseNewAssertDialog",
        "_SpewInfo","_SpewMessage","ThreadInMainThread",
        "ThreadInterlockedAssignIf64","ThreadInterlockedDecrement64",
        "ThreadInterlockedExchange64","ThreadInterlockedIncrement64",
        "ThreadSetAffinity","ThreadWaitForObjects","Warning","WriteMiniDump"
      )
    }
    "vstdlib.lib" = @{
      Dll = "vstdlib"
      Exports = @("KeyValuesSystem","RandomFloat","RandomInt","RandomSeed")
    }
    "steam_api.lib" = @{
      Dll = "steam_api"
      Exports = @(
        "SteamAPI_GetHSteamPipe","SteamAPI_GetHSteamUser","SteamAPI_InitSafe",
        "SteamAPI_RegisterCallback","SteamAPI_RegisterCallResult",
        "SteamAPI_SetTryCatchCallbacks","SteamAPI_UnregisterCallback",
        "SteamAPI_UnregisterCallResult","SteamInternal_ContextInit",
        "SteamInternal_CreateInterface","SteamInternal_FindOrCreateUserInterface"
      )
    }
  }

  $placeholderLibs = @("libz.lib", "vtf.lib")

  foreach ($libName in $defBackedLibs.Keys) {
    $dest = Join-Path $publicLibDir $libName
    # Unlike the placeholder libs below, always (re)generate these: an earlier
    # pipeline stage (dependency-project builds, the dynamic resolver) can
    # drop in a single-dummy-symbol stub at this same path before this
    # function runs, and that stale stub silently wins if we only create
    # on-absence. These three need the real DEF-based export table every
    # time, so overwrite unconditionally.
    if (Test-Path $dest) {
      Remove-Item -Force $dest
    }

    $info = $defBackedLibs[$libName]
    $safe = ($libName -replace '[^A-Za-z0-9]+','_')
    $defPath = Join-Path $LogDir "openvibe_${safe}_compat.def"
    $defLines = @("LIBRARY $($info.Dll)", "EXPORTS") + $info.Exports
    Set-Content -Encoding ascii -Path $defPath -Value $defLines

    Say "creating Win32 import-compatibility library $dest (DLL=$($info.Dll), $($info.Exports.Count) exports)"
    & $libCmd.Source /nologo /machine:x86 "/def:$defPath" "/out:$dest" 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "lib.exe failed while creating $libName import-compatibility library" }

    if (!(Test-Path $dest)) { throw "Expected compatibility library was not created: $dest" }
    $item = Get-Item $dest
    "[created-def] $libName $($item.Length)" | Out-File $log -Append
  }

  # tier3.lib is not a DLL import lib like tier0/vstdlib/steam_api - public/tier3/tier3.h
  # forward-declares its own interface types and just `extern`s a handful of global
  # interface pointers ("These tier3 libraries must be set by any users of this
  # library... by calling ConnectTier3Libraries"). Real Source SDK builds provide
  # these via a real tier3.lib static archive; the public checkout doesn't ship one.
  # Compile a real (if inert, null-initialized) definition of each declared global
  # against the actual header so the mangled C++ names match exactly, and archive
  # that - not a DEF-based import lib, since these are static data, not DLL imports.
  $tier3Dest = Join-Path $publicLibDir "tier3.lib"
  if (Test-Path $tier3Dest) { Remove-Item -Force $tier3Dest }
  $tier3Src = Join-Path $LogDir "openvibe_tier3_globals.cpp"
  $tier3Obj = Join-Path $LogDir "openvibe_tier3_globals.obj"
  @'
#include "tier3/tier3.h"
IStudioRender *g_pStudioRender = 0;
IStudioRender *studiorender = 0;
IMatSystemSurface *g_pMatSystemSurface = 0;
vgui::ISurface *g_pVGuiSurface = 0;
vgui::IInput *g_pVGuiInput = 0;
vgui::IVGui *g_pVGui = 0;
vgui::IPanel *g_pVGuiPanel = 0;
vgui::ILocalize *g_pVGuiLocalize = 0;
vgui::ISchemeManager *g_pVGuiSchemeManager = 0;
vgui::ISystem *g_pVGuiSystem = 0;
IDataCache *g_pDataCache = 0;
IMDLCache *g_pMDLCache = 0;
IMDLCache *mdlcache = 0;
IVideoServices *g_pVideo = 0;
IDmeMakefileUtils *g_pDmeMakefileUtils = 0;
IPhysicsCollision *g_pPhysicsCollision = 0;
ISoundEmitterSystemBase *g_pSoundEmitterSystem = 0;
IVTex *g_pVTex = 0;
'@ | Set-Content -Encoding ascii -Path $tier3Src

  $publicInclude = Join-Path $Src "public"
  Say "creating Win32 tier3.lib from real tier3.h globals ($tier3Dest)"
  & $clCmd.Source /nologo /c /TP "/I$publicInclude" $tier3Src /Fo$tier3Obj 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "cl.exe failed while compiling tier3.lib globals" }

  & $libCmd.Source /nologo /machine:x86 "/out:$tier3Dest" $tier3Obj 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "lib.exe failed while creating tier3.lib" }

  if (!(Test-Path $tier3Dest)) { throw "Expected tier3.lib was not created: $tier3Dest" }
  $item = Get-Item $tier3Dest
  "[created-globals] tier3.lib $($item.Length)" | Out-File $log -Append

  foreach ($libName in $placeholderLibs) {
    $dest = Join-Path $publicLibDir $libName
    if (Test-Path $dest) {
      $item = Get-Item $dest
      "[present] $libName $($item.Length)" | Out-File $log -Append
      continue
    }

    $safe = ($libName -replace '[^A-Za-z0-9]+','_')
    $src = Join-Path $LogDir "openvibe_${safe}_compat_stub.c"
    $obj = Join-Path $LogDir "openvibe_${safe}_compat_stub.obj"
    "void openvibe_${safe}_compat_stub(void) {}" | Set-Content -Encoding ascii -Path $src

    Say "creating Win32 compatibility library $dest"
    & $clCmd.Source /nologo /c $src /Fo$obj 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "cl.exe failed while creating $libName compatibility object" }

    & $libCmd.Source /nologo /machine:x86 /out:$dest $obj 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "lib.exe failed while creating $libName compatibility library" }

    if (!(Test-Path $dest)) { throw "Expected compatibility library was not created: $dest" }
    $item = Get-Item $dest
    "[created] $libName $($item.Length)" | Out-File $log -Append
  }
}


# OPENVIBE_WIN32_GENERATE_ALL_MISSING_PLACEHOLDER_LIBS
# Last-resort compatibility layer for Proton Win32 DLL builds.
# VPC on current Windows runners can emit HL2MP projects that reference old SDK import/static
# libraries that are not shipped in ValveSoftware/source-sdk-2013's Win32 public lib folder.
# We first build/copy real libs. For remaining missing .lib inputs, create tiny x86 archives so
# the linker can continue. If the DLL actually uses a missing symbol, the link will still fail
# later with an unresolved external, which is more useful than one-at-a-time LNK1181 missing-file
# failures.
function Get-OpenVibeAdditionalDependencyLibNames {
  param([System.IO.FileInfo[]]$Projects)

  $systemLibs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($lib in @(
    'kernel32.lib','user32.lib','gdi32.lib','winspool.lib','comdlg32.lib',
    'advapi32.lib','shell32.lib','ole32.lib','oleaut32.lib','uuid.lib',
    'odbc32.lib','odbccp32.lib','winmm.lib','ws2_32.lib','dbghelp.lib',
    'psapi.lib','comctl32.lib','shlwapi.lib','imm32.lib','version.lib',
    'Rpcrt4.lib','opengl32.lib','legacy_stdio_definitions.lib',
    'libcmt.lib','libcmtd.lib','msvcrt.lib','msvcrtd.lib',
    'libcpmt.lib','libcpmtd.lib','libc.lib','msvcprt.lib','msvcprtd.lib',
    'setupapi.lib','dxguid.lib','dinput8.lib','d3d9.lib','d3dx9.lib',
    'Strmiids.lib','delayimp.lib','ntdll.lib','wldap32.lib','crypt32.lib'
  )) { [void]$systemLibs.Add($lib) }

  $libs = [System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($proj in $Projects) {
    if (-not $proj -or !(Test-Path $proj.FullName)) { continue }
    $text = Get-Content -Raw $proj.FullName
    $matches = [regex]::Matches($text, '<AdditionalDependencies>(.*?)</AdditionalDependencies>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    foreach ($m in $matches) {
      foreach ($tokRaw in ($m.Groups[1].Value -split ';')) {
        $tok = ([string]$tokRaw).Trim()
        if ($tok -eq '' -or $tok -match '^%\(' -or $tok -match '^\$\(') { continue }
        $lm = [regex]::Match($tok, '([^\\/;<>]+\.lib)\s*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $lm.Success) { continue }
        $leaf = $lm.Groups[1].Value
        if ($leaf -and -not $systemLibs.Contains($leaf)) { [void]$libs.Add($leaf) }
      }
    }
  }
  return @($libs)
}

function New-OpenVibeX86PlaceholderLib {
  param(
    [string]$LibName,
    [string]$DestPath,
    [string]$StubDir,
    [string]$LogPath
  )

  New-Item -ItemType Directory -Force -Path $StubDir | Out-Null
  $base = [System.IO.Path]::GetFileNameWithoutExtension($LibName)
  $safe = ($base -replace '[^A-Za-z0-9_]+','_')
  if (-not $safe) { $safe = 'lib' }
  $c = Join-Path $StubDir "$safe.c"
  $obj = Join-Path $StubDir "$safe.obj"
  $symbol = "openvibe_placeholder_${safe}"

  "void $symbol(void) {}" | Set-Content -Encoding ascii -Path $c
  "[placeholder] creating $LibName at $DestPath" | Out-File $LogPath -Append
  & cl.exe /nologo /TC /c $c "/Fo$obj" 2>&1 | Tee-Object -FilePath $LogPath -Append | Out-Host
  if ($LASTEXITCODE -ne 0 -or !(Test-Path $obj)) {
    throw "cl.exe failed while creating placeholder object for $LibName. Check win32-placeholder-libs.txt."
  }

  & lib.exe /nologo /machine:X86 "/out:$DestPath" $obj 2>&1 | Tee-Object -FilePath $LogPath -Append | Out-Host
  if ($LASTEXITCODE -ne 0 -or !(Test-Path $DestPath)) {
    throw "lib.exe failed while creating placeholder library $DestPath. Check win32-placeholder-libs.txt."
  }
}

function Ensure-OpenVibeWin32PlaceholderLibsForRemainingDeps {
  param(
    [System.IO.FileInfo[]]$Projects,
    [string]$PublicLibDir
  )

  if ($script:OpenVibeTargetArch -ne 'x86') { return }

  $log = Join-Path $LogDir 'win32-placeholder-libs.txt'
  "=== Ensure-OpenVibeWin32PlaceholderLibsForRemainingDeps ===" | Out-File $log
  "publicLibDir=$PublicLibDir" | Out-File $log -Append
  "targetArch=$script:OpenVibeTargetArch" | Out-File $log -Append

  New-Item -ItemType Directory -Force -Path $PublicLibDir | Out-Null
  $stubDir = Join-Path $LogDir 'win32-placeholder-lib-objs'
  $libs = @(Get-OpenVibeAdditionalDependencyLibNames -Projects $Projects)

  "referenced non-system libs ($($libs.Count)):" | Out-File $log -Append
  $libs | ForEach-Object { "  $_" | Out-File $log -Append }

  $created = New-Object System.Collections.Generic.List[string]
  foreach ($lib in $libs) {
    # Previous conversion should have rewritten steam_api64.lib to steam_api.lib, but guard anyway.
    if ($lib -ieq 'steam_api64.lib') { $lib = 'steam_api.lib' }
    $dest = Join-Path $PublicLibDir $lib
    if (Test-Path $dest) {
      $item = Get-Item $dest
      "[present] $lib length=$($item.Length)" | Out-File $log -Append
      continue
    }

    New-OpenVibeX86PlaceholderLib -LibName $lib -DestPath $dest -StubDir $stubDir -LogPath $log
    [void]$created.Add($lib)
  }

  if ($created.Count -gt 0) {
    Say "created x86 placeholder lib(s): $($created -join ', ')"
  } else {
    Say "no Win32 placeholder libs were needed"
  }
}


# Generate projects if no relevant vcxproj files exist yet.
$clientProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*client*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
$serverProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*server*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
$solutions = Normalize-Solutions

if ($clientProjects.Count -eq 0 -or $serverProjects.Count -eq 0) {
  Run-ProjectGenerator
  $solutions = Normalize-Solutions
  $clientProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*client*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
  $serverProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*server*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
}


if ($script:OpenVibeTargetArch -eq "x86") {
  Convert-GeneratedVcxprojsToWin32
  $clientProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*client*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
  $serverProjects = @(Get-ChildItem -Path $Src -Recurse -File -Filter "*server*hl2mp*.vcxproj" -ErrorAction SilentlyContinue)
}

"=== normalized solutions ===" | Out-File (Join-Path $LogDir "normalized-solutions.txt")
$solutions | Select-Object FullName,Length,LastWriteTime | Format-List | Out-File (Join-Path $LogDir "normalized-solutions.txt") -Append
"=== hl2mp projects ===" | Out-File (Join-Path $LogDir "hl2mp-projects.txt")
@($clientProjects + $serverProjects) | Select-Object FullName,Length,LastWriteTime | Format-List | Out-File (Join-Path $LogDir "hl2mp-projects.txt") -Append

if ($clientProjects.Count -eq 0) {
  Get-ChildItem -Path $Src -Recurse -File -Include "*.vcxproj","*.sln","everything*" -ErrorAction SilentlyContinue |
    Select-Object FullName,Length,LastWriteTime |
    Format-List | Out-File (Join-Path $LogDir "project-search-after-generator.txt")
  throw "No HL2MP client vcxproj was generated. Check openvibe-windows-build-debug artifact."
}
if ($serverProjects.Count -eq 0) {
  Get-ChildItem -Path $Src -Recurse -File -Include "*.vcxproj","*.sln","everything*" -ErrorAction SilentlyContinue |
    Select-Object FullName,Length,LastWriteTime |
    Format-List | Out-File (Join-Path $LogDir "project-search-after-generator.txt")
  throw "No HL2MP server vcxproj was generated. Check openvibe-windows-build-debug artifact."
}

# Prefer the actual HL2MP game projects and the requested target architecture.
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

Patch-GeneratedPythonCustomBuildCommands

Ensure-ServerNutHeaders

# OPENVIBE_WIN32_STEAM_API_COMPAT_CALL
Ensure-Win32SteamApiCompatibilityLibs
Build-SourceSdkDependencyProjects

# After the static dependency build pass, run the dynamic resolver so that every
# .lib referenced in the client/server vcxproj AdditionalDependencies is present
# in lib/public before the final link step. This prevents one-at-a-time LNK1104
# failures when VPC generates projects that reference libs not in the static list.
# OPENVIBE_RESOLVE_WIN32_PUBLIC_LIB_DEPS_CALL
$resolvePublicLibDir = if ($script:OpenVibeTargetArch -eq "x86") { Join-Path $Src "lib/public" } else { Join-Path $Src "lib/public/x64" }
Resolve-OpenVibeWin32PublicLibDependencies -Projects @($clientProject, $serverProject) -PublicLibDir $resolvePublicLibDir
# OPENVIBE_WIN32_GENERATE_ALL_MISSING_PLACEHOLDER_LIBS_CALL
Ensure-OpenVibeWin32PlaceholderLibsForRemainingDeps -Projects @($clientProject, $serverProject) -PublicLibDir $resolvePublicLibDir


# OPENVIBE_WIN32_IMPORT_COMPAT_LIB_STUBS_CALL
Ensure-OpenVibeWin32ImportCompatibilityLibs
Ensure-OpenVibeWin32LibZStub -PublicLibDir $resolvePublicLibDir

# OPENVIBE_WIN32_PRE_CLIENT_LINK_LIB_AUDIT
$publicLibDirAudit = if ($script:OpenVibeTargetArch -eq "x86") { Join-Path $Src "lib/public" } else { Join-Path $Src "lib/public/x64" }
"=== public lib dir before client link ===" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt")
"target arch=$script:OpenVibeTargetArch" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
"dir=$publicLibDirAudit" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
# Spot-check known required libs
foreach ($lib in @("bitmap.lib","choreoobjects.lib","tier1.lib","tier2.lib","mathlib.lib","raytrace.lib","dmxloader.lib","dmserializers.lib","datamodel.lib","particles.lib","appframework.lib","vgui_controls.lib","vgui_surfacelib.lib","matsys_controls.lib","libz.lib")) {
  $lp = Join-Path $publicLibDirAudit $lib
  if (Test-Path $lp) {
    $item = Get-Item $lp
    "[ok] $lib $($item.Length) $($item.LastWriteTime)" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
  } else {
    "[miss] $lib" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
  }
}
# Full directory listing - all .lib files present (resolver output feeds into this)
"=== all libs in public dir ===" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
if (Test-Path $publicLibDirAudit) {
  Get-ChildItem -Path $publicLibDirAudit -File -Filter "*.lib" -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
} else {
  "[dir missing] $publicLibDirAudit" | Out-File (Join-Path $LogDir "public-libs-before-client-link.txt") -Append
}

$beforeBuild = Get-Date

if (-not (Invoke-MSBuildProject $clientProject "client")) {
  throw "MSBuild failed all configurations for $($clientProject.FullName). Check msbuild-client-*.log."
}
if (-not (Invoke-MSBuildProject $serverProject "server")) {
  throw "MSBuild failed all configurations for $($serverProject.FullName). Check msbuild-server-*.log."
}

New-Item -ItemType Directory -Force -Path $OutBin | Out-Null

# Prefer recently built DLLs. Then prefer HL2MP paths.
$allDlls = @(Get-ChildItem -Path $Sdk -Recurse -Filter "*.dll" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $beforeBuild.AddMinutes(-2) } |
  Sort-Object LastWriteTime -Descending)

"=== dlls after build ===" | Out-File (Join-Path $LogDir "dlls-after-build.txt")
$allDlls | Select-Object FullName,Length,LastWriteTime | Format-List | Out-File (Join-Path $LogDir "dlls-after-build.txt") -Append

$client = $allDlls |
  Where-Object { $_.Name -ieq "client.dll" -and $_.FullName -match "hl2mp|client" } |
  Select-Object -First 1
$server = $allDlls |
  Where-Object { $_.Name -ieq "server.dll" -and $_.FullName -match "hl2mp|server" } |
  Select-Object -First 1

# Fallback: search all SDK DLLs if timestamps were weird.
if (-not $client) {
  $client = Get-ChildItem -Path $Sdk -Recurse -Filter client.dll -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "hl2mp|client" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}
if (-not $server) {
  $server = Get-ChildItem -Path $Sdk -Recurse -Filter server.dll -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "hl2mp|server" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

if (-not $client) { throw "client.dll was not produced" }
if (-not $server) { throw "server.dll was not produced" }

Say "copy client=$($client.FullName)"
Say "copy server=$($server.FullName)"
Copy-Item $client.FullName (Join-Path $OutBin "client.dll") -Force
Copy-Item $server.FullName (Join-Path $OutBin "server.dll") -Force

Say "done"
