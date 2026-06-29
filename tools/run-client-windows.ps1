$ErrorActionPreference = 'Stop'

$Root = if ($env:OPENVIBE_ROOT) { $env:OPENVIBE_ROOT } else { Join-Path $HOME 'src/openvibe-source' }
$GameDir = Join-Path $Root 'game/openvibe.games'
$ClientDll = Join-Path $GameDir 'bin/client.dll'
$Hl2Exe = if ($env:OPENVIBE_HL2_EXE) { $env:OPENVIBE_HL2_EXE } else { 'C:\Program Files (x86)\Steam\steamapps\common\Source SDK Base 2013 Multiplayer\hl2.exe' }

if (!(Test-Path $Hl2Exe)) { throw "hl2.exe not found. Set OPENVIBE_HL2_EXE." }
if (!(Test-Path $ClientDll)) { throw "client.dll missing at $ClientDll. Run tools/build-sdk-windows.ps1 first." }

$args = @('-game', $GameDir, '-console', '-dev', '-novid', '-sw', '-w', '1280', '-h', '720', '+exec', 'openvibe_proton_client.cfg')
if ($args.Count -ge 2 -and $args[0] -match '^\d+\.\d+\.\d+\.\d+$') {
  # no-op; reserved for direct powershell invocation variants
}

if ($args.Count -ge 2) {}

# Accept optional IP PORT positional args from after -File.
$extra = $MyInvocation.UnboundArguments
if ($extra.Count -ge 2) {
  $args += @('+connect', "$($extra[0]):$($extra[1])")
}

Start-Process -FilePath $Hl2Exe -ArgumentList $args -WorkingDirectory (Split-Path $Hl2Exe)
