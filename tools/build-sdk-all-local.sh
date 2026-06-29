#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

if [[ "${RUN_LINUX_BUILD:-1}" == "1" ]]; then
  echo "[openvibe] building Linux .so modules"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build-linux.log"
  tools/setup-openvibe-bin.sh
else
  echo "[openvibe] RUN_LINUX_BUILD=0, skipping Linux build"
fi

echo
if command -v powershell.exe >/dev/null 2>&1; then
  echo "[openvibe] powershell.exe found. To build Windows DLLs, run from Windows Developer PowerShell:"
else
  echo "[openvibe] Windows DLL build requires Windows + Visual Studio Build Tools. Run:"
fi
cat <<TEXT
  cd <repo>
  powershell -ExecutionPolicy Bypass -File tools/build-sdk-windows.ps1
TEXT

tools/check-openvibe-platform-binaries.sh
