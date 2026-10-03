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

## M1 physics decisions (2026-09-29)

Answers to the open questions in the M1 survey (`brief-games-m1-next.out.md`), decided after the state-hash
harness (M1 step 2) had measured the mock against a real engine. Decisions 8–9 were taken because the
cross-engine tolerance test forked on a discrete branch, not on floating-point noise.

1. **Determinism means two things, tested separately.** Same runtime (Node against Node, the same inputs):
   the movement state hash is bit-identical every tick; the test fails on any difference. Across runtimes
   (server Node against a browser): positions agree within 1 mm and velocities within 1 cm/s per tick, and
   the client reconciles (snaps to the server) past 5 cm. The movement kernel stays plain JavaScript (f64);
   no shared f32 math kernel in M1. The tolerance is written here as a tolerance, never called bit-identity.
2. **Rapier builds.** One pinned version of the deterministic build on both sides: the `-compat` package on
   the server (Node, inlined WASM, no loader), the non-compat package in the browser with the `.wasm` as a
   separate, cached, compressed asset. Physics loads with a dynamic import while the WebSocket ticket is
   fetched, so it is not initial JavaScript and the M6 budget (2.5 MB initial JS) is untouched. A test
   asserts both packages resolve to the same version.
3. **Look input stays absolute.** Each input carries yaw and pitch as absolute angles quantized to int16
   (1/65536 of a turn). Deltas add replay complexity for no M1 gain; revisit only if replay telemetry needs
   them.
4. **Actions are a bitfield of named flags.** The names and bits live in `packages/shared` as a frozen,
   versioned list; adding a flag bumps the protocol version. Compact at 30 Hz, and M2's touch controls map
   onto the same names.
5. **No Rapier snapshots in M1.** Movement state lives in `PlayerMoveState`, not in the engine; prop and
   island rollback are deferred past M1, so the snapshot API is not used and nothing is built for it.
6. **Joints: functional equivalence in M1.** Welds hold rigid, ropes respect their length, springs return to
   rest, each with a test; exact visual equivalence with Havok is refined in M2.
7. **The intent enum lives in `packages/shared`**, the single source for protocol, gameplay and M2 touch;
   `packages/gameplay/src/movement/buttons.ts` re-exports it.
8. **`tryStepMove` gets a hysteresis band.** A contact within ±2 mm of the step threshold keeps the previous
   tick's branch, so a millimetre of contact ambiguity between engines cannot flip step-up or auto-bhop.
9. **The mock resolves a rounded capsule against a box edge** (a real convex sweep, not a padded AABB), with
   the conformance suite's landing heights re-measured.

## M1 step 4 finding: Rapier shape casts lose precision on very large colliders

Measured while building the Rapier adapter (M1 steps 4–7). A diagonal `castShape` of the player capsule
against a 400 m-long static box reports contact ~14 mm before the true face, while the same cast against a
20 m box is exact to the f32 epsilon. The returned `time_of_impact` is inconsistent with the returned
contact witnesses in that case. Consequences: determinism scene geometry is kept to sane extents, and the
cross-engine tolerance is a per-tick bound, not bit-identity (decision 1).

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
  - **M2.1 pack format and loader (`games-content@2`).** A pack declares definitions (items, recipes, crops, NPCs, zones, maps), not only placements, and the runtime loader merges them into the content registry.
  - **M2.2 def-set handshake.** Client and server agree on the loaded def set (and its content version) before play.
  - **M2.3 Scraplandia as a pack.** Scraplandia (survival, crafting, farming, extraction) becomes the content pack the base loads by default, and its gameplay modules become systems the pack enables.
  - **M2.4 touch controls.** Touch maps intents (move vector, look delta, named actions) to the same input stream as the keyboard.
- **M3: scripted mods.** QuickJS runtime, capability API v2, budgets enforced, hot reload, escape tests.
- **M4: instances and scale.** Several instances per place, registry and leases, transfer, region interest, load tests.
- **M5: platform game services.** OpenVibe.Play with Games as first consumer; the second game on the same base.
- **M6: client floor.** Quality tiers, KTX2 and atlases, baked icons, bundle budget, editor E2E in CI.

Each milestone is playable end to end and keeps the slice harness green.
