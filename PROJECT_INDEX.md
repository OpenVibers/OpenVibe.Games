# OpenVibe: Source Project Index

## Identity

- Game title: **OpenVibe: Source**
- Public domain: **OpenVibe.Games**
- Source mod folder: `game/openvibe.games`
- Repository root: `~/src/openvibe-source`

## Repository Map

```text
openvibe-source/
├── README.md                         Main overview and run instructions
├── DEPLOYMENT_STATUS.md              Current local/production status
├── QUICK_REFERENCE.md                Short command reference
├── LINUX_SETUP.md                    Linux-first setup notes
├── backend/                          OpenVibe.Games API
├── docs/                             Architecture and implementation notes
├── engine/                           Ignored local Valve SDK checkout
├── game/openvibe.games/              Source mod content
├── hammer/vmf/                       Editable Hammer maps
├── infra/                            Compose, Swarm, Kubernetes, CDN config
├── launcher/                         Desktop launcher shell
├── sdk/openvibe/                     Tracked C++ GameDLL patch sources
└── tools/                            Build/run/smoke/map tooling
```

## Implemented Systems

| Area | Status | Key files |
| --- | --- | --- |
| Backend API | Implemented | `backend/src/app.ts`, `backend/src/repository-pg.ts`, `backend/src/sessions.ts` |
| Backend tests | Passing | `backend/src/app.test.ts` |
| Steam auth route | Implemented | `POST /v1/auth/steam`; requires production Steam env vars |
| Redis sessions | Implemented | `backend/src/sessions.ts` |
| CDN asset manifest | Implemented | `GET /v1/assets/manifest` |
| C++ client travel | Implemented | `sdk/openvibe/client/hl2mp/openvibe_client.cpp` |
| C++ main menu | Implemented | `sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp`, `game/openvibe.games/resource/GameMenu.res` |
| C++ server validation | Implemented | `sdk/openvibe/server/hl2mp/openvibe_server.cpp` |
| Prop Hunt disguise | Implemented | `ov_prophunt_disguise`, `ov_prophunt_reset_disguise` |
| Fort Wars placement | Implemented | `ov_fortwars_spawn` |
| VScript game modes | Implemented prototypes | `game/openvibe.games/scripts/vscripts/ov_*.nut` |
| Maps | Compiled | `game/openvibe.games/maps/*.bsp` |
| Production infra | Scaffolded | `infra/docker-compose.yml`, `infra/production/docker-stack.yml`, `infra/kubernetes/openvibe.yaml` |

## Game Modes

| Mode | Map | Port | Join command |
| --- | --- | ---: | --- |
| Hub | `ov_hub` | 27015 | `ov_join hub` |
| Prop Hunt | `ph_openvibe_dev` | 27016 | `ov_join prophunt` |
| Deathrun | `dr_openvibe_dev` | 27017 | `ov_join deathrun` |
| Fort Wars | `fw_openvibe_dev` | 27018 | `ov_join fortwars` |
| Traitor Town | `tt_openvibe_dev` | 27019 | `ov_join traitortown` |

## Build And Test

Backend:

```bash
cd ~/src/openvibe-source/backend
npm run build
npm test
```

Source SDK:

```bash
cd ~/src/openvibe-source
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
```

SRCDS:

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 OPENVIBE_SRCDS_SMOKE_TIMEOUT=45 tools/smoke-srcds.sh
```

Full stack:

```bash
cd ~/src/openvibe-source
OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh
node tools/smoke-api.mjs
tools/dev-down.sh
```

## Verified On June 28, 2026

- Backend TypeScript build passed.
- Backend Vitest suite passed: 9 tests.
- Source SDK 2013 Linux64 build passed with OpenVibe C++ patch applied.
- SRCDS smoke test passed for all five maps.
- Full dev stack registered all five servers and returned valid travel targets for every mode.

## Production Readiness

The local MVP foundation is operational. Public deployment still needs:

- real Steam app credentials
- hosted CDN storage for player models/trails
- production PostgreSQL/Redis with backups
- deployment secrets management
- metrics/logging/alerts
- expanded game mode content and moderation tools
