# OpenVibe: Source

Linux-first Source SDK 2013 multiplayer project for `OpenVibe: Source`.

- Public identity: `OpenVibe.Games`
- Source mod folder: `game/openvibe.games`
- Backend/API: `backend/`
- VScript game logic: `game/openvibe.games/scripts/vscripts/`
- Editable maps: `hammer/vmf/`
- Compiled maps: `game/openvibe.games/maps/`
- API bridge sidecar: `tools/ov-sidecar.mjs`

## Current State

### ✅ Implemented

- **Backend API** — Fastify/TypeScript with dev auth, player profiles, shop, inventory,
  server registry, travel tokens, match rewards, leaderboard, and admin shop management.
- **PostgreSQL migration** — players, inventory, shop, servers, join tokens, currency
  ledger, and match results.
- **In-memory repository** — fast local tests without a database.
- **6/6 backend tests** — vertical slices covering all major flows.
- **VScript game logic** — Squirrel scripts for all five servers:
  - `ov_shared.nut` — shared utilities, event emission protocol.
  - `ov_hub.nut` — hub heartbeat, portal pad labels, player join.
  - `ov_prophunt.nut` — role assignment, hide phase, hunt phase, rewards.
  - `ov_deathrun.nut` — activator vs. runners, trap system, finish line.
  - `ov_fortwars.nut` — two-team build phase → combat phase, kill tracking.
  - `ov_traitortown.nut` — role assignment (traitors / detective / innocents), win conditions.
- **Per-map auto-exec CFGs** — `cfg/<mapname>.cfg` automatically loads the VScript when the map starts.
- **Sidecar process** (`ov-sidecar.mjs`) — tails SRCDS log files, bridges `[OV]` events to the backend API (heartbeat, match rewards).
- **VMF generator updated** — `logic_script`, `game_text` HUD entities, team spawn points now in all generated maps.
- **Five compiled BSP maps** — hub + Prop Hunt, Deathrun, Fort Wars, Traitor Town.
- **Docker Compose** (`infra/docker-compose.yml`) — PostgreSQL + API service.
- **Localization** (`resource/openvibe_english.txt`) — English strings for all modes.
- **Particle manifest** — placeholder for trail particles.
- **Dev tools** — compile, run, register, and full dev orchestration scripts.

## Custom ConCommands (C++)

All game logic is driven by authenticated ConCommands:

| Command | Location | Purpose |
|---------|----------|---------|
| `ov_join <mode>` | `openvibe_travel.cpp` | Travel to hub, prophunt, deathrun, etc. |
| `ov_auth_ticket <ticket>` | `openvibe_steam_auth.cpp` | Authenticate player with Steam ticket |
| `ov_auth_confirm <token>` | `openvibe_steam_auth.cpp` | Confirm auth with backend token |
| `ov_prophunt_disguise <model>` | `openvibe_travel.cpp` | Swap player model to random prop |
| `ov_travel_complete` | `openvibe_travel.cpp` | Confirm successful travel |

**Files:**
- `engine/source-sdk-2013/src/game/server/hl2mp/openvibe_travel.cpp` (8.0 KB)
- `engine/source-sdk-2013/src/game/server/hl2mp/openvibe_steam_auth.cpp` (8.5 KB)

## Electron Launcher (HTML/CSS/JS)

A custom main menu replacing the stock HL2MP server browser:

**Features:**
- Portal tab with quick-join buttons for each game mode
- Live server list (hub, prophunt, deathrun, fortwars, traitortown)
- Leaderboard, inventory, and shop tabs
- Neon theme with Rajdhani + Orbitron fonts

**Files:**
- `launcher/main.js` — Electron main process + Proton spawning
- `launcher/renderer.js` — UI event handlers
- `launcher/index.html` — Portal, servers, leaderboard, inventory, shop tabs
- `launcher/styles.css` — Custom CSS (12 KB)
- `launcher/assets/` — Images and icons

**How it works:**
1. Launcher displays server list from `http://localhost:3000/api/servers`
2. User clicks "Join Hub" or a game mode
3. Launcher calls `bash tools/run-client-proton.sh <ip> <port>`
4. Proton launches Windows hl2.exe via Wine + Vulkan/DXVK
5. Game connects to server with auto-login from backend auth

## Quick Start

### Prerequisites
- Steam logged in with SDK Base 2013 Multiplayer installed
- GE-Proton10-34 (install via ProtonUp-Qt)
- Node.js 16+
- PostgreSQL 12+
- Wine (for BSP compilation)

### Backend (in-memory, no database needed)

```bash
cd ~/src/openvibe-source/backend
npm test         # 6 tests, should all pass
npm run build    # TypeScript compile
npm start        # Runs on http://localhost:3000
```

### Full dev stack (PostgreSQL + API + servers + sidecars)

```bash
cd ~/src/openvibe-source
tools/dev-up.sh   # starts: postgres → API → SRCDS × 5 → sidecar × 5 (via tmux)
```

Or step-by-step:

```bash
# 1. Start PostgreSQL
tools/dev-db-up.sh

# 2. Migrate and run API
cd backend && npm run migrate && npm run dev

# 3. Register servers with the API
cd .. && node tools/register-local-servers.mjs http://127.0.0.1:3000 servers/local-servers.json

# 4. Start a server (needs BSPs compiled)
tools/run-hub.sh
tools/run-prophunt.sh

# 5. Start sidecars (one per server)
tools/run-sidecar.sh local-hub-27015 hub 27015 48
tools/run-sidecar.sh local-prophunt-27016 prophunt 27016 24
```

### Smoke API

```bash
cd ~/src/openvibe-source && node tools/smoke-api.mjs
```

### Map workflow

```bash
# Regenerate VMFs (adds VScript entities, HUD text, team spawns)
node tools/generate-dev-vmfs.mjs

# Compile all maps via Wine + TF2 tools
tools/compile-dev-maps-wine.sh
```

### Client

```bash
tools/run-client.sh
```

### Hammer++

```bash
tools/run-hammerpp.sh       # Wine + D3D11
tools/run-hammerpp-wined3d.sh  # Wine + WineD3D fallback
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full service diagram.

### VScript event protocol

VScript prints `[OV]`-prefixed lines to the SRCDS console/log.
The sidecar (`tools/ov-sidecar.mjs`) tails the log file and routes events to the API.

| Event | Format | Action |
|-------|--------|--------|
| `BOOT` | `BOOT serverId mode` | register/re-register server |
| `HEARTBEAT` | `HEARTBEAT serverId count max state` | update server state |
| `REWARD` | `REWARD matchId serverId secret uid mode coins xp` | record match reward |
| `SAY` | `SAY message…` | log message |

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/auth/dev` | Dev player auth (local only) |
| `POST` | `/v1/auth/steam` | Steam auth (future) |
| `GET` | `/v1/me?steamId=` | Player profile + inventory + shop |
| `GET` | `/v1/shop` | Shop catalog |
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

## Next Steps

- **Custom C++ GameDLL** — implement `ov_join <mode>` ConCommand that calls `/v1/travel/request`,
  receives the connect string + token, and initiates a proper authenticated server connection.
- **Custom main menu** — VGUI panel or Panorama replacement that shows the OpenVibe hub selection
  screen instead of the stock HL2MP server browser.
- **Prop Hunt prop disguise** — C++ player model swap + scale for true prop disguise.
- **Fort Wars prop placement** — C++ `prop_physics` spawning for the build phase.
- **Steam auth** — integrate `ISteamUser::AuthenticateUserTicket` for production auth.
- **CDN / asset hosting** — serve player model and trail assets via openvibe.games CDN.
- **Production infra** — Kubernetes or Docker Swarm, persistent PostgreSQL, Redis for sessions.

