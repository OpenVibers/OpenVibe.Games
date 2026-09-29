# Architecture

## Principles

1. **The server is the game.** Clients render, predict, and express intent;
   every gameplay-relevant decision (movement, inventory, crafting, placement,
   physgun, damage, economy) is validated or simulated server-side. No client
   field is ever trusted.
2. **Domain logic is engine-free.** `@openvibe/gameplay` has no Babylon, Rapier,
   DOM, or network imports; it runs identically in vitest, on the server, and
   inside client prediction. Engines live behind adapters.
3. **Data-driven content.** Items, recipes, and worlds are declarative
   definitions validated at startup (`@openvibe/content`). Adding content never
   requires engine changes. Stable ids everywhere; display names are cosmetic.
4. **Persistent state is explicit.** DTOs in `@openvibe/persistence` are the disk
   format. Runtime objects (meshes, bodies, live inventories) are transient
   projections rebuilt from them.
5. **Sleep is a first-class citizen.** Settled physics objects cost nothing on
   the wire (excluded from snapshots) and nothing per-tick; they exist as
   pinned state until something wakes them.

## Package dependency graph

```
          shared
         /  |   \
  protocol content physics ──(rapier adapter: deterministic Rapier wasm)
         \  |  /
        gameplay
            |
       persistence (DTOs; PostgreSQL impl behind repository interfaces; migrations)
            |
   apps/server        apps/client
   (authoritative)    (Babylon render + prediction + HUD)
```

Only `apps/client` knows Babylon exists: ADR-0007 decision 2 removed the engine
from the authoritative server, and an architecture audit
(`apps/server/src/architectureAudit.audit.ts`) fails if `apps/server` imports
`@babylonjs/*`. Only `apps/server` and `packages/persistence` know PostgreSQL
(openvibe-sdk/db) exists. `packages/*` never import browser-only APIs: the
physics adapter is Rapier, which runs identically in Node and the browser with no
scene or engine, so there is no Node-only path to keep separate.

## Simulation model

- Fixed 30 Hz tick on the server (`FixedTimestep` also drives client
  prediction). Snapshots at 15 Hz. Rendering is decoupled and interpolated.
- **Movement** is a kinematic Source/Quake controller (`gameplay/movement`):
  explicit velocity + capsule sweeps + clip-plane sliding + step-up, with
  friction / ground-accelerate / air-accelerate (air-strafing works). The
  player is _not_ a dynamic rigid body; a kinematic Rapier capsule mirrors the
  player so props collide with them. The controller consumes a
  `CollisionQueries` interface — the Rapier adapter provides it on both sides
  (one implementation, no scene), the tests provide analytic worlds.
- **Client prediction:** every input command (seq-stamped) is sent and applied
  locally; snapshots carry the last processed seq; the client rewinds to the
  authoritative state and replays unacked inputs. Remote entities render from
  ~130 ms interpolation buffers.
- **Physics:** Rapier (`@dimforge/rapier3d-deterministic-compat`, one pinned
  build on both sides) behind `PhysicsWorld` (`@openvibe/physics`). Stepping is
  always manual (`world.step(dt)` from the fixed loop) — never coupled to render
  frames. Collision layers: Static / Prop / Player, filtered at the shape level
  for rays and sweeps.

## Networking

- Explicit protocol package with a version constant; inbound messages are
  zod-validated (range-clamped axes, size caps) and malformed traffic
  disconnects. JSON encoding today behind an encode/decode boundary sized for
  a binary codec swap.
- **Interest management:** per-session known-entity sets built from a radius
  query (the query is one function — the future spatial region index replaces
  its internals, not its callers). Spawn/despawn diffs flow from interest
  changes; snapshots contain only relevant players + _awake_ relevant bodies.
- **Sleep networking:** when a prop settles, one final `entity` pin is
  broadcast and it drops out of snapshots; on wake it re-enters. Settled
  props also mark themselves dirty exactly once for the persistence flush.
- Wire-level rate limiting (messages/sec, payload bytes) plus a bounded input
  queue per session (max 2 catch-up sims/tick) prevent client-driven speedup.

## Server systems (per tick)

1. Drain input queues → movement simulation per session (never client
   positions; silent clients coast to a stop after 3 bridged ticks)
2. Physgun drive: held bodies pulled toward the holder's view ray via
   velocity control (never teleported) with proportional angular control
3. `physics.step(dt)`
4. Sync awake prop transforms into entity records; settle/wake transitions
5. Crafting queues (tick-based completion, output-space aware)
6. Replication (every 2nd tick): interest diff + snapshot per session
7. Periodic write-behind checkpoint (a dirty snapshot handed to the flusher; the tick never awaits I/O)

## Persistence

PostgreSQL 18 through openvibe-sdk/db, behind `PersistenceStore` repositories (the SDK's async handle
and `sql` fragments; migrations in `packages/persistence/migrations/0001_initial.sql` applied at boot
by the SDK migrator as the owner role). The schema: `places`, `world_meta`, `world_entities`
(props/resources/NPCs with motion + kind-specific state JSON), `world_constraints`, `characters`
(inventory, skills, friends, reputation, unlocks, stats, armor, active job), `mods`, `mod_grants`,
`mod_placements`, `mod_audit`, `media_mirrors`, `identity_adoptions`, `account_data_events`, and the
SDK's `event_outbox` and `token_revocations`. JSON columns are jsonb and round-trip as objects; a
local guest account is keyed by `guest:` + sha256(their token), never the raw token.

**The tick never awaits I/O.** It takes a copy-on-write snapshot of the dirty rows
(`world.takeDirty()`, `npcs.takeDirty()`, dirty sessions, env/markets) and the write-behind flusher
(`apps/server/src/game/flusher.ts`) persists it in one transaction, one flush in flight per instance.
A checkpoint while one is running is coalesced (the dirty flags stay set), a failed transaction
restores the snapshot's dirtiness and is retried, and shutdown drains the queue before the database
closes. Batch writes are multi-row `INSERT … ON CONFLICT` in chunks of at most 500 rows. First boot
seeds from the world definition; afterwards the database is the world's source of truth. The
simulation never reads the platform tables.

## Platform boundary

Adapters to the OpenVibe platform live in `apps/server/src/platform` and
`apps/server/src/mods` (ADR-0006): canonical subject accounts, the `games`
service principal, the events outbox, the Media mirror, and the mod registry
with its runtime seam (`ModApi`: capability-checked bindings, the only thing a
mod can reach). No package under `packages/` imports any of it.

## Zones

Declarative rule volumes (`pvp`, `build`, `physgun`) resolved by position;
systems ask `rulesAt(pos)` — the protected city is future _content_, not code.

## Entities

`GameEntity` is a small record with optional capability components (prop,
resource, owner, …) in an `EntityStore` with kind indexes. Deliberately not a
full archetype ECS yet: systems only touch query methods, so storage can be
migrated if profiling demands it. The same composition philosophy governs item
definitions (`world`, `placeable`, `workstation` capability blocks).

## Observability

`ServerMetrics` sampled by the tick loop (tick/physics ms EMA, awake/settled
bodies, sessions, bytes out, snapshot size, RSS), exposed at `/metrics`,
summarized to structured JSON logs periodically. Logs carry system/player/
entity context fields and never spam per-tick.

## Security posture

Assume hostile clients: protocol validation at the edge, range checks on every
interaction (gather, place, physgun grab/unfreeze), zone rules, ownership
recorded on placement, inventory ops validated against authoritative state,
one live session per identity token, guest tokens restricted to a format
that can never name an account key. Client-side rays
exist purely for UX.
