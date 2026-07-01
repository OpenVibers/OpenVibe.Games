# OpenVibe: Source Quick Reference

## Key Paths

```text
game/openvibe.games/                 Source mod folder
sdk/openvibe/                        Tracked OpenVibe C++ patch sources
engine/source-sdk-2013/              Local ignored Valve SDK checkout
backend/                             Fastify API
hammer/vmf/                          Editable VMF maps
game/openvibe.games/maps/            Compiled BSP maps
infra/                               Local and production infra templates
tools/                               Build, run, smoke, and map tools
```

## Build

```bash
cd ~/src/openvibe-source/backend
npm run build
npm test
```

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
```

## Run Locally

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh
```

Stop:

```bash
cd ~/src/openvibe-source
tools/dev-down.sh
```

## Smoke Tests

```bash
cd ~/src/openvibe-source
node tools/smoke-api.mjs
OPENVIBE_SRCDS_MAP_DELAY=3 OPENVIBE_SRCDS_SMOKE_TIMEOUT=45 tools/smoke-srcds.sh
```

Expected SRCDS output:

```text
[srcds:hub] ok (ov_hub)
[srcds:prophunt] ok (ph_openvibe_dev)
[srcds:deathrun] ok (dr_openvibe_dev)
[srcds:fortwars] ok (fw_openvibe_dev)
[srcds:traitortown] ok (tt_openvibe_dev)
```

## Maps

```bash
cd ~/src/openvibe-source
node tools/generate-dev-vmfs.mjs
tools/compile-dev-maps-wine.sh
```

Portal pads currently emit direct local connects for the Proton fallback:

```text
connect 127.0.0.1:27015
connect 127.0.0.2:27016
connect 127.0.0.3:27017
connect 127.0.0.4:27018
connect 127.0.0.5:27019
```

Set `OPENVIBE_USE_OV_JOIN=1` before regenerating VMFs to bake authenticated `ov_join <mode>` portal commands for a rebuilt custom client DLL.

## Client / Server Commands

| Command | Side | Purpose |
| --- | --- | --- |
| `ov_join <mode>` | Client | Request travel token and connect to server. |
| `ov_auth_steam` | Client | Send Steam Web API ticket to backend auth. |
| `openvibe_menu` / `ov_menu` | Client | Open OpenVibe VGUI menu. |
| `ov_open_url <url>` | Client | Open OpenVibe web page in Steam/browser. |
| `ov_prophunt_disguise <model>` | Server | Apply allowlisted prop disguise. |
| `ov_prophunt_reset_disguise` | Server | Restore player model. |
| `ov_fortwars_spawn <type>` | Server | Spawn allowlisted build prop. |

## API

```bash
curl -s http://127.0.0.1:3000/health | jq
curl -s http://127.0.0.1:3000/v1/servers | jq
curl -s http://127.0.0.1:3000/v1/assets/manifest | jq
curl -s http://127.0.0.1:3000/metrics
```

Travel request:

```bash
curl -s http://127.0.0.1:3000/v1/travel/request \
  -H 'Content-Type: application/json' \
  -d '{"steamId":"76561198000000000","mode":"prophunt"}' | jq
```

## SRCDS Runtime

The working local Linux64 runtime is:

```text
~/srcds/tf2
```

The installed Source SDK Base 2013 Dedicated Server directory in `/mnt/6tb/...` contains Windows server binaries in this environment, so it is not used for the Linux64 smoke tests.

## Production Values

Set these before real deployment:

```text
DATABASE_URL
SESSION_REDIS_URL
STEAM_WEB_API_KEY
STEAM_APP_ID
OPENVIBE_ADMIN_SECRET
OPENVIBE_CDN_BASE_URL
```

## Backup

```bash
cd ~/src/openvibe-source
tools/backup-postgres.sh
```

## Common Fixes

| Issue | Fix |
| --- | --- |
| API port still busy | `tools/dev-down.sh`, then check for leftover OpenVibe processes. |
| Server says map missing | Re-run `tools/compile-dev-maps-wine.sh`. |
| Game DLLs stale | Run `tools/build-sdk-linux.sh` then `tools/setup-openvibe-bin.sh`. |
| Hammer++ launch fails in Lutris | Use Steam non-game entry with Proton Experimental. |
| Steam auth returns 501 | Set `STEAM_WEB_API_KEY` and `STEAM_APP_ID`. |
