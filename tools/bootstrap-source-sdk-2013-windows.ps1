$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { (Resolve-Path $env:OPENVIBE_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }
$Src = Join-Path $Sdk 'src'
$Deps = Join-Path $Root '_deps'
$Checkout = Join-Path $Deps 'source-sdk-2013-upstream'
$LogDir = Join-Path $Root 'artifacts/windows-build-debug'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Say($m) { Write-Host "[openvibe-sdk-bootstrap] $m" }
function WriteTree($path, $name) {
  try {
    if (Test-Path $path) {
      "=== $path ===" | Out-File (Join-Path $LogDir $name)
      Get-ChildItem -Force $path | Select-Object Mode,Length,Name,FullName | Format-Table -AutoSize | Out-File (Join-Path $LogDir $name) -Append
    } else {
      "[missing] $path" | Out-File (Join-Path $LogDir $name)
    }
  } catch {
    "[tree failed] $path $($_.Exception.Message)" | Out-File (Join-Path $LogDir $name)
  }
}
function HasHl2mp($root) {
  $src = Join-Path $root 'src'
  return ((Test-Path (Join-Path $src 'game/client/hl2mp')) -and (Test-Path (Join-Path $src 'game/server/hl2mp')))
}
function CopyLayout($fromRoot, $label) {
  Say "using Valve SDK layout: $label -> $Sdk"
  if (Test-Path $Sdk) { Remove-Item -Recurse -Force $Sdk }
  New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
  Get-ChildItem -Force $fromRoot | Where-Object { $_.Name -ne '.git' } | ForEach-Object {
    Copy-Item $_.FullName -Destination $Sdk -Recurse -Force
  }
  if (-not (HasHl2mp $Sdk)) {
    WriteTree $Sdk 'sdk-root-after-copy.txt'
    throw "Copied SDK layout is missing expected src/game/client/hl2mp and src/game/server/hl2mp folders"
  }
  Say "SDK bootstrapped successfully"
}

Say "root=$Root"
Say "sdk=$Sdk"
Say "deps=$Deps"
Say "checkout=$Checkout"
WriteTree $Root 'repo-root-before-bootstrap.txt'
WriteTree $Deps 'deps-before-bootstrap.txt'

if (HasHl2mp $Sdk) {
  Say "existing SDK tree looks usable"
  exit 0
}

# Preferred path: GitHub Actions checks out ValveSoftware/source-sdk-2013 into _deps/source-sdk-2013-upstream.
# This avoids flaky codeload/curl behavior and avoids git credential leakage from the OpenVibe checkout.
$candidates = @(
  @{ Root = $Checkout; Label = 'upstream root/src' },
  @{ Root = (Join-Path $Checkout 'mp'); Label = 'upstream mp/src' },
  @{ Root = (Join-Path $Checkout 'sp'); Label = 'upstream sp/src' }
)
foreach ($c in $candidates) {
  if ((Test-Path $c.Root) -and (HasHl2mp $c.Root)) {
    CopyLayout $c.Root $c.Label
    exit 0
  }
}

# Emergency fallback only: try a clean public clone with credentials explicitly disabled.
# The workflow should normally never reach this if the actions/checkout step worked.
Say "actions checkout layout was not found; trying emergency public git clone fallback"
$Fallback = Join-Path $Deps 'source-sdk-2013-git-fallback'
if (Test-Path $Fallback) { Remove-Item -Recurse -Force $Fallback }
New-Item -ItemType Directory -Force -Path $Deps | Out-Null
$cloneLog = Join-Path $LogDir 'bootstrap-git-clone-fallback.log'
& git -c http.https://github.com/.extraheader= clone --depth 1 https://github.com/ValveSoftware/source-sdk-2013.git $Fallback 2>&1 | Tee-Object -FilePath $cloneLog
if ($LASTEXITCODE -ne 0) {
  WriteTree $Deps 'deps-after-bootstrap-failure.txt'
  throw "Could not clone ValveSoftware/source-sdk-2013. Check $cloneLog"
}

foreach ($root in @($Fallback, (Join-Path $Fallback 'mp'), (Join-Path $Fallback 'sp'))) {
  if ((Test-Path $root) -and (HasHl2mp $root)) {
    CopyLayout $root "git fallback $root"
    exit 0
  }
}

WriteTree $Fallback 'fallback-root-after-clone.txt'
throw "ValveSoftware/source-sdk-2013 was fetched, but no usable HL2MP src layout was found."
