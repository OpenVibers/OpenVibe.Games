# Scraplandia

## Purpose

OpenVibe.Games: Scraplandia, served at https://openvibe.games and https://play.openvibe.games.
A persistent multiplayer physics sandbox for the browser: Source-style movement,
physgun-driven building from crafted physical objects, gathering, crafting, and
extraction risk — running against an authoritative dedicated server.

**Stack:** TypeScript everywhere · Babylon.js (WebGPU with WebGL fallback) ·
Rapier physics (`@dimforge/rapier3d-deterministic-compat`, one pinned build
headless on the server and in client prediction) ·
WebSocket protocol · PostgreSQL 18 + Valkey persistence (openvibe-sdk) · pnpm monorepo.

## Owns

- the game: the authoritative simulation, the world, characters, inventories, skills, blueprints and
  props, in PostgreSQL (ADR-0007 decision 5: schema from scratch, migrations under
  `packages/persistence/migrations`, a write-behind flusher — the tick never awaits I/O)
- the map editor and its assets, the mod registry (`games-content@1` packs, grants, audit) and the
  `games.*` events
- the game WebSocket protocol and the portal, `/play` and `/editor` pages

## Does not own

- identity (OpenVibe.Network: players are keyed by Network subjects), file storage beyond the local
  copy (OpenVibe.Media mirrors map-editor assets), events delivery (OpenVibe.Events)
- mod grants' authority (Network keeps them, `mods.grant.manage`) and executable mods (they wait for
  OpenVibe.Host Stage C)

## Depends on

- OpenVibe.Network (SSO, JWKS, client-credentials tokens, identity resolve, the `games.progress.summary`
  user module, mod grants), OpenVibe.Events (outbox relay, subscriptions), OpenVibe.Media (asset mirror)
- `openvibe-contracts` v0.77.0, `openvibe-sdk` v0.22.0 and `openvibe-shared` v1.30.1 (pinned by release
  tarball in `apps/server/package.json`), Babylon.js, Rapier, PostgreSQL (`pg`, or embedded PGlite in
  development), Valkey (`iovalkey`, optional)

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
  physics/       PhysicsWorld abstraction + Rapier adapter (@openvibe/physics/rapier)
  persistence/   DTOs, repository interfaces, PostgreSQL implementation, migrations
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

## Production

```bash
pnpm build
DATABASE_URL=postgres://… DATABASE_DIRECT_URL=postgres://… STATIC_DIR=apps/client/dist PORT=8000 pnpm --filter @openvibe/server start
```

`DATABASE_URL` (pooled, through PgBouncer) serves; migrations run at boot on `DATABASE_DIRECT_URL`
(the owner role, a direct session). With neither set and `NODE_ENV` not `production`, the server uses
an embedded PGlite database under `DATABASE_DIR` (default `data/`) — development only, one process.
`GAMES_PLACE_ID` (default `scraplandia`) is the place every world row belongs to; `VALKEY_URL`
(optional) makes the per-actor limits and the WebSocket upgrade tickets shared across instances
(issue is `SET … PX … NX`, consume is `GETDEL`, so a ticket is single-use cluster-wide).
`TRUST_PROXY` (optional) says which proxies may set the client-address headers: unset means the TCP
peer is the client and `X-Forwarded-For`/`X-Real-IP`/`CF-Connecting-IP` are ignored (they are
client-supplied and would otherwise let a caller mint fresh rate-limit buckets); `true` means the
server is only reachable through the proxy; otherwise a comma-separated list of trusted proxy
IPs/CIDRs (behind nginx, which sets `X-Real-IP` from `$remote_addr`). See [.env.example](.env.example).

The server serves the built client, `/healthz` (liveness), `/api/ready`, `/metrics`, and the game
WebSocket on one port. Pages are `/` (portal), `/play` and `/editor`; on play.openvibe.games `/` is
the game and `/play` redirects there. Any other path that is neither a file of the build nor a route
answers 404 (an HTML page with links to those pages; `{"error":"not_found"}` under `/api`; plain text
for a missing asset), never the portal with a 200. `/api/ready` is 200 only while the database answers a real round trip
(`db.ready()`) and the simulation
has ticked within the last 5 s, otherwise 503 naming the failed check (`status`
`ready`/`not_ready`, `checks.db`, `checks.tick`); nginx keeps it off the public vhosts. Environment: `PORT`, `HOST`, `STATIC_DIR`,
`MAX_PLAYERS`, `LOG_LEVEL`, `GAMES_PLACE_ID`, the database variables above (platform variables below).

Deployed at https://openvibe.games (nginx TLS termination → server on 127.0.0.1:8000,
systemd unit `openvibe-games.service` from [deploy/openvibe-games.service](deploy/openvibe-games.service),
env file `/etc/openvibe/games.env` (which holds `DATABASE_URL`, `DATABASE_DIRECT_URL` and `VALKEY_URL`);
play.openvibe.games Host-routes to the same process).

Deploy on the host with `sudo /opt/openvibe.games/deploy/scripts/deploy.sh`, which runs
`ovhost deploy games` (OpenVibe.Host, strategy `pnpm-build`; roadmap WS-N task 11): a fast-forward pull as
the checkout owner, `pnpm install --frozen-lockfile`, every workspace package's dependencies checked, `pnpm build`,
the restart (the SDK migrator applies any new migration as the owner before serving), `/api/ready`, and on failure the checkout
restored, reinstalled and rebuilt and the server restarted again. Players online are reported and
reconnect; `--wait-idle` holds the restart until nobody plays, `--rollback` runs `ovhost rollback games`,
`DRY_RUN=1` prints `ovhost plan games`. Do not pull by hand first (ovhost would find nothing new; pass
`--restart` if you did). When ovhost is missing, too old or does not deploy Games with that strategy, the
wrapper runs `deploy/scripts/deploy-legacy.sh`: the procedure as it was run by hand
(`sudo git -c safe.directory=/opt/openvibe.games pull`, `pnpm install --frozen-lockfile`, `pnpm build`,
`sudo systemctl restart openvibe-games`).

Rollback: `sudo deploy/scripts/deploy.sh --rollback` (`ovhost rollback games`), which rebuilds the previous
commit. Migrations are additive and applied at boot, so an older build starts on the newer schema; the SDK
migrator refuses a migration file that was edited after it ran (write a new one instead).

## Platform integration (OpenVibe network)

Games integrates with the rest of OpenVibe at its service boundary only
(`apps/server/src/platform`, `apps/server/src/mods`); the simulation packages
do not know the platform exists. See [ADR-0006](docs/adr/0006-canonical-subjects-and-platform-boundary.md).

- **Identity.** Signed-in players are keyed by their canonical
  openvibe.network subject (`usr_…`/`gst_…`, the token's `subject_id`); a
  token without one cannot name an account. Guest tokens that look like
  account keys (`usr_…`) are refused.
- **Service principal.** Calls to Events, Media and Network identity carry a
  client-credentials token of the `games` OAuth client (same client id and
  secret as SSO), one per audience. There are no shared keys. The SSO calls
  made for a player (`/api/auth/me`, code and FedCM exchanges) keep using the
  player's own token.
- **Events** (OpenVibe.Events, through a transactional outbox in
  PostgreSQL, table `event_outbox`): `games.player.joined|left`,
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
  `mods.mod-manifest@1.1.0` (Games validates against the schema in the
  installed `openvibe-contracts` package — pin drift is a defect, ADR-0007
  decision 12 — currently v0.77.0). The only runtime today is `games-content@1`:
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
- **Shared chrome.** The portal, `/play` and `/editor` load the OpenVibe Frame
  (navbar, footer, theme loader) from this server's own pinned copy at `/shared/`
  (`apps/server/src/net/sharedAssets.ts`), so they keep their frame while Network is down.
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

## Capabilities

Implemented here (the service manifest's `capabilities`): `games.mod.manage` and `games.mod.read` (the
mods API, for a principal token or an owner/admin session), and `games.world.announce` and
`games.prop.place`, the capabilities a mod install may be granted and every runtime binding checks at
call time.

Grants the `games` principal needs in OpenVibe.Network:
`events.event.publish` and `events.subscription.manage` (openvibe.events: the outbox, and the account,
revocation and mod-grant subscriptions), `media.object.upload`
(openvibe.media, namespace `games`), `identity.subject.resolve`
(openvibe.network), `network.modules.write` on `games.progress.summary`, and `mods.grant.manage`
(Network's mod grants, roadmap WS-M task 3).

## Tests

`pnpm test` runs every vitest file (unit tests of the packages and the server, including
`apps/server/src/game/platformIntegration.test.ts`, which boots the real server twice on one database);
`pnpm typecheck` and `pnpm lint` keep strict TypeScript and no `any`;
`tsx apps/server/scripts/sliceTest.ts` drives protocol clients against a real server across a restart.

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The server is authoritative: inbound protocol
messages are validated (zod), the WebSocket has per-socket flood control, and HTTP writes that cross a
capability boundary (editor saves and uploads, the mods API) have per-actor limits (openvibe-sdk/limits).
Players are keyed by Network subjects; guest tokens that look like account keys are refused. Mods are
declarative only, each install keeps only its approved capabilities, and executable mods are refused.
nginx keeps `/api/ready` off the public vhosts and `/metrics` answers direct loopback callers only. `OV_OAUTH_CLIENT_SECRET`, `GAMES_EVENTS_SECRET` (signed
Events deliveries) and `OV_NETWORK_AUTH_URL` live in `/etc/openvibe/games.env`, by name only; there are no shared keys
between services.
