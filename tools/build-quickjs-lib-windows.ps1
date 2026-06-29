$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$Sdk = if ($env:OPENVIBE_SDK) { $env:OPENVIBE_SDK } else { Join-Path $Root 'engine/source-sdk-2013' }

$SrcQjs = Join-Path $Root 'sdk/openvibe/third_party/quickjs'
$SdkQjs = Join-Path $Sdk 'src/game/shared/openvibe/third_party/quickjs'
$Out = Join-Path $SdkQjs 'build'

if (!(Test-Path (Join-Path $SrcQjs 'quickjs.c'))) {
  throw "Missing $SrcQjs/quickjs.c. Run tools/vendor-quickjs.sh first."
}

New-Item -ItemType Directory -Force -Path $SdkQjs, $Out | Out-Null
Get-ChildItem $SrcQjs -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $SdkQjs $_.Name) -Force }

if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw "cl.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}
if (!(Get-Command lib.exe -ErrorAction SilentlyContinue)) {
  throw "lib.exe not found. Run this from a Visual Studio Developer PowerShell or Developer Command Prompt."
}

$sources = @('quickjs.c','libregexp.c','libunicode.c','cutils.c')
if (Test-Path (Join-Path $SdkQjs 'dtoa.c')) { $sources += 'dtoa.c' }
if (Test-Path (Join-Path $SdkQjs 'libbf.c')) { $sources += 'libbf.c' }

Remove-Item (Join-Path $Out '*.obj') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Out 'libquickjs_openvibe.lib') -Force -ErrorAction SilentlyContinue

$objects = @()
foreach ($src in $sources) {
  $obj = Join-Path $Out ([IO.Path]::GetFileNameWithoutExtension($src) + '.obj')
  Write-Host "[openvibe-qjs-win] cl $src -> $obj"
  & cl.exe /nologo /O2 /MT /W3 /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WINDOWS /DCONFIG_VERSION='"openvibe"' /I"$SdkQjs" /c (Join-Path $SdkQjs $src) /Fo"$obj"
  if ($LASTEXITCODE -ne 0) { throw "cl failed for $src" }
  $objects += $obj
}

$outLib = Join-Path $Out 'libquickjs_openvibe.lib'
& lib.exe /nologo /OUT:"$outLib" $objects
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed" }
Write-Host "[openvibe-qjs-win] built $outLib"
