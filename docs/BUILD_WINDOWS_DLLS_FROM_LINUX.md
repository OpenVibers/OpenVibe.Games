# Building Windows `client.dll` / `server.dll` from Linux

OpenVibe supports two binary families:

| Runtime | Client binary | Server binary | Notes |
| --- | --- | --- | --- |
| Native Linux Source | `game/openvibe.games/bin/linux64/client.so` | `game/openvibe.games/bin/linux64/server.so` | Built by the Linux SDK build. |
| Windows / Proton Source | `game/openvibe.games/bin/client.dll` | `game/openvibe.games/bin/server.dll` | Must be built with a Windows/MSVC-compatible toolchain. |

## Can Windows DLLs be built on Linux?

Operationally, yes: trigger a Windows build from Linux using GitHub Actions:

```bash
git push
tools/request-windows-dll-build.sh
```

That runs the build on a Windows runner, downloads the `openvibe-windows-dlls` artifact, and installs `client.dll` / `server.dll` into `game/openvibe.games/bin`.

## Why not just MinGW?

Source SDK 2013's Windows client/server DLLs are built around the MSVC ABI, Valve's VPC-generated Visual Studio projects, and Windows import/static libraries. A MinGW cross-compile from Linux is theoretically possible only after significant porting and import-library work, but it is not the practical path.

## Reliable options

1. **GitHub Actions Windows runner**: easiest from a Linux workstation.
2. **Windows VM on Linux**: build with Visual Studio Build Tools/MSBuild, copy DLLs back.
3. **Wine + Visual Studio Build Tools**: possible but brittle; treat as experimental.

## Test

```bash
tools/check-openvibe-platform-binaries.sh
OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015
```

If `client.dll` is present and correct, Proton's Windows `hl2.exe` should load OpenVibe client commands like `ov_join` and `ov_menu`.
