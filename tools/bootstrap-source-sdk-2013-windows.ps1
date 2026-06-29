$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $Deps, $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function Dump-Dir($path, $outName) {
  try {
    if (Test-Path $path) {
      Get-ChildItem -Force $path | Select-Object Mode,Length,Name | Format-Table -AutoSize | Out-File (Join-Path $LogDir $outName)
    } else {
      "[missing] $path" | Out-File (Join-Path $LogDir $outName)
    }
  } catch {
    "dump failed: $($_.Exception.Message)" | Out-File (Join-Path $LogDir $outName)
  }
}
function Assert-UsableSdk($prefix) {
  if ((Test-Path (Join-Path $Src 'game/client/hl2mp')) -and (Test-Path (Join-Path $Src 'game/server/hl2mp'))) {
    Say "$prefix SDK tree looks usable"
    return $true
  }
  return $false
}
function Copy-SdkRoot($sourceRoot) {
  Say "copying SDK root $sourceRoot -> $Sdk"
  if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
  New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $Sdk -Recurse -Force
  Dump-Dir $Sdk 'sdk-root-after-copy.txt'
  if (!(Assert-UsableSdk 'copied')) {
    throw "Copied SDK is missing expected HL2MP folders under $Src"
  }
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "deps=$Deps"

if (Assert-UsableSdk 'existing') { exit 0 }

# ValveSoftware/source-sdk-2013 currently uses the default/master layout with src/ at the repository root.
# Do not assume an mp branch or mp/src folder. Downloading the zip avoids git/extraheader/auth weirdness on Actions runners.
$zip = Join-Path $Deps 'source-sdk-2013-master.zip'
$extractParent = Join-Path $Deps 'source-sdk-2013-zip'
$zipRoot = Join-Path $extractParent 'source-sdk-2013-master'
$zipUrl = 'https://codeload.github.com/ValveSoftware/source-sdk-2013/zip/refs/heads/master'

$zipOk = $false
try {
  Say "downloading Valve SDK master zip from $zipUrl"
  if (Test-Path $zip) { Remove-Item -Force $zip }
  if (Test-Path $extractParent) { Remove-Item -Recurse -Force $extractParent }
  New-Item -ItemType Directory -Force -Path $extractParent | Out-Null

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --retry 4 --retry-delay 3 --connect-timeout 30 -o $zip $zipUrl 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-curl-master-zip.log')
    if ($LASTEXITCODE -ne 0) { throw "curl.exe failed with exit code $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-iwr-master-zip.log')
  }

  $zipInfo = Get-Item $zip
  Say "zip bytes=$($zipInfo.Length)"
  if ($zipInfo.Length -lt 1000000) { throw "downloaded zip is suspiciously small" }

  Expand-Archive -Path $zip -DestinationPath $extractParent -Force
  Dump-Dir $extractParent 'zip-extract-parent.txt'
  Dump-Dir $zipRoot 'zip-root.txt'

  if (Test-Path (Join-Path $zipRoot 'src/game/client/hl2mp')) {
    Copy-SdkRoot $zipRoot
    $zipOk = $true
  } else {
    throw "zip did not contain expected src/game/client/hl2mp at $zipRoot"
  }
} catch {
  Say "zip bootstrap failed: $($_.Exception.Message)"
  $_ | Out-String | Out-File (Join-Path $LogDir 'bootstrap-zip-exception.txt')
}

if ($zipOk) { Say 'SDK bootstrapped successfully from zip'; exit 0 }

# Last-resort git fallback. Clear possible GitHub Actions extraheaders and force public HTTPS.
$gitRepo = Join-Path $Deps 'source-sdk-2013-git'
try {
  Say "trying git clone fallback"
  git config --global --unset-all http.https://github.com/.extraheader 2>$null
  git config --global --unset-all http.https://github.com/ValveSoftware/source-sdk-2013.extraheader 2>$null
  if (Test-Path $gitRepo) { Remove-Item -Recurse -Force $gitRepo }
  & git -c http.https://github.com/.extraheader= clone --depth 1 --single-branch https://github.com/ValveSoftware/source-sdk-2013.git $gitRepo 2>&1 | Tee-Object -FilePath (Join-Path $LogDir 'bootstrap-git-clone-master.log')
  if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }
  Dump-Dir $gitRepo 'git-root.txt'
  if (Test-Path (Join-Path $gitRepo 'src/game/client/hl2mp')) {
    Copy-SdkRoot $gitRepo
    Say 'SDK bootstrapped successfully from git'
    exit 0
  }
  throw "git clone did not contain src/game/client/hl2mp"
} catch {
  Say "git bootstrap failed: $($_.Exception.Message)"
  $_ | Out-String | Out-File (Join-Path $LogDir 'bootstrap-git-exception.txt')
}

Dump-Dir $Deps 'deps-after-bootstrap-failure.txt'
throw "Could not bootstrap ValveSoftware/source-sdk-2013. Check openvibe-windows-build-debug artifact, especially bootstrap-curl-master-zip.log, bootstrap-zip-exception.txt, and bootstrap-git-clone-master.log."
