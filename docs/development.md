# Development Workflow

## Backend

Install dependencies:

```bash
cd ~/src/openvibe-source/backend
npm install
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

Run PostgreSQL and migrate:

```bash
cd ~/src/openvibe-source
tools/dev-db-up.sh
cd backend
npm run migrate
```

Run API:

```bash
cd ~/src/openvibe-source/backend
npm run dev
```

Smoke API:

```bash
cd ~/src/openvibe-source
node tools/smoke-api.mjs
```

## Maps

Generate editable VMFs:

```bash
cd ~/src/openvibe-source
node tools/generate-dev-vmfs.mjs
```

Compile all starter maps through Wine/TF2 tools:

```bash
tools/compile-dev-maps-wine.sh
```

Compiled BSPs are written to:

```text
game/openvibe.games/maps/
```

## Hammer++

Hammer++ is currently launched through Steam as a non-Steam game using Proton Experimental. The repo also has direct Wine launchers:

```bash
tools/run-hammerpp.sh
tools/run-hammerpp-wined3d.sh
```

Recommended Hammer++ paths:

```text
Game directory:
Z:\home\workstation\src\openvibe-source\game\openvibe.games

VMF directory:
Z:\home\workstation\src\openvibe-source\hammer\vmf

Map output:
Z:\home\workstation\src\openvibe-source\game\openvibe.games\maps
```

## Source Binaries

OpenVibe keeps its custom Source SDK patch sources in `sdk/openvibe/` so the large Valve SDK checkout can stay local and ignored. Apply and build the patch with:

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
```

That script:

1. Copies the tracked OpenVibe C++ files into `engine/source-sdk-2013/src/game/...`.
2. Patches the HL2MP client/server VPC files.
3. Builds the Linux64 client/server game DLLs through the Source SDK Steam Runtime container.

Stage the compiled DLLs into the OpenVibe mod folder:

Run:

```bash
cd ~/src/openvibe-source
tools/setup-openvibe-bin.sh
```

This links:

```text
engine/source-sdk-2013/game/mod_hl2mp/bin/linux64/client.so
engine/source-sdk-2013/game/mod_hl2mp/bin/linux64/server.so
```

into:

```text
game/openvibe.games/bin/linux64/client.so
game/openvibe.games/bin/linux64/server.so
game/openvibe.games/bin/linux64/client_srv.so
game/openvibe.games/bin/linux64/server_srv.so
```

The `_srv` compatibility links are required by the TF2-branch Linux64 SRCDS runtime.

## SRCDS

The Source SDK Base 2013 Dedicated Server install at `/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Dedicated Server` contains Windows server binaries in this environment. The current SDK build outputs Linux64 game DLLs, so OpenVibe uses Team Fortress 2 Dedicated Server AppID `232250`, which provides `srcds_linux64`.

Installed location:

```text
~/srcds/tf2
```

Smoke all local maps:

```bash
cd ~/src/openvibe-source
tools/smoke-srcds.sh
```

Run hub:

```bash
cd ~/src/openvibe-source
tools/run-hub.sh
```

Run a mode server:

```bash
tools/run-prophunt.sh
tools/run-deathrun.sh
tools/run-fortwars.sh
tools/run-traitortown.sh
```

Full local stack:

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh
```

Stop everything:

```bash
cd ~/src/openvibe-source
tools/dev-down.sh
```
