# Scraplandia

A persistent multiplayer physics sandbox for the browser: Source-style movement,
physgun-driven building from crafted physical objects, gathering, crafting, and
extraction risk — running against an authoritative dedicated server.

**Stack:** TypeScript everywhere · Babylon.js (WebGPU with WebGL fallback) ·
Havok physics (Babylon Physics V2, headless on the server via NullEngine) ·
WebSocket protocol · SQLite persistence · pnpm monorepo.

## Repository layout

```
apps/
  client/        Browser client: rendering, prediction, input, HUD
  server/        Dedicated authoritative server: simulation, networking, persistence
packages/
  shared/        Math, ids, events, logging facade, fixed-timestep primitives
  protocol/      Versioned wire messages + codec (zod-validated inbound)
  content/       Data-driven item/recipe/world definitions + validation registry
  gameplay/      Pure domain logic: inventory, crafting, movement sim, zones, entities
  physics/       PhysicsWorld abstraction + Havok adapter (@openvibe/physics/havok)
  persistence/   DTOs, repository interfaces, SQLite implementation
docs/adr/        Architecture decision records
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and data flow,
[ROADMAP.md](ROADMAP.md) for what exists and what is planned.

## Prerequisites

- Node.js >= 22
- pnpm 10 (`corepack enable`)

## Development

```bash
pnpm install

# Terminal 1 — authoritative server on :8000 (tsx watch)
pnpm dev:server

# Terminal 2 — client with hot reload on :5173 (proxies /ws to :8000)
pnpm dev:client
```

Open http://localhost:5173 in two browser windows to see multiplayer.

**Controls:** WASD move · Space jump (hold to bunnyhop) · Shift sprint ·
1-6 hotbar · Tab menu (inventory / crafting / skills / players) · G drop
held item · E gather / pick up props.
**Physgun (GMod-style):** hold LMB grab (grabbing a frozen prop unfreezes
it) · release to let go · RMB freeze · wheel push/pull · hold E rotate
like a globe (Shift+E snaps) · hold Shift for grid-lock.
**Building:** craft pieces → drop them (G or drag out of the inventory) →
position with the physgun → freeze. Dropping IS placement; E picks any
prop back up into your inventory.

**The loop:** spawn in Scrap City (safe city — no PvP, no building, no
physgun), gather branches/stones/scrap outside the gates, craft tools,
harvest the forest (axe/woodcutting) and quarry (pickaxe/mining), craft
building pieces, place them in the wilds, position with the physgun and
freeze. Props are protected: only you and players you trust can move them.

## Commands

| Command                                 | Purpose                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                              | Server + client dev processes in parallel                                                                    |
| `pnpm test`                             | All unit tests (vitest)                                                                                      |
| `pnpm typecheck`                        | Strict TypeScript across every package                                                                       |
| `pnpm lint`                             | ESLint (typescript-eslint, no-explicit-any)                                                                  |
| `pnpm format`                           | Prettier write                                                                                               |
| `pnpm build`                            | Production build of all packages + client bundle                                                             |
| `tsx apps/server/scripts/sliceTest.ts`  | End-to-end vertical-slice test (boots a real server, drives protocol clients, restarts, asserts persistence) |
| `tsx packages/physics/scripts/smoke.ts` | Headless Havok smoke test                                                                                    |

## Production

```bash
pnpm build
STATIC_DIR=apps/client/dist PORT=8000 DB_PATH=data/world.db pnpm --filter @openvibe/server start
```

The server serves the built client, `/healthz` (liveness), `/api/ready`, `/metrics`, and the game
WebSocket on one port. Pages are `/` (portal), `/play` and `/editor`; on play.openvibe.games `/` is
the game and `/play` redirects there. `/game` and `/canvas` (the URLs from when the game lived on
OpenVibe.Live) redirect to `/play` and `/`. Any other path that is neither a file of the build nor a route
answers 404 (an HTML page with links to those pages; `{"error":"not_found"}` under `/api`; plain text
for a missing asset), never the portal with a 200. `/api/ready` is 200 only while `world.db` answers a query and the simulation
has ticked within the last 5 s, otherwise 503 naming the failed check (`status`
`ready`/`not_ready`, `checks.db`, `checks.tick`); nginx keeps it off the public vhosts. Environment: `PORT`, `HOST`, `DB_PATH`, `STATIC_DIR`,
`MAX_PLAYERS`, `LOG_LEVEL` (platform variables below).

Deployed at https://openvibe.games (nginx TLS termination → server on :8000,
systemd unit `openvibe-games.service`; play.openvibe.games Host-routes to the same process).

## Platform integration (OpenVibe network)

Games integrates with the rest of OpenVibe at its service boundary only
(`apps/server/src/platform`, `apps/server/src/mods`); the simulation packages
do not know the platform exists. See [ADR-0006](docs/adr/0006-canonical-subjects-and-platform-boundary.md).

- **Identity.** Signed-in players are keyed by their canonical
  openvibe.network subject (`usr_…`/`gst_…`, the token's `subject_id`).
  Characters created under the old `ovn:<network id>` key are adopted on the
  next sign-in, or in bulk with `apps/server/scripts/migrateIdentity.ts`
  (`--dry-run` first). Guest tokens that look like account keys (`ovn:…`, `usr_…`) are refused.
- **Service principal.** Calls to Events, Media and Network identity carry a
  client-credentials token of the `games` OAuth client (same client id and
  secret as SSO), one per audience. There are no shared keys. The SSO calls
  made for a player (`/api/auth/me`, code and FedCM exchanges) keep using the
  player's own token.
- **Events** (OpenVibe.Events, through a transactional outbox in
  `world.db`, table `event_outbox`): `games.player.joined|left`,
  `games.skill.leveled`, `games.blueprint.unlocked`, `games.world.saved`
  (at most one checkpoint per `WORLD_SAVED_EVENT_MINUTES`, plus shutdown) and
  `games.mod.installed|enabled|disabled|grants_changed|revoked`. There is no
  achievement system in Scraplandia, so there are no achievement events.
  Progression events come from what a save actually wrote, in the same
  transaction.
- **Media.** Map-editor assets (textures, paint masks, glb models; the only
  uploaded files Games has) are still served from local disk and are also
  copied into Media objects (`kind: asset`, namespace `MEDIA_NAMESPACE`), with
  a restart-safe queue (`media_mirrors`). There are no screenshots or blueprint
  files to upload: blueprints are per-player recipe unlocks.
- **Mods** (ADR-013 in OpenVibe.Contracts). Manifests follow
  `mods/mod-manifest.v1` (published in OpenVibe.Contracts v0.14.0; Games
  validates with its own copy in `apps/server/src/mods/manifestSchema.ts`,
  because it pins openvibe-contracts v0.8.0). The only runtime today is `games-content@1`:
  declarative data packs checked against `@openvibe/content` (announcements;
  inert, mod-owned props). Each install stores the approved subset of its
  requested capabilities; every runtime binding checks it at call time, a
  revoked install or capability stops affecting the world on the next tick,
  and install/grant/use/deny/revoke are audited (`mod_audit`). Trust tiers are
  metadata only. Executable mods (scripts) are refused until sandboxed
  execution exists in OpenVibe.Host (Stage C). API: `GET /api/v1/mods`,
  `GET /api/v1/mods/:id` (public); `POST /api/v1/mods`,
  `POST /api/v1/mods/:id/enable|disable|revoke|grants`,
  `DELETE /api/v1/mods/:id/grants/:capability`, `GET /api/v1/mods/:id/audit`
  (owner/admin session, or a principal token with `games.mod.manage`).
- **Status:** `GET /api/v1/platform` reports whether events and the Media
  mirror are on, the outbox backlog and mirror counts (no secrets).
- **In production (2026-09-23, release `f11e21c`):** events and the Media
  mirror are on. `games.world.saved` events reach OpenVibe.Events; no mod is
  installed, no grant exists and no asset has been mirrored to Media yet.
  Player progress and canvas rows from Live's old HoboQuest tables have not
  been imported yet. The decisions, the importer
  (`apps/server/scripts/importLiveLegacy.ts`, dry run by default) and the
  host commands are in [docs/legacy-import.md](docs/legacy-import.md).
- **Shared chrome.** The portal, `/play` and `/editor` load the network
  navbar and footer from `https://openvibe.network/shared/`.
- **Persistence proof.** `apps/server/src/game/platformIntegration.test.ts`
  boots the real server twice on one database and checks characters, world
  props, the world clock and the mod registry survive the restart;
  `sliceTest.ts` covers the gameplay state end to end.

Platform environment (all optional; unset = off):

| Variable                    | Purpose                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `OV_OAUTH_CLIENT_ID`        | OAuth client / principal id (default `games`)                                         |
| `OV_OAUTH_CLIENT_SECRET`    | Its secret: enables SSO and every service call                                        |
| `OV_NETWORK_INTERNAL_URL`   | Network base for `/oauth/token`, identity and the JWKS (e.g. `http://127.0.0.1:4000`) |
| `EVENTS_URL`                | OpenVibe.Events base; enables the outbox (`EVENTS_PUBLISH=off` disables)              |
| `MEDIA_URL`                 | OpenVibe.Media base; enables the asset mirror (`MEDIA_MIRROR=off` disables)           |
| `MEDIA_NAMESPACE`           | Media tenant for the copies (default `games`)                                         |
| `WORLD_SAVED_EVENT_MINUTES` | Checkpoint event interval (default 15)                                                |

Grants the `games` principal needs in OpenVibe.Network:
`events.event.publish` (openvibe.events), `media.object.upload`
(openvibe.media, namespace `games`), `identity.subject.resolve`
(openvibe.network).
