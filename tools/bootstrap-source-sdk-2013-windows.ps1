$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function Has-HL2MP($base) {
  return ((Test-Path (Join-Path $base 'src/game/client/hl2mp')) -and (Test-Path (Join-Path $base 'src/game/server/hl2mp')))
}
function Run-Git($args, $logName) {
  $log = Join-Path $LogDir $logName
  Say "git $args"
  & git @args 2>&1 | Tee-Object -FilePath $log
  if ($LASTEXITCODE -ne 0) { throw "git $args failed with exit code $LASTEXITCODE. See $log" }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "logdir=$LogDir"

if (Has-HL2MP $Sdk) {
  Say "existing SDK tree already contains HL2MP client/server"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Deps | Out-Null

# Valve's source-sdk-2013 repository is normally organized by branches: mp and sp.
# Some forks/mirrors use root folders like mp/src. Support both layouts.
$RepoUrl = if ($env:OPENVIBE_SOURCE_SDK_REPO) { $env:OPENVIBE_SOURCE_SDK_REPO } else { 'https://github.com/ValveSoftware/source-sdk-2013.git' }
$ValveRepo = Join-Path $Deps 'source-sdk-2013-mp'

if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }

$cloned = $false
try {
  Say "cloning Valve Source SDK 2013 branch mp"
  Run-Git @('clone','--depth','1','--branch','mp',$RepoUrl,$ValveRepo) 'bootstrap-git-clone-mp.log'
  $cloned = $true
} catch {
  Say "mp branch clone failed: $($_.Exception.Message)"
  if (Test-Path $ValveRepo) { Remove-Item -Recurse -Force $ValveRepo }
  Say "falling back to default branch clone"
  Run-Git @('clone','--depth','1',$RepoUrl,$ValveRepo) 'bootstrap-git-clone-default.log'
  $cloned = $true
}

if (-not $cloned) { throw "could not clone Source SDK repo" }

"=== Valve repo root ===" | Out-File (Join-Path $LogDir 'valve-repo-root.txt')
Get-ChildItem -Force $ValveRepo | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'valve-repo-root.txt') -Append
"=== candidate src folders ===" | Out-File (Join-Path $LogDir 'valve-candidate-src.txt')
Get-ChildItem -Path $ValveRepo -Recurse -Directory -Filter src -ErrorAction SilentlyContinue |
  Select-Object FullName | Format-List | Out-File (Join-Path $LogDir 'valve-candidate-src.txt') -Append

$candidates = @(
  $ValveRepo,
  (Join-Path $ValveRepo 'mp'),
  (Join-Path $ValveRepo 'srcsdk/mp'),
  (Join-Path $ValveRepo 'source-sdk-2013/mp')
)

$SourceRoot = $null
foreach ($candidate in $candidates) {
  if (Has-HL2MP $candidate) {
    $SourceRoot = $candidate
    break
  }
}

if (-not $SourceRoot) {
  $matches = Get-ChildItem -Path $ValveRepo -Recurse -Directory -Filter hl2mp -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]src[\\/]game[\\/](client|server)[\\/]hl2mp$' }
  $matches | Select-Object FullName | Format-List | Out-File (Join-Path $LogDir 'hl2mp-folder-search.txt')
  throw "Could not find Source SDK 2013 MP HL2MP layout after clone. Check valve-repo-root.txt, valve-candidate-src.txt, and hl2mp-folder-search.txt."
}

Say "source root=$SourceRoot"
Say "copying Source SDK MP layout into $Sdk"
if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
Copy-Item -Path (Join-Path $SourceRoot '*') -Destination $Sdk -Recurse -Force

if (!(Has-HL2MP $Sdk)) {
  Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
  throw "Bootstrapped SDK is missing expected HL2MP folders after copy"
}

"=== SDK root after copy ===" | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt')
Get-ChildItem -Force $Sdk | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-root-after-copy.txt') -Append
"=== SDK src root after copy ===" | Out-File (Join-Path $LogDir 'sdk-src-root-after-copy.txt')
Get-ChildItem -Force (Join-Path $Sdk 'src') | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir 'sdk-src-root-after-copy.txt') -Append

Say "SDK bootstrapped successfully"
