# OpenVibe client DLL + loading screen notes

The Proton launcher runs Windows `hl2.exe`. That Windows executable will not load the Linux
`game/openvibe.games/bin/linux64/client.so` produced by the current Source SDK Linux build.

That means native client commands such as `ov_join`, `ov_menu`, `ov_ui`, and the in-game
CEF/HTML menu only exist when a matching client DLL is actually loaded by the game client.
Until we build a Windows `client.dll` or switch to a native Linux client path, the Electron
launcher is the reliable custom Chromium shell.

This phase keeps the Electron launcher visible during Source startup, shows a clear launch
state, and focuses the Source window only after it has appeared and stayed stable for a few
seconds. It also installs best-effort Source resource overrides for the classic loading dialog.
