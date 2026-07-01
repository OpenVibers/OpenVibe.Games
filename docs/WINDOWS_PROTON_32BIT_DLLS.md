# Windows/Proton Source SDK DLL architecture

The Proton launch path uses the Windows `hl2.exe` from Source SDK Base 2013 Multiplayer. In the normal Steam install this is a 32-bit executable, so the mod must install 32-bit `client.dll` and `server.dll` in `game/openvibe.games/bin`.

The GitHub Actions Windows build therefore defaults `OPENVIBE_WINDOWS_TARGET_ARCH=x86` and uses the x86 Visual Studio developer shell. x64/PE32+ DLLs may build successfully, but Proton/HL2 will not load them for the normal 32-bit SDK Base client.

Use:

```bash
tools/install-latest-openvibe-windows-dlls.sh
```

Then smoke test:

```bash
tools/proton-openvibe-command-smoke.sh
```
