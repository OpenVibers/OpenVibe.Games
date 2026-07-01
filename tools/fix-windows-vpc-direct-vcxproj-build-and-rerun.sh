#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

BRANCH="$(git branch --show-current)"
echo "[openvibe] fix Windows build: VPC generated extensionless solution / direct vcxproj build"
echo "[openvibe] root=$ROOT"
echo "[openvibe] branch=$BRANCH"

mkdir -p tools docs

cat > tools/build-sdk-windows.ps1 <<'PS1'
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
PS1

cat > docs/WINDOWS_VPC_DIRECT_PROJECT_BUILD.md <<'EOF'
# Windows VPC direct project build

Valve's `createallprojects.bat` runs VPC and is expected to emit `everything.sln`, but on the hosted runner VPC logged an extensionless `everything` solution while still generating the actual HL2MP `.vcxproj` files.

The Windows build now treats the solution as optional and builds the generated HL2MP client/server projects directly:

- `client*_hl2mp*.vcxproj`
- `server*_hl2mp*.vcxproj`

It also records generated projects and DLL locations in `artifacts/windows-build-debug`.
EOF

echo "[openvibe] git diff summary"
git diff --stat -- tools/build-sdk-windows.ps1 docs/WINDOWS_VPC_DIRECT_PROJECT_BUILD.md || true

git add tools/build-sdk-windows.ps1 docs/WINDOWS_VPC_DIRECT_PROJECT_BUILD.md "$0"
if ! git diff --cached --quiet; then
  git commit -m "Build Windows Source SDK HL2MP projects directly"
fi

git push origin "$BRANCH"

echo "[openvibe] triggering clean Windows DLL build"
if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  tools/trigger-windows-dll-build-clean.sh
else
  tools/gh-windows-build-and-install.sh
fi
