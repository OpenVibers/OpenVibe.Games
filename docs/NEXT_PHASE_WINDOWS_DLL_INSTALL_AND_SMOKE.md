# Next phase: install successful Windows DLL artifacts and smoke test Proton

The Windows GitHub Actions build now produces `openvibe-windows-dlls` with patched `client.dll` and `server.dll`.

Use:

```bash
tools/install-latest-successful-windows-dlls.sh
```

That downloads the latest successful `windows-source-sdk-dlls.yml` artifact for the current branch, verifies OpenVibe strings, backs up old local DLLs, and installs into:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

Then run:

```bash
tools/proton-openvibe-smoke-test.sh
```

To actually launch from the smoke helper:

```bash
OPENVIBE_RUN_GAME=1 tools/proton-openvibe-smoke-test.sh 127.0.0.1 27015
```

Expected in-game console checks:

```text
ov_help
ov_join hub
ov_menu
ov_menu_servers
ov_auth_steam
```

Do not blindly commit installed DLL binaries unless that is intentional. The repeatable source of truth is the Actions artifact.
