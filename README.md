# OpenVibe: Source

Linux-first Source SDK 2013 multiplayer project for **OpenVibe: Source**.

- Public identity: `OpenVibe.Games`
- Source mod folder: `game/openvibe.games`
- Backend/API: `backend/`
- Tracked OpenVibe C++ patch sources: `sdk/openvibe/`
- VScript game logic: `game/openvibe.games/scripts/vscripts/`
- Editable maps: `hammer/vmf/`
- Compiled maps: `game/openvibe.games/maps/`
- API bridge sidecar: `tools/ov-sidecar.mjs`

## Current State

Implemented and tested locally:

- **Backend API** - Fastify/TypeScript with dev auth, Steam Web API ticket auth, player profiles, shop, inventory, server registry, travel tokens, match rewards, leaderboard, admin shop management, CDN asset manifest, and optional Redis-backed sessions.
- **Database** - PostgreSQL migrations for players, inventory, shop, servers, join tokens, currency ledger, and match results.
- **C++ GameDLL patch** - tracked in `sdk/openvibe/` and applied into the local Valve SDK checkout with `tools/apply-openvibe-sdk.sh`.
- **Authenticated travel** - `ov_join <mode>` requests `/v1/travel/request`, stores a join token in userinfo, and connects to the selected server.
- **Server-side arrival validation** - the destination server validates join tokens with `/v1/travel/validate`.
- **OpenVibe menu hooks** - VGUI commands `openvibe_menu` / `ov_menu` plus `resource/GameMenu.res` expose OpenVibe hub actions instead of relying on the stock server browser.
- **Prop Hunt C++ disguise command** - `ov_prophunt_disguise <model>` swaps the player to an allowlisted prop model; `ov_prophunt_reset_disguise` restores the player model.
- **Fort Wars C++ placement command** - `ov_fortwars_spawn <crate|barrel|fence|plate|concrete>` spawns allowlisted physics props during the build phase.
- **VScript game logic** - Squirrel scripts for hub, Prop Hunt, Deathrun, Fort Wars, and Traitor Town prototypes.
- **Portal maps** - generated VMFs and compiled BSPs use `ov_join` portals for hub/minigame travel.
- **Sidecars** - tail SRCDS logs and bridge `[OV]` events to the backend API.
- **Production infra skeleton** - Docker Compose, Docker Swarm stack, and Kubernetes manifests for API, PostgreSQL, Redis, and CDN/static assets.

Verified locally on June 28, 2026:

- `backend`: TypeScript build passes.
- `backend`: 9 Vitest tests pass.
- Source SDK 2013 Linux64 build passes with the OpenVibe C++ patch applied.
- SRCDS smoke test passes for all five maps: `ov_hub`, `ph_openvibe_dev`, `dr_openvibe_dev`, `fw_openvibe_dev`, `tt_openvibe_dev`.
- Full dev stack registers all five servers and returns travel targets for hub, Prop Hunt, Deathrun, Fort Wars, and Traitor Town.

## Commands

| Command | Side | Purpose |
| --- | --- | --- |
| `ov_join <mode>` | Client | Requests backend travel, stores join token, connects to target server. |
| `ov_auth_steam` | Client | Requests a Steam Web API ticket and posts it to `/v1/auth/steam`. |
| `openvibe_menu` / `ov_menu` | Client | Opens the OpenVibe VGUI hub menu. |
| `ov_open_url <url>` | Client | Opens OpenVibe web surfaces such as auth/inventory in Steam overlay/browser. |
| `ov_prophunt_disguise <model>` | Server | Applies allowlisted Prop Hunt disguise model. |
| `ov_prophunt_reset_disguise` | Server | Restores the normal player model. |
| `ov_fortwars_spawn <type>` | Server | Spawns allowlisted Fort Wars build props. |

## Quick Start

### Backend

```bash
cd ~/src/openvibe-source/backend
npm install
npm run build
npm test
```

### Build Source SDK GameDLLs

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
```

`tools/build-sdk-linux.sh` applies `sdk/openvibe/` into `engine/source-sdk-2013/`, patches the VPC files, and builds the HL2MP client/server Linux64 game DLLs.

### Full Dev Stack

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh
```

This starts:

- PostgreSQL
- OpenVibe API
- Hub SRCDS
- Prop Hunt SRCDS
- Deathrun SRCDS
- Fort Wars SRCDS
- Traitor Town SRCDS
- one sidecar per server

Stop everything:

```bash
cd ~/src/openvibe-source
tools/dev-down.sh
```

### Smoke Tests

```bash
cd ~/src/openvibe-source
node tools/smoke-api.mjs
OPENVIBE_SRCDS_MAP_DELAY=3 OPENVIBE_SRCDS_SMOKE_TIMEOUT=45 tools/smoke-srcds.sh
```

### Maps

```bash
cd ~/src/openvibe-source
node tools/generate-dev-vmfs.mjs
tools/compile-dev-maps-wine.sh
```

Hammer++ is currently launched as a non-Steam game with Proton Experimental. The repo also keeps direct Wine launchers:

```bash
tools/run-hammerpp.sh
tools/run-hammerpp-wined3d.sh
```

Recommended Hammer++ paths through Wine:

```text
Game directory:
Z:\home\workstation\src\openvibe-source\game\openvibe.games

VMF directory:
Z:\home\workstation\src\openvibe-source\hammer\vmf

Map output:
Z:\home\workstation\src\openvibe-source\game\openvibe.games\maps
```

## Dedicated Server Runtime

The installed Source SDK Base 2013 Dedicated Server path:

```text
/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Dedicated Server
```

contains Windows server binaries in this environment. The working local Linux64 runtime is the TF2 dedicated server install at:

```text
~/srcds/tf2
```

`tools/run-server.sh` defaults to `~/srcds/tf2` and uses the OpenVibe mod directory at `game/openvibe.games`.

## Architecture

```text
Source client
  -> OpenVibe VGUI menu / launcher
  -> Steam auth ticket or dev auth
  -> OpenVibe.Games API
  -> Hub SRCDS
  -> ov_join portal pads
  -> Minigame SRCDS shards

OpenVibe.Games API
  -> PostgreSQL for durable game data
  -> Redis for sessions when configured
  -> CDN/static asset manifest for cosmetics
```

Gameplay remains Source-style authoritative SRCDS instances. The MMO-style part is the shared OpenVibe.Games account, inventory, currency, travel, and server orchestration layer.

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/v1/auth/dev` | Local dev auth |
| `POST` | `/v1/auth/steam` | Steam Web API ticket auth |
| `GET` | `/v1/me?steamId=` | Player profile + inventory + shop |
| `GET` | `/v1/shop` | Shop catalog |
| `GET` | `/v1/assets/manifest` | CDN-backed cosmetic asset manifest |
| `POST` | `/v1/shop/buy` | Purchase item |
| `POST` | `/v1/equip` | Equip owned item |
| `GET` | `/v1/leaderboard` | Top players by XP |
| `POST` | `/v1/servers/register` | Register game server |
| `POST` | `/v1/servers/heartbeat` | Update server status |
| `GET` | `/v1/servers` | List live servers |
| `POST` | `/v1/travel/request` | Reserve travel token |
| `POST` | `/v1/travel/validate` | Consume travel token |
| `POST` | `/v1/matches/end` | Record match result + reward |
| `POST` | `/v1/admin/shop/items` | Admin: upsert shop item |

## Production Configuration

Production auth requires:

- `STEAM_WEB_API_KEY`
- `STEAM_APP_ID`
- `OPENVIBE_ADMIN_SECRET`
- `DATABASE_URL`
- `SESSION_REDIS_URL`
- `OPENVIBE_CDN_BASE_URL`

Infrastructure templates live in:

- `infra/docker-compose.yml`
- `infra/production/docker-stack.yml`
- `infra/kubernetes/openvibe.yaml`
- `infra/cdn/nginx.conf`

## Remaining Work

The foundation is running. The next real work is content and hardening:

- Replace dev models/trails with real OpenVibe cosmetic assets.
- Add real hosted CDN storage behind `openvibe.games`.
- Wire Steam production credentials and app identity.
- Add party travel, friend invites, and reservation capacity checks.
- Expand Prop Hunt, Deathrun, Fort Wars, and Traitor Town into full game rules.
- Add admin moderation, audit views, metrics, backups, and deployment secrets management.
