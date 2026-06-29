param(
  [switch]$InDevShell
)

$ErrorActionPreference = "Stop"

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root "engine/source-sdk-2013" }
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }
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

Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"

Require $Src "Source SDK checkout is missing from this runner. Bootstrap must create engine/source-sdk-2013 first."

# VPC is generating *_win64_*.vcxproj on the hosted runner, so use an x64 VS shell.
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

Say "cl.exe already available"
where.exe cl | Out-File (Join-Path $LogDir "where-cl.txt")
where.exe msbuild | Out-File (Join-Path $LogDir "where-msbuild.txt")
where.exe lib | Out-File (Join-Path $LogDir "where-lib.txt")
Ensure-PythonOnPath


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
    foreach ($plat in @("x64", "Win64", "Win32", "x86")) {
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

function Invoke-MSBuildProject([System.IO.FileInfo]$proj, [string]$label) {
  Say "building $label project=$($proj.FullName)"
  $pairs = Get-ProjectConfigs $proj.FullName
  if ($pairs.Count -eq 0) {
    $pairs = @([pscustomobject]@{ Configuration = "Release"; Platform = "x64" })
  }
  $pairs = Sort-PreferredConfigs $pairs $proj.Name

  foreach ($p in $pairs) {
    $cfgSafe = ($p.Configuration -replace '[^A-Za-z0-9]+','_')
    $platSafe = ($p.Platform -replace '[^A-Za-z0-9]+','_')
    $log = Join-Path $LogDir "msbuild-$label-$cfgSafe-$platSafe.log"
    Say "msbuild $label cfg=$($p.Configuration) platform=$($p.Platform)"
    & msbuild $proj.FullName /m /p:Configuration="$($p.Configuration)" /p:Platform="$($p.Platform)" /t:Build /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log
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

# Prefer the actual HL2MP game projects and prefer win64 because current Valve VPC emitted *_win64_hl2mp.vcxproj on the runner.
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

Build-SourceSdkDependencyProjects

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
