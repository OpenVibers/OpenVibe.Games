$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$ValveRepo = Join-Path $Deps 'source-sdk-2013'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }

Say "root=$Root"
Say "sdk=$Sdk"

if ((Test-Path (Join-Path $Src 'game/client/hl2mp')) -and (Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
  Say "existing SDK tree looks usable"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Deps | Out-Null

if (!(Test-Path (Join-Path $ValveRepo '.git'))) {
  Say "cloning ValveSoftware/source-sdk-2013"
  if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }
  git clone --depth 1 https://github.com/ValveSoftware/source-sdk-2013.git $ValveRepo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-clone.log')
} else {
  Say "updating cached Valve source-sdk-2013"
  Push-Location $ValveRepo
  git fetch --depth 1 origin 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-fetch.log')
  git reset --hard origin/master 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-reset.log')
  Pop-Location
}

$Mp = Join-Path $ValveRepo 'mp'
if (!(Test-Path (Join-Path $Mp 'src'))) {
  Get-ChildItem -Force $ValveRepo | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'valve-repo-root.txt')
  throw "Valve source-sdk-2013 clone does not contain mp/src at $Mp/src"
}

Say "copying mp branch layout into $Sdk"
if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
Copy-Item -Path (Join-Path $Mp '*') -Destination $Sdk -Recurse -Force

if (!(Test-Path (Join-Path $Src 'game/client/hl2mp')) -or !(Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
  Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
  throw "Bootstrapped SDK is missing expected HL2MP folders"
}

Say "SDK bootstrapped successfully"
