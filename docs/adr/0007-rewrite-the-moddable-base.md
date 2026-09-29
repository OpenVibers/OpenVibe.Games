# ADR-0007: Rewrite the moddable base

**Status:** accepted · **Date:** 2026-09-28 · supersedes ADR-0003, ADR-0004, the identity-adoption part of ADR-0006

## Context

No map, player or progress on openvibe.games is worth keeping (owner, 2026-09-28): nothing is restored and nothing
old stays compatible. The domain code is strong (Quake-style movement, the physics seam, constraints and islands,
engine-free gameplay modules, the zod content registry, the map document/diff machinery, the editor core, provenance
reconciliation, the platform adapters). The shell around it is not: a 2,803-line `gameServer.ts`, synchronous SQLite,
a renderer inside the authoritative server, world content hard-coded in client render code, a mod API of three calls,
no mobile path, and pins that lag the platform.

## Decisions

1. **The base is the product; Scraplandia is its first pack.** The engine, systems, editor and mod runtime are the
   base. Scraplandia (survival, crafting, farming, extraction) is a content pack the base loads by default, and the
   gameplay modules become systems a pack enables. A second, small game (a round-based physics party game) is built
   on the same base in M5 to prove it is general.
2. **Physics: Rapier behind the `PhysicsWorld` seam.** `@dimforge/rapier3d-deterministic-compat` on the server and in
   the client's prediction world. It removes `@babylonjs/core` and the NullEngine scene from the server, runs in a
   worker, and has one implementation on both sides (the ADR-0003 rule stays). Havok and `packages/physics/src/havok`
   are deleted. A mock `PhysicsWorld` and seam tests come first, so the swap is tested, not assumed.
3. **Determinism is scoped to movement.** The movement module is bit-identical for the same inputs (what prediction
   needs); everything else is server-trust. The global determinism claim is dropped.
4. **World model: places and instances.** A place is a map plus its persistent state; an instance is one authoritative
   process simulating a place. M1–M3 run one instance per place; M4 adds several instances per place, a registry in
   PostgreSQL, leases in Valkey, and transfer by a signed handoff token over OpenVibe.Events.
5. **Persistence: PostgreSQL 18 + Valkey 9 through `openvibe-sdk`** (`db`, `events` outbox/inbox, `valkey`, `limits`).
   A new schema from scratch (places, instances, characters, inventories, entities, constraints, map revisions, mods,
   the platform tables); no SQLite, no schema-version history, no migration of old rows. **The tick never awaits I/O:**
   the tick takes a copy-on-write snapshot of dirty rows and a write-behind flusher persists it in one transaction,
   one flush in flight per instance; a failed flush keeps the rows dirty and is retried, and shutdown drains it.
6. **Mods in three tiers.**
   - T0, declarative packs (`games-content@2`): a pack adds definitions (items, recipes, crops, NPCs, zones, maps),
     not only placements. A runtime pack loader, content versioning, and a def-set handshake so client and server
     agree on the active definitions.
   - T1, scripted server mods (`games-quickjs@1`): QuickJS (`quickjs-emscripten`) in-process, with the manifest's
     `cpuMs`/`memoryMb` enforced by the interrupt handler and the memory limit, capability-checked bindings, seeded
     randomness, hot reload, and sandbox-escape tests in CI. The runtime adapter interface is the one OpenVibe.Run
     implements later (plan ADR-036); Games does not wait for it.
   - T2, client mods in a Worker with no DOM; assets through Media.
     Capability API v2: `events.subscribe/publish`, `world.entities.read/write`, `players.read`, per-mod key/value in
     PostgreSQL, `assets.read`, `ui.*`. Money only through Billing/VIP hooks, never a balance. Manifests follow the
     platform's `mods.mod-manifest@1.1.0`; the local copy of that schema is deleted and the test reads the installed
     contracts package.
7. **Phones are a real target.** Input is intents (move vector, look delta, named actions), not keys, from M1; touch
   controls ship with M2; quality tiers, hardware scaling, KTX2 textures and the bundle budget (initial JS ≤ 2.5 MB,
   largest chunk ≤ 400 KB, editor split out) in M6.
8. **Netcode.** Authoritative server, 30 Hz tick, 15 Hz snapshots, spatial-hash interest, sleep-aware snapshots and
   input replay all stay. The WebSocket authenticates at the upgrade (no `hello` identity). Interest becomes region
   subscriptions with hysteresis in M4; lag compensation for hitscan only. JSON stays until a measurement says
   otherwise.
9. **Trust model: a co-operative sandbox.** Server authority, clamped input, per-subject limits in Valkey, movement
   sanity checks, signed asset manifests, replay telemetry: detection and revocation, no competitive-integrity claim.
10. **Platform game services live in a new service, OpenVibe.Play**: achievements, stats and leaderboards, player
    inventories across games, presence and lobbies. Each game is a Play title with its own principal and `play.*`
    grants scoped to that title. Games is the first consumer (M5); it never keeps its own copy.
11. **Terrain stays heightfield patches** (the editor and `mapFileV2` keep them).
12. **Pin drift is a defect.** Contracts and SDK pins move to current; CI fails when the installed contracts package
    rejects a manifest Games accepts, or the other way round.

## Deleted

The Live legacy import (`platform/liveLegacyImport.ts`, `scripts/importLiveLegacy.ts`, `legacy_live_rows`,
`docs/legacy-import.md`), identity adoption (`scripts/migrateIdentity.ts`, `identity_legacy_map`, `ovn:` keys,
`guest_ips`), the `/api/texture`, `/game` and `/canvas` aliases, map v1 migration (`migrateV1ToV2`,
`MAIN_TERRAIN_MIGRATED_ID`, the client's `migrateLegacyMix`/`legacyLayer`; `hq_token`/`hq_reload_ts` became
`openvibe.token`/`openvibe.reload_ts`, so an old guest cookie is not read), `EDITOR_KEY`,
`packages/persistence` (SQLite), Havok, the city geometry in `sceneSetup.ts` (it becomes the Scraplandia pack's map),
`editor/catalog.ts` def ids (read from the registry), committed `dist-types/`, `docs/GAMEPLAY_DEVELOPMENT_STATUS.md`.

## Build order

- **M1: same game, new foundation.** Deletions above; `gameServer.ts` split into systems; PostgreSQL + Valkey
  persistence with the write-behind flusher; Rapier; intent input; authenticated upgrade; pins current.
- **M2: moddable content.** Pack loader, `games-content@2`, def-set handshake, Scraplandia as a pack, touch controls.
- **M3: scripted mods.** QuickJS runtime, capability API v2, budgets enforced, hot reload, escape tests.
- **M4: instances and scale.** Several instances per place, registry and leases, transfer, region interest, load tests.
- **M5: platform game services.** OpenVibe.Play with Games as first consumer; the second game on the same base.
- **M6: client floor.** Quality tiers, KTX2 and atlases, baked icons, bundle budget, editor E2E in CI.

Each milestone is playable end to end and keeps the slice harness green.
