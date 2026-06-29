# OpenVibe: Source Deployment Status

**Last updated:** June 28, 2026
**Status:** Local MVP foundation operational

## What Runs Locally

- Backend API starts and responds on `http://127.0.0.1:3000`.
- PostgreSQL dev database starts through the repo tooling.
- Five SRCDS shards boot:
  - Hub: `ov_hub` on `27015`
  - Prop Hunt: `ph_openvibe_dev` on `27016`
  - Deathrun: `dr_openvibe_dev` on `27017`
  - Fort Wars: `fw_openvibe_dev` on `27018`
  - Traitor Town: `tt_openvibe_dev` on `27019`
- Sidecars register and heartbeat those servers with the backend.
- Travel requests return live local connect targets for every mode.
- Maps use `ov_join <mode>` portal commands instead of hardcoded connects.

## Implemented Pieces

| Component | Status | Notes |
| --- | --- | --- |
| Backend API | Complete for MVP | Dev auth, Steam ticket auth route, inventory, shop, travel, rewards, leaderboard, asset manifest. |
| PostgreSQL schema | Complete for MVP | Durable players, currency, inventory, servers, join tokens, match results. |
| Redis sessions | Implemented | Enabled when `SESSION_REDIS_URL` is set. |
| C++ client travel | Implemented | `ov_join <mode>` calls `/v1/travel/request` and connects with token. |
| C++ server validation | Implemented | Validates `ov_join_token` against `/v1/travel/validate`. |
| VGUI menu | Implemented | `openvibe_menu` / `ov_menu` plus `resource/GameMenu.res`. |
| Prop Hunt disguise | Implemented | Server-side allowlisted model swap/reset. |
| Fort Wars placement | Implemented | Server-side allowlisted physics prop spawning. |
| Steam auth | Implemented route | Requires real `STEAM_WEB_API_KEY` and `STEAM_APP_ID` for production. |
| CDN manifest | Implemented route | Requires real hosted storage under `openvibe.games` for production content. |
| Production infra | Scaffolded | Docker Compose, Docker Swarm, Kubernetes, nginx CDN config. |

## Verified

```bash
cd ~/src/openvibe-source/backend
npm run build
npm test
```

Result: TypeScript build passed, 9 tests passed.

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
OPENVIBE_SRCDS_MAP_DELAY=3 OPENVIBE_SRCDS_SMOKE_TIMEOUT=45 tools/smoke-srcds.sh
```

Result: Source SDK Linux64 build passed. SRCDS smoke test passed for all five maps.

Full stack was also tested with:

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh
node tools/smoke-api.mjs
tools/dev-down.sh
```

## Runtime Note

The installed Source SDK Base 2013 Dedicated Server directory provided by the user:

```text
/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation/steamapps/common/Source SDK Base 2013 Dedicated Server
```

contains Windows server binaries in this environment. OpenVibe local Linux testing uses the TF2 Linux64 SRCDS runtime at:

```text
~/srcds/tf2
```

## Production Gaps

Before public deployment:

- Configure real Steam app identity and `STEAM_WEB_API_KEY`.
- Host cosmetic assets under the `openvibe.games` CDN path.
- Set real production secrets for API, Redis, PostgreSQL, and admin routes.
- Add backups, metrics, health checks, log shipping, and deployment secret management.
- Expand each game mode from prototype rules into full production gameplay.
- Add moderation/admin UI and anti-abuse controls.
