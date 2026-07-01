# Windows target arch trim fix

The Win32 GitHub Actions build relaunches through `vcvars32.bat`. The target arch value can survive as `x86 ` with a trailing space depending on how the command string/env was composed. `tools/build-sdk-windows.ps1` now trims `OPENVIBE_WINDOWS_TARGET_ARCH` before validation and normalizes it after validation so Win32 builds do not fail before project generation.
