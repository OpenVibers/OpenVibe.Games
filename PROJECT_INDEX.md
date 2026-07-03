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
| Session verification | Implemented | `GET /v1/auth/session` — Bearer-token validation with Redis |
| In-game Steam auth GUI | Implemented | `client/index.html` — embedded web UI served at `/client/`; `openvibe://auth/steam` + `openvibe://ready` bridge handlers |
| Redis sessions | Implemented | `backend/src/sessions.ts` |
| CDN asset manifest | Implemented | `GET /v1/assets/manifest` |
| C++ client travel | Implemented | `sdk/openvibe/client/hl2mp/openvibe_client.cpp` |
| C++ main menu | Implemented | `sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp`, `game/openvibe.games/resource/GameMenu.res` |
| C++ server validation | Implemented | `sdk/openvibe/server/hl2mp/openvibe_server.cpp` |
| Prop Hunt disguise | Implemented | `ov_prophunt_disguise`, `ov_prophunt_reset_disguise` |
| Fort Wars placement | Implemented | `ov_fortwars_spawn` |
| VScript game modes | Implemented prototypes | `game/openvibe.games/scripts/vscripts/ov_*.nut` |
| GModJS framework | Implemented | `game/openvibe.games/js/core/*` — hook/net/entity/ents/player/team/file/concommand/loader (GMod API shapes in JS); design in `docs/GMODJS_ARCHITECTURE.md`, guide in `docs/OPENVIBE_JS_SCRIPTING.md` |
| net library (JS) | Implemented | `js/core/net.js` — full GMod surface, pooling, chunked transport, per-player rate limits |
| Entity system (JS + native) | Implemented | `js/core/entity.js`, `js/core/ents.js`, `sdk/openvibe/shared/ov_js_entity.cpp` (`OV.entCreate`/`OV.entCall`); scripted entities in `js/entities/` |
| Client realm runtime | Implemented | `engine/openvibe-js-runtime/ov-runtime.js --realm client` + `sdk/openvibe/client/hl2mp/openvibe_js_client.cpp` |
| Script exec commands | Implemented | `js_run`, `js_openscript`, `js_run_cl`, `js_openscript_cl` (gated by `sv_allowcsjs`), `ov_npm` |
| AddCSJSFile + client sync | Implemented | `js/core/file.js` — manifest + net-based download into `js/ov_downloads/` |
| npm hotloading | Implemented | runtime control server `POST /npm`, `ov_npm`, fs.watch reload; `js/package.json` + `js/vendor/` |
| Unified GUI (launcher + in-game) | Implemented | `client/index.html` + `client/ui-sync.js` served to Electron (5173), backend (3000), and the CEF panel; routes incl. `console`, `options`, `hud` |
| In-game console + options GUI | Implemented | Console route (SSE logs, js_run/exec/npm), Options route (`openvibe://convar` bridge), HUD overlay (`OV_HudState`) |
| Script packages API | Implemented | `GET /v1/scripts/packages`, `GET /v1/scripts/packages/:id`, `GET /v1/scripts/packages/:id/files`, admin upsert/enable/disable routes |
| JS round system | Implemented | Base round state machine; Prop Hunt, Deathrun, Fort Wars, Traitor Town each with teams, timers, win conditions |
| Batch match rewards | Implemented | `POST /v1/matches/end/batch` — rewards multiple players in one idempotent call |
| C++ RoundStart/RoundEnd | Implemented | `OpenVibeJS_Server_RoundStart/End`, `ov_round_start`, `ov_round_end` ConCommands |
| Maps | Compiled | `game/openvibe.games/maps/*.bsp` |
| Production infra | Scaffolded | `infra/docker-compose.yml`, `infra/production/docker-stack.yml`, `infra/kubernetes/openvibe.yaml` |

## Game Modes

| Mode | Map | Local target | Authenticated command |
| --- | --- | --- | --- |
| Hub | `ov_hub` | `127.0.0.1:27015` | `ov_join hub` |
| Prop Hunt | `ph_openvibe_dev` | `127.0.0.2:27016` | `ov_join prophunt` |
| Deathrun | `dr_openvibe_dev` | `127.0.0.3:27017` | `ov_join deathrun` |
| Fort Wars | `fw_openvibe_dev` | `127.0.0.4:27018` | `ov_join fortwars` |
| Traitor Town | `tt_openvibe_dev` | `127.0.0.5:27019` | `ov_join traitortown` |

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

GModJS framework (no C++ build needed):

```bash
cd ~/src/openvibe-source
node tools/test-gmodjs.mjs        # 131-check suite: hooks/net/entities/players/files/gamemodes
node tools/smoke-js-core-node.mjs
node tools/smoke-js-gamemodes.mjs
node tools/smoke-runtime-ipc.mjs  # both Node runtimes over real TCP IPC
node tools/smoke-ui.mjs           # unified GUI serving + route markers
```

## Verified On July 2, 2026

- Backend TypeScript build passed; Vitest suite passed: 14 tests.
- Source SDK 2013 Linux64 build passed with the OpenVibe C++ patch incl. the
  GModJS additions (`ov_js_entity.cpp`, `js_run`/`js_openscript`/`ov_npm`,
  client runtime events, `openvibe://cmd|convar` bridge, console spew tap).
- SRCDS smoke passed for all five maps with the rebuilt server.so; the
  embedded QuickJS boots the full GModJS core (net/entity/player/team/file/
  concommand/loader + addons + npm require).
- Live SRCDS console test: `js_run` evaluated in-engine, `js_openscript`
  ran a script from `js/`, `ents.Create("ov_bouncy_crate")` spawned and was
  queryable via `ents.FindByClass`.
- GModJS suite: 131/131 checks; runtime IPC smoke and UI smoke passed.
- npm hotloading verified live: `POST /npm install is-odd` into the running
  runtime, then `require("is-odd")(7)` returned true without a restart.

## Production Readiness

The local MVP foundation is operational. Public deployment still needs:

- real Steam app credentials
- hosted CDN storage for player models/trails
- production PostgreSQL/Redis with backups
- deployment secrets management
- metrics/logging/alerts
- expanded game mode content and moderation tools
