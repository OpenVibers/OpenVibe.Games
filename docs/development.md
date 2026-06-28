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

The first OpenVibe binary staging uses the SDK HL2MP Linux64 output and compatibility links for TF2-branch dedicated server module names.

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

This is a temporary base until custom OpenVibe C++ code is added.

## SRCDS

The Source SDK Base 2013 Dedicated Server AppID `244310` installed, but its Linux depot only provided a 32-bit `srcds_linux` launcher in this environment. The current SDK build outputs Linux64 game DLLs, so OpenVibe uses Team Fortress 2 Dedicated Server AppID `232250`, which provides `srcds_linux64`.

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
