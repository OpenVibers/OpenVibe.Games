# Proton client DLL debug path

Proton runs the Windows `hl2.exe`, so it loads:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

It cannot load the Linux modules:

```text
game/openvibe.games/bin/linux64/client.so
game/openvibe.games/bin/linux64/server.so
```

If the in-game console says `Unknown command "ov_join"` or `Unknown command "ov_menu"`, then one of these is true:

1. `client.dll` is missing.
2. `client.dll` is stock/old and does not contain the OpenVibe commands.
3. The mod path is wrong and `hl2.exe` is not loading `game/openvibe.games`.
4. The DLL failed during load.

Useful commands:

```bash
tools/verify-openvibe-dll-content.sh
OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015
tools/collect-proton-openvibe-debug.sh
```

Safe fallback aliases are prefixed with `ovp_` so they do not mask real client DLL commands:

```text
ovp_help
ovp_join_hub
ovp_join_prophunt
ovp_join_deathrun
ovp_join_fortwars
ovp_join_traitortown
```
