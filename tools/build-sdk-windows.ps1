$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Sdk = Join-Path $Root "engine/source-sdk-2013"
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$Qjs = Join-Path $Src "game/shared/openvibe/third_party/quickjs"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }
function Require($p, $msg) {
  if (!(Test-Path $p)) { throw "$msg`nMissing: $p" }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"
Require $Src "Source SDK checkout is missing from this runner. The workflow must have engine/source-sdk-2013 available in the repository/submodule before Windows DLLs can build."

# Apply OpenVibe source files using Git Bash when available. This reuses the Linux patcher on Windows runners.
$bash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($bash) {
  Say "applying OpenVibe SDK patch through bash"
  & bash "$Root/tools/apply-openvibe-sdk.sh"
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed with exit code $LASTEXITCODE" }
} else {
  throw "Git Bash is required on the Windows runner to apply the OpenVibe SDK patch."
}

# Build QuickJS as MSVC objects/lib. The Linux .a cannot be linked into Windows DLLs.
if (Test-Path (Join-Path $Root "tools/build-quickjs-lib-windows.ps1")) {
  Say "building QuickJS Windows static library"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/build-quickjs-lib-windows.ps1")
  if ($LASTEXITCODE -ne 0) { throw "build-quickjs-lib-windows.ps1 failed with exit code $LASTEXITCODE" }
} else {
  Say "no build-quickjs-lib-windows.ps1 found; continuing"
}

Set-Location $Src

# Generate Visual Studio project files if needed.
$solutions = @(Get-ChildItem -Path $Src -Recurse -Filter "*.sln" -ErrorAction SilentlyContinue)
if ($solutions.Count -eq 0) {
  Say "no .sln files found; trying Source SDK project generators"
  $generators = @(
    (Join-Path $Src "creategameprojects.bat"),
    (Join-Path $Src "createallprojects.bat"),
    (Join-Path $Src "createprojects.bat")
  )
  $ran = $false
  foreach ($gen in $generators) {
    if (Test-Path $gen) {
      Say "running $gen"
      & cmd /c "`"$gen`"" | Tee-Object -FilePath (Join-Path $LogDir "project-generation.log")
      $ran = $true
      break
    }
  }

  if (-not $ran) {
    $vpc = Join-Path $Src "devtools/bin/vpc.exe"
    if (Test-Path $vpc) {
      Say "running vpc.exe fallback"
      & $vpc /hl2mp +game /mksln OpenVibe_HL2MP.sln | Tee-Object -FilePath (Join-Path $LogDir "vpc.log")
      $ran = $true
    }
  }

  $solutions = @(Get-ChildItem -Path $Src -Recurse -Filter "*.sln" -ErrorAction SilentlyContinue)
  if ($solutions.Count -eq 0) {
    Get-ChildItem -Path $Src -Force | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir "src-root-after-generator.txt")
    throw "No Visual Studio solution was generated. Check openvibe-windows-build-debug artifact."
  }
}

Say "solutions found:"
$solutions | ForEach-Object { Say "  $($_.FullName)" }

# Pick the most likely HL2MP/game solution.
$solution = $solutions |
  Where-Object { $_.Name -match "hl2mp|game|sdk|everything|OpenVibe" } |
  Select-Object -First 1
if (-not $solution) { $solution = $solutions | Select-Object -First 1 }
Say "selected solution=$($solution.FullName)"

# Try common project targets/configurations. Source SDK projects vary by branch/version.
$configs = @("Release", "Release_HL2MP", "Release HL2MP")
$platforms = @("Win32", "x86")
$targets = @("client_hl2mp", "server_hl2mp", "client", "server", "Build")

$builtAny = $false
foreach ($cfg in $configs) {
  foreach ($plat in $platforms) {
    foreach ($target in $targets) {
      Say "msbuild cfg=$cfg platform=$plat target=$target"
      & msbuild $solution.FullName /m /p:Configuration=$cfg /p:Platform=$plat /t:$target /v:minimal /nologo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "msbuild-$($cfg -replace '[^A-Za-z0-9]','_')-$plat-$target.log")
      if ($LASTEXITCODE -eq 0) {
        $builtAny = $true
        break
      }
    }
    if ($builtAny) { break }
  }
  if ($builtAny) { break }
}

if (-not $builtAny) {
  throw "MSBuild could not build any known Source SDK HL2MP target. Check uploaded msbuild logs."
}

New-Item -ItemType Directory -Force -Path $OutBin | Out-Null

$client = Get-ChildItem -Path $Sdk -Recurse -Filter client.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "hl2mp|mod_hl2mp|client" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$server = Get-ChildItem -Path $Sdk -Recurse -Filter server.dll -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "hl2mp|mod_hl2mp|server" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $client) { throw "client.dll was not produced" }
if (-not $server) { throw "server.dll was not produced" }

Say "copy client=$($client.FullName)"
Say "copy server=$($server.FullName)"
Copy-Item $client.FullName (Join-Path $OutBin "client.dll") -Force
Copy-Item $server.FullName (Join-Path $OutBin "server.dll") -Force

Say "done"
