#!/usr/bin/env bash
set -euo pipefail

echo "[openvibe] local Windows build-on-Linux probe"
echo
echo "Pure MinGW cross-compile is not the recommended route for Source SDK 2013 client.dll."
echo "The Windows Source client DLL needs the MSVC ABI/toolchain and Valve's Windows project layout."
echo
echo "What this host has:"

for tool in wine wine64 cl link msbuild x86_64-w64-mingw32-g++ gh; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "[ok]      $tool -> $(command -v "$tool")"
  else
    echo "[missing] $tool"
  fi
done

echo
echo "Recommended from Linux:"
echo "  1. Commit/push your branch."
echo "  2. Run: tools/request-windows-dll-build.sh"
echo "  3. Let GitHub Actions Windows runner build client.dll/server.dll with MSVC."
echo
echo "Experimental local path:"
echo "  - Windows VM on Linux, or"
echo "  - Wine with Visual Studio Build Tools installed, then run tools/build-sdk-windows.ps1 under that environment."
echo "This is brittle; use the GitHub Actions/Windows runner first."
