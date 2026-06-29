# OpenVibe: Source multi-platform build matrix

OpenVibe needs different client/server binaries for different Source runtimes.

| Runtime | Executable | Module loaded by the engine | Output path |
| --- | --- | --- | --- |
| Linux native client | `hl2_linux` | Linux ELF client module | `game/openvibe.games/bin/linux64/client.so` |
| Linux dedicated server | `srcds_linux` | Linux ELF server module | `game/openvibe.games/bin/linux64/server.so` |
| Windows native client | `hl2.exe` | Windows PE client DLL | `game/openvibe.games/bin/client.dll` |
| Proton client | Windows `hl2.exe` under Proton | Windows PE client DLL | `game/openvibe.games/bin/client.dll` |
| Windows dedicated server | `srcds.exe` | Windows PE server DLL | `game/openvibe.games/bin/server.dll` |

Important: Proton does **not** load Linux `client.so`. It runs Windows `hl2.exe`, so it needs `client.dll`.
If the in-game console says `Unknown command "ov_join"` or `Unknown command "ov_menu"`, the OpenVibe client module is not loaded for that runtime.

## Linux build

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
tools/check-openvibe-platform-binaries.sh
```

## Windows DLL build

Run on Windows in a Visual Studio Developer PowerShell with C++ Build Tools installed:

```powershell
cd C:\path\to\openvibe-source
powershell -ExecutionPolicy Bypass -File tools\build-sdk-windows.ps1
```

That script builds QuickJS as `libquickjs_openvibe.lib`, runs VPC/MSBuild, then copies DLLs into:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

Copy those DLLs back to the Linux dev checkout if you build on a separate Windows VM. Proton will then load them.

## Runtime selection

```bash
# Prefer native Linux if hl2_linux + client.so exist, otherwise use Proton if client.dll exists.
tools/run-client-auto.sh 127.0.0.1 27015

# Force native Linux.
OPENVIBE_CLIENT_MODE=linux tools/run-client-auto.sh 127.0.0.1 27015

# Force Proton; requires client.dll.
OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

# Launch Proton even without client.dll, but in-game client commands/menu will not exist.
OPENVIBE_CLIENT_MODE=proton-fallback tools/run-client-auto.sh 127.0.0.1 27015
```
