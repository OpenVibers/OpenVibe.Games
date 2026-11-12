# AGENTS.md — OpenVibe.Games

## Project Overview

OpenVibe.Games hosts the browser games at `openvibe.games` and `play.openvibe.games`: **Scraplandia** (a persistent
multiplayer physics sandbox with the scored "Haul" mode), **Salvage Rush** (on-foot timed collection),
**creator worlds** (map editor + `/worlds`, sandboxed), the casual line (plan T22, starting with **Vibe Heroes**),
server-run AI draft matches/Bench scoring, and the moved **OpenVibe.Play player pages** (`/achievements`,
`/leaderboards`, `/developers`) which read Play's public API server-side.

- **Domain:** `openvibe.games`, `play.openvibe.games` · **Port:** 8000 (server; Vite dev client 5173) ·
  **Service id:** `games` · **Env prefix:** `GAMES`/`OV_`
- **Stack:** TypeScript everywhere, pnpm 10 monorepo, Babylon.js (WebGPU/WebGL) client, Rapier
  `@dimforge/rapier3d-deterministic-compat` (one pinned build headless on server and in client prediction), WS
  protocol, PostgreSQL 18 + Valkey through `openvibe-sdk`, QuickJS for script mods.
- **Read first:** [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md),
  [docs/games.md](docs/games.md), [docs/casual.md](docs/casual.md), [docs/mods.md](docs/mods.md),
  [docs/instances.md](docs/instances.md), [docs/ai-matches.md](docs/ai-matches.md), [ADR-0007](docs/adr/), [ADR-0013](docs/adr/).

**Network context:** players are keyed by Network `subject_id` (`usr_…`/`gst_…`); SSO/JWKS/identity/mod grants are
OpenVibe.Network. Events are OpenVibe.Events (transactional outbox). Achievements/scores go to OpenVibe.Play's API;
six built-in achievements grant Live items through OpenVibe.Inventory. Map-editor assets are also copied to
OpenVibe.Media objects. Mod grants' authority is Network (`mods.grant.manage`); Games runs its own bounded
`games-quickjs@1` scripts. The platform boundary is `apps/server/src/platform` and `apps/server/src/mods`; the
simulation packages do not know the platform exists.

## Commands

```bash
corepack enable && pnpm install          # Node ≥22, pnpm 10.6.5
pnpm dev                                 # server + client dev in parallel
pnpm dev:server                          # authoritative server on :8000 (tsx watch)
pnpm dev:client                          # client hot reload on :5173 (proxies /ws to :8000)
pnpm test                                # all vitest files through test/run.js
pnpm typecheck                           # strict TypeScript across every package
pnpm lint                                # ESLint (no-explicit-any)
pnpm format                              # Prettier write (format:check in CI)
pnpm build                               # all packages + client bundle
node test/run.js --index                 # regenerate the flat test/*.test.js pointers after adding/moving a test
tsx apps/server/scripts/sliceTest.ts     # end-to-end vertical slice: real server, protocol clients, restart
pnpm test:editor | test:collab | test:console   # e2e Playwright checks (editor, collaboration, console)
pnpm audit:editor                        # editor architecture audit (vitest config)
```

Production: `pnpm build`, then `DATABASE_URL=… DATABASE_DIRECT_URL=… STATIC_DIR=apps/client/dist PORT=8000 pnpm
--filter @openvibe/server start`. `DATABASE_URL` serves through PgBouncer; migrations run at boot on
`DATABASE_DIRECT_URL` (owner, direct); without both and outside production, PGlite under `DATABASE_DIR`.

## Architecture at a Glance

- **Server entry:** `apps/server/src/main.ts`; authoritative simulation, networking, persistence, platform boundary
  ([apps/server/src/platform](apps/server/src/platform)), mods ([apps/server/src/mods](apps/server/src/mods)),
  maps, worlds, casual, AI matches, Steam lists, observability.
- **Client:** [apps/client/](apps/client/) — rendering, prediction, input, HUD, the map editor (`src/editor/`), e2e
  scripts; Babylon is imported **only** here.
- **Packages:** [packages/shared/](packages/shared/) (math, ids, events, logging, fixed timestep),
  [packages/protocol/](packages/protocol/) (versioned wire messages, zod-validated inbound),
  [packages/content/](packages/content/) (data-driven items/recipes/worlds + validation registry),
  [packages/gameplay/](packages/gameplay/) (pure inventory/crafting/movement/zones/entities),
  [packages/physics/](packages/physics/) (abstraction + Rapier adapter),
  [packages/persistence/](packages/persistence/) (DTOs, repositories, PostgreSQL, migrations),
  [packages/casual/](packages/casual/) (casual rules/auto-battle/Vibe Heroes, engine-free).
- **Dependency graph (ARCHITECTURE.md):** shared → protocol/content/physics → gameplay → persistence → apps; only
  `apps/server` and `packages/persistence` know PostgreSQL; `packages/*` never import browser-only APIs.
- **Simulation:** 30 Hz fixed tick, 15 Hz snapshots; kinematic Source/Quake controller, client prediction + rewind +
  interpolation; physics sleep is first-class (settled props cost nothing on the wire).
- **Data:** [packages/persistence/migrations/](packages/persistence/migrations/) (23 migrations: characters, world,
  props, instances/leases, progress, hauls, inventory rewards, casual, Play sync, telemetry, creator worlds/scripts/
  teams/assets, surf, AI matches, sharing, outbox). A write-behind flusher means the tick never awaits I/O; SIGTERM
  drains it.
- **Pages:** `/` (portal; on play.openvibe.games `/` is the game), `/play`, `/editor`, `/worlds`,
  `/achievements`, `/leaderboards`, `/developers`, `/play/vibe-heroes`, `/healthz`, `/api/ready`, `/metrics`.
- **Deploy:** [deploy/openvibe-games.service](deploy/openvibe-games.service) (PORT 8000, HOST 127.0.0.1,
  `/etc/openvibe/games.env`, `GAMES_MIGRATIONS_DIR`, `MAP_PATH`, `STATIC_DIR`, `TRUST_PROXY=127.0.0.1`,
  `TimeoutStopSec=30`), [deploy/nginx-openvibe-games.conf](deploy/nginx-openvibe-games.conf),
  [deploy/scripts/deploy.sh](deploy/scripts/deploy.sh) wrapping `ovhost deploy games` (strategy `pnpm-build`:
  `pnpm install --frozen-lockfile`, `pnpm build`, restore tracked `dist-types/`, restart). `--wait-idle` holds the
  restart until nobody plays; `DRY_RUN=1` prints `ovhost plan games`; rollback `sudo deploy/scripts/deploy.sh
  --rollback` (rebuilds the previous commit).

## Ownership and Boundaries

Games owns the authoritative simulation (world, characters, inventories, skills, blueprints, props), the
write-behind persistence schema, the map editor and its assets, the mod registry/content/script sandbox and its audit,
the `games.*` events, the WS protocol and the portal/play/editor pages, the casual kit and its server economy, creator
worlds, AI draft matches, and the moved Play player pages. It does **not** own identity (Network subjects), files
beyond the local copy (Media mirrors), event delivery (Events), Play's service/API (Play), Inventory items (Inventory),
or general-purpose executable mods (Host Stage C; Games' QuickJS scripts are bounded and approved per install).

## Platform Integration (the boundary)

- **Identity:** a signed-in player is the token's `subject_id`; a token without one cannot name an account, and a
  guest token that looks like `usr_…` is refused. Never key a row on a display name.
- **Service principal:** calls to Events/Media/Network identity/Inventory/Play carry a client-credentials token for
  the `games` client, one per audience. No shared keys. SSO calls for a player use the player's own token.
- **Events:** `games.player.joined|left`, `games.skill.leveled`, `games.blueprint.unlocked`, `games.world.saved`
  (≤1 per `WORLD_SAVED_EVENT_MINUTES`, plus shutdown), `games.mod.installed|enabled|disabled|grants_changed|revoked`.
  Achievements are **not** events: an unlock is stored in Games and sent to Play; the six inventory-bearing
  achievements grant through Inventory and retry on failure.
- **Play:** `GAMES_PLAY_URL` (unset = scores/unlocks stay local); Play is the network-wide read surface.
- **Media:** only map-editor assets (textures, paint masks, glb) are uploaded; a restart-safe `media_mirrors` queue
  copies them to the `games` tenant. There is no screenshot/blueprint upload.
- **Mods:** manifests follow `mods.mod-manifest@1.1.0` validated against the installed Contracts (pin drift is a
  defect); `games-content@2` packs merge definitions at boot, the client sends its definition digest in `hello` and the
  server rejects a mismatch; each install stores the approved subset of requested capabilities, every runtime binding
  checks it, revocation stops affecting the world on the next tick, and install/grant/use/deny/revoke are audited.
  `games-quickjs@1` runs only with `GAMES_SCRIPT_MODS=1` in a per-mod QuickJS sandbox (defaults `cpuMs` 2/tick,
  `memoryMb` 8, `stackKb` 128; over budget disables the mod for the instance).
- **Frame:** the portal/play/editor load the OpenVibe Frame from this server's own `/shared/` copy, so it keeps its
  frame while Network is down. `GET /api/v1/platform` reports events/Media-mirror state and backlog without secrets.

## Capabilities and Grants

Implemented: `games.mod.manage`, `games.mod.read` (mods API), `games.world.announce`, `games.prop.place`,
`games.def.define` (declarative packs), and for script packs `games.script.run`, `games.players.read`,
`games.player.message`, `games.world.emit`, `games.storage.kv`. Script bindings are absent unless approved for that
install. The `games` principal needs `inventory.item.grant`, `events.event.publish|subscription.manage`,
`media.object.upload` (namespace `games`), `identity.subject.resolve`, `network.modules.write` on
`games.progress.summary`, and Network's `mods.grant.manage`.

## Conventions and Pitfalls

- **The server is the game.** Every gameplay-relevant decision is server-simulated/validated; no client field is
  trusted; inbound messages are zod-validated and flood-controlled.
- **Do not import Babylon into `apps/server`** (the architecture audit fails) or platform modules into `packages/*`;
  keep gameplay engine-free and deterministic (same Rapier build on both sides).
- **Data-driven content:** add definitions in `@openvibe/content`, validate at startup; stable ids, display names are
  cosmetic. A new built-in pack must not bypass the capability check.
- **Migrations** are `packages/persistence/migrations/NNNN_*.sql`, applied at boot with the owner URL; never edit one
  that has run. The tick never awaits I/O — write-behind, then drain on SIGTERM (30 s stop timeout).
- **Instances/leases:** PostgreSQL records each room and a renewable fenced lease; `GAMES_INSTANCES_PER_PLACE` only
  within one process, `GAMES_CREATOR_WORLDS_MAX` caps creator worlds, empty ones stop after the idle timeout. A lease
  that is lost must stop the place (old failure: five places lost leases in one night).
- **`TRUST_PROXY`:** unset means the TCP peer is the client and all forwarded headers are ignored (otherwise a caller
  mints fresh rate-limit buckets); behind nginx it is `127.0.0.1`, and nginx overwrites the headers from
  `$remote_addr`. Never read `X-Forwarded-For` directly.
- **Static serving:** an unknown path is a 404 (HTML page, `{"error":"not_found"}` under `/api`, plain text for a
  missing asset), never the portal with 200. `/api/ready` is 200 only while the database answers a real round trip.
- **Test pointers:** after adding/moving a `*.test.ts`, run `node test/run.js --index`; a missing/stale flat pointer
  fails the suite. Vitest reads the real colocated file.
- **Build:** pnpm's `onlyBuiltDependencies` is `esbuild`; Corepack downloads pnpm with Node's fetch in CI (the image
  bakes it). `pnpm install --frozen-lockfile` and a clean `pnpm build` are the deploy gate.
- **nginx** keeps `/api/ready` off the public vhosts; `/metrics` answers loopback only. Secrets
  (`OV_OAUTH_CLIENT_SECRET`, `GAMES_EVENTS_SECRET`, `OV_NETWORK_AUTH_URL`) live in `/etc/openvibe/games.env` by name
  only.
- **Play's old pages 301 here:** do not re-add `apps/server` player pages under play.openvibe.network; the service and
  API stay there.
- Phone first for casual/portal pages; no Font Awesome; "Calm reduces, only Off removes".

## Testing

`pnpm test` runs every vitest file through [test/run.js](test/run.js) (package and server units incl.
`apps/server/src/game/platformIntegration.test.ts`, which boots the real server twice on one database, and the
architecture audit). `pnpm typecheck`/`pnpm lint` keep strict TS and no `any`; `tsx apps/server/scripts/sliceTest.ts`
drives protocol clients across a restart; `pnpm test:editor|test:collab|test:console` are Playwright e2e checks. Run
the narrowest file first, then the suite.

## Documentation

- [README.md](README.md) — purpose, owns, does-not-own, depends on, layout, development, commands, production,
  platform integration, capabilities, tests, security.
- [ARCHITECTURE.md](ARCHITECTURE.md) — principles, package graph, simulation, networking, server systems, persistence,
  platform boundary, zones, entities, observability, security posture.
- [ROADMAP.md](ROADMAP.md), [docs/games.md](docs/games.md), [docs/casual.md](docs/casual.md),
  [docs/MAP_EDITOR.md](docs/MAP_EDITOR.md), [docs/EDITOR_COMPLETION_STATUS.md](docs/EDITOR_COMPLETION_STATUS.md),
  [docs/instances.md](docs/instances.md), [docs/mods.md](docs/mods.md), [docs/ai-matches.md](docs/ai-matches.md),
  [docs/platform-direction.md](docs/platform-direction.md), [docs/adr/](docs/adr/),
  [docs/capabilities-proposal/](docs/capabilities-proposal/), [docs/service-manifest-proposal.json](docs/service-manifest-proposal.json).
- [SECURITY.md](SECURITY.md), [.env.example](.env.example), [CHANGELOG.md](CHANGELOG.md).
