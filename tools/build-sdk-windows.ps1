param(
  [switch]$InDevShell
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root "engine/source-sdk-2013" }
$Src = Join-Path $Sdk "src"
$Mod = Join-Path $Root "game/openvibe.games"
$OutBin = Join-Path $Mod "bin"
$LogDir = Join-Path $Root "artifacts/windows-build-debug"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-win] $m" }
function Require($p, $msg) { if (!(Test-Path $p)) { throw "$msg`nMissing: $p" } }

function Enter-MsvcDevShellIfNeeded {
  if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
    Say "cl.exe already available"
    return
  }
  if ($InDevShell) { throw "cl.exe still not found after entering MSVC dev shell" }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
  if (!(Test-Path $vswhere)) { throw "vswhere.exe not found; Visual Studio Build Tools are not installed" }

  $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (!$install) { throw "Could not find Visual Studio installation with VC x86/x64 tools" }

  $vcvars = Join-Path $install "VC/Auxiliary/Build/vcvars32.bat"
  if (!(Test-Path $vcvars)) { throw "vcvars32.bat not found at $vcvars" }

  Say "relaunching through MSVC x86 dev shell: $vcvars"
  $self = $PSCommandPath
  $cmd = "call `"$vcvars`" && powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -InDevShell"
  & cmd.exe /d /s /c $cmd
  exit $LASTEXITCODE
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "src=$Src"

$env:OPENVIBE_ROOT = $Root
$env:OPENVIBE_SDK = $Sdk

if (!(Test-Path $Src)) {
  Say "SDK src missing; bootstrapping Source SDK 2013 MP"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/bootstrap-source-sdk-2013-windows.ps1")
  if ($LASTEXITCODE -ne 0) { throw "bootstrap-source-sdk-2013-windows.ps1 failed with exit code $LASTEXITCODE" }
}

Require $Src "Source SDK checkout is missing from this runner."
Require (Join-Path $Src "game/client/hl2mp") "Source SDK HL2MP client tree missing."
Require (Join-Path $Src "game/server/hl2mp") "Source SDK HL2MP server tree missing."

Enter-MsvcDevShellIfNeeded

# Do not let old/stock repo DLLs get mistaken for a successful new build.
New-Item -ItemType Directory -Force -Path $OutBin | Out-Null
Remove-Item (Join-Path $OutBin "client.dll") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $OutBin "server.dll") -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $Sdk "game/mod_hl2mp/bin") -ErrorAction SilentlyContinue

# Apply OpenVibe source files using Git Bash. Skip the Linux QuickJS build inside apply-openvibe-sdk.sh.
$bash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($bash) {
  Say "applying OpenVibe SDK patch through bash"
  $env:OPENVIBE_SKIP_QJS_BUILD = "1"
  & bash "$Root/tools/apply-openvibe-sdk.sh" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "apply-openvibe-sdk.log")
  if ($LASTEXITCODE -ne 0) { throw "apply-openvibe-sdk.sh failed with exit code $LASTEXITCODE" }
} else {
  throw "Git Bash is required on the Windows runner to apply the OpenVibe SDK patch."
}

Say "building QuickJS Windows static library"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "tools/build-quickjs-lib-windows.ps1") 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "quickjs-windows.log")
if ($LASTEXITCODE -ne 0) { throw "build-quickjs-lib-windows.ps1 failed with exit code $LASTEXITCODE" }

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
      & cmd /d /s /c "`"$gen`"" 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "project-generation.log")
      $ran = $true
      break
    }
  }

  if (-not $ran) {
    $vpc = Join-Path $Src "devtools/bin/vpc.exe"
    if (Test-Path $vpc) {
      Say "running vpc.exe fallback"
      & $vpc /hl2mp +game /mksln OpenVibe_HL2MP.sln 2>&1 | Tee-Object -FilePath (Join-Path $LogDir "vpc.log")
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

$solution = $solutions |
  Where-Object { $_.Name -match "hl2mp|game|sdk|everything|OpenVibe" } |
  Select-Object -First 1
if (-not $solution) { $solution = $solutions | Select-Object -First 1 }
Say "selected solution=$($solution.FullName)"

$configs = @("Release", "Release_HL2MP", "Release HL2MP")
$platforms = @("Win32", "x86")
$targets = @("client_hl2mp", "server_hl2mp", "client", "server", "Build")

$builtAny = $false
foreach ($cfg in $configs) {
  foreach ($plat in $platforms) {
    foreach ($target in $targets) {
      Say "msbuild cfg=$cfg platform=$plat target=$target"
      $log = Join-Path $LogDir "msbuild-$($cfg -replace '[^A-Za-z0-9]','_')-$plat-$target.log"
      & msbuild $solution.FullName /m /p:Configuration=$cfg /p:Platform=$plat /p:PlatformToolset=v143 /t:$target /v:minimal /nologo 2>&1 | Tee-Object -FilePath $log
      if ($LASTEXITCODE -eq 0) { $builtAny = $true; break }
    }
    if ($builtAny) { break }
  }
  if ($builtAny) { break }
}

if (-not $builtAny) { throw "MSBuild could not build any known Source SDK HL2MP target. Check uploaded msbuild logs." }

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

$clientText = & strings.exe (Join-Path $OutBin "client.dll") 2>$null | Select-String -Pattern "ov_join|ov_menu|OpenVibe" -Quiet
if (-not $clientText) { throw "Built client.dll does not contain OpenVibe strings; refusing to publish stale/stock DLL" }

Say "done"
