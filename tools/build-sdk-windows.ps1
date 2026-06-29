$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

Write-Host "[openvibe-win] root=$Root"
Write-Host "[openvibe-win] sdk=$Sdk"

if (!(Test-Path (Join-Path $Sdk 'src'))) { throw "Source SDK not found at $Sdk" }

# Apply OpenVibe SDK copy/patches through Git Bash, but skip Linux QuickJS .a build.
$bash = Get-Command bash.exe -ErrorAction SilentlyContinue
if ($bash) {
  $rootForBash = $Root
  try {
    $rootForBash = (& $bash.Source -lc "cygpath -u '$Root'" 2>$null).Trim()
  } catch {}
  Write-Host "[openvibe-win] applying SDK patch through bash at $rootForBash"
  & $bash.Source -lc "cd '$rootForBash' && OPENVIBE_SKIP_QJS_BUILD=1 ./tools/apply-openvibe-sdk.sh"
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed" }
} else {
  Write-Warning "bash.exe not found. Skipping apply-openvibe-sdk.sh. Make sure SDK files are already applied."
}

& (Join-Path $Root 'tools/build-quickjs-lib-windows.ps1')

Push-Location (Join-Path $Sdk 'src')
try {
  $vpc = @(
    (Join-Path $Sdk 'src/devtools/bin/vpc.exe'),
    (Join-Path $Sdk 'devtools/bin/vpc.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (Test-Path '.\createallprojects.bat') {
    Write-Host "[openvibe-win] running createallprojects.bat"
    & cmd.exe /c createallprojects.bat
  } elseif ($vpc) {
    Write-Host "[openvibe-win] running VPC: $vpc"
    $ok = $false
    $attempts = @(
      @('/2013','/hl2mp','/game','/mksln','games.sln'),
      @('/hl2mp','/game','/mksln','games.sln'),
      @('+game','/mksln','games.sln')
    )
    foreach ($args in $attempts) {
      & $vpc @args
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    }
    if (!$ok) { throw "VPC solution generation failed" }
  } else {
    throw "Could not find createallprojects.bat or vpc.exe"
  }

  $sln = Get-ChildItem -Path . -Recurse -Filter *.sln | Where-Object { $_.Name -match 'game|hl2mp|everything|sdk' } | Select-Object -First 1
  if (!$sln) { $sln = Get-ChildItem -Path . -Recurse -Filter *.sln | Select-Object -First 1 }
  if (!$sln) { throw "No Visual Studio solution generated" }

  $msbuild = $null
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (Test-Path $vswhere) {
    $msbuild = (& $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1)
  }
  if (!$msbuild) { $msbuild = (Get-Command msbuild.exe -ErrorAction SilentlyContinue).Source }
  if (!$msbuild) { throw "MSBuild not found. Install Visual Studio Build Tools with C++ workload." }

  Write-Host "[openvibe-win] building $($sln.FullName)"
  $built = $false
  foreach ($platform in @('Win32','x86')) {
    foreach ($config in @('Release','Release_HL2MP','Release HL2MP')) {
      Write-Host "[openvibe-win] trying Configuration=$config Platform=$platform"
      & $msbuild $sln.FullName /m /p:Configuration=$config /p:Platform=$platform
      if ($LASTEXITCODE -eq 0) { $built = $true; break }
    }
    if ($built) { break }
  }
  if (!$built) { throw "MSBuild failed for all known configurations" }
}
finally {
  Pop-Location
}

$modBin = Join-Path $Root 'game/openvibe.games/bin'
New-Item -ItemType Directory -Force -Path $modBin | Out-Null

$client = Get-ChildItem $Sdk -Recurse -Filter client.dll -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'mod_hl2mp|hl2mp|game\\client' } | Sort-Object FullName | Select-Object -First 1
$server = Get-ChildItem $Sdk -Recurse -Filter server.dll -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'mod_hl2mp|hl2mp|game\\server' } | Sort-Object FullName | Select-Object -First 1

if ($client) { Copy-Item $client.FullName (Join-Path $modBin 'client.dll') -Force; Write-Host "[openvibe-win] copied client.dll from $($client.FullName)" } else { Write-Warning "client.dll not found after build" }
if ($server) { Copy-Item $server.FullName (Join-Path $modBin 'server.dll') -Force; Write-Host "[openvibe-win] copied server.dll from $($server.FullName)" } else { Write-Warning "server.dll not found after build" }

Write-Host "[openvibe-win] done. Proton/Windows client uses game/openvibe.games/bin/client.dll"
