# Mods

Games has two mod kinds. Both travel in a content pack (`ContentPackV2`,
`packages/content/src/pack.ts`) and both are part of the def set, so the
`hello`/`welcome` digest covers them.

- **`games-content@2`**: declarative data (definitions, a map, announcements,
  props). Installable through the mods API with per-capability grants; see the
  README's Mods section.
- **`games-quickjs@1`**: server script mods, described here (ADR-0007 decision 6,
  tier T1).

## `games-quickjs@1`

A pack carries script mods in `mods: [...]`. Each entry is a manifest and its
source together (`packages/content/src/schema/scriptMod.ts`, strict, so an
unknown field is refused):

| field     | rule                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `format`  | `"games-quickjs@1"`                                                      |
| `id`      | `^[a-z0-9][a-z0-9_-]{0,39}$`, unique across all packs (never overridden) |
| `version` | `major.minor.patch`                                                      |
| `entry`   | the script's file name (`*.js`), shown in stack traces                   |
| `source`  | the script, at most 64 Ki characters                                     |
| `hooks`   | one or more of `onTick`, `onPlayerJoin`, `onPlayerLeave`                 |
| `budgets` | optional `{ cpuMs, memoryMb, stackKb }`, each up to its ceiling          |

A pack may carry up to 8 mods. v1 mods are a single script: there is no module
loader, so `import` and `require` do not exist.

**Pinned by the digest.** Manifests and sources are merged into `ContentDefs.mods`
and hashed by `contentDigest` with every other definition. A client whose copy of
a mod differs by one byte (or that lacks it) is refused with `content_mismatch`
before any player state is created. A def set without mods keeps the digest it
had before mods existed.

**Where mods come from.** Packs passed to `createContent` (the built-in packs in
`packages/content/src/packs`). The mods API still refuses executable installs: a
script mod ships with the code of the place, reviewed like code.

**Off unless the place enables it.** `GAMES_SCRIPT_MODS=1` (or `true`) runs the
def set's script mods on this instance. Without it the engine is never loaded
and the server logs `script mods off for this place`; the mods stay in the def
set either way, so the digest does not depend on the flag.

### Writing a mod

The script runs once at load (top-level code), then the host calls the global
functions named by `hooks`:

```js
// greeter.js — hooks: ["onPlayerJoin"]
function onPlayerJoin(e) {
  game.emit({ kind: 'announce', text: `Welcome, ${e.player.name}` })
}
```

| hook            | payload                              |
| --------------- | ------------------------------------ |
| `onTick`        | `{ tick, dt }` (dt in seconds)       |
| `onPlayerJoin`  | `{ player: { id, name, pos, yaw } }` |
| `onPlayerLeave` | `{ playerId }`                       |

A declared hook that the script does not define is skipped.

### Host API

The only thing the host adds to a fresh QuickJS context is the frozen global
`game`. Everything else is the language's own intrinsics: no `require`,
`process`, `fs`, network, timers, `console` or QuickJS `std`/`os`.

| call                  | does                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `game.players()`      | every player: `[{ id, name, pos: [x, y, z], yaw }]` (a copy)     |
| `game.player(id)`     | one player, or `null`                                            |
| `game.emit(intent)`   | queues an intent; a malformed one throws inside the script       |
| `game.log(...values)` | one `script mod log` line in the server log (4 per tick at most) |

Intents (at most 16 per call):

| intent                                                | applied by                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ kind: 'announce', text }` (1–200 characters)       | the same broadcast as server announcements                                                                                                 |
| `{ kind: 'giveItem', playerId, item, count }` (1–100) | the player's inventory (`canFit`, `add`, saved, sent to the client); refused if the player is gone, the item unknown or the inventory full |

Intents are applied after the call returns, and only if it completed: a call
stopped by a budget or ended by a throw changes nothing. An intent is rebuilt
from its known fields, so nothing else the script put on it (a `__proto__`
key included) reaches the host. Only JSON crosses the boundary, in both
directions.

### Budgets

| budget     | default | ceiling | enforced by                                                    |
| ---------- | ------- | ------- | -------------------------------------------------------------- |
| `cpuMs`    | 2       | 10      | the QuickJS interrupt handler (wall clock on the tick thread)  |
| `memoryMb` | 8       | 32      | the mod's WASM memory, capped at the 16 MiB engine base + this |
| `stackKb`  | 128     | 256     | the runtime's max stack size                                   |

`cpuMs` is per tick: every call the mod gets in one tick (its `onTick` and any
join/leave hooks) shares it, and it caps each call. Promise jobs a call queued
run inside the same deadline, one job at a time. The top-level code gets
25 × `cpuMs` once.

`memoryMb` is the heap a mod may hold beyond the engine's own fixed base.
QuickJS's malloc limit cannot count bytes under emscripten (it has no
`malloc_usable_size`), so the bound is the linear memory itself: each mod's
`WebAssembly.Memory` has a maximum, a refused grow fails the allocation inside
the script, and that refusal is a breach even if the script catches the
`out of memory`. The malloc limit stays as a second line against one huge
allocation. `stackKb` stops at 256 because past it the host's own (native)
stack runs out first; a path that recurses in C without QuickJS's check (a
deeply nested `JSON.stringify`) that exhausts the host's stack is caught,
reported as a `stack` breach and the instance dropped.

An interrupt or out-of-memory that the script catches, or that an async hook
turns into a rejection, still counts: the breach flag is the host's, not the
script's.

A mod that goes over a budget is stopped mid-call and **disabled for this
instance**: its sandbox is freed, `script mod disabled` is logged with the
reason (`cpu`, `memory`, `stack`), and it is counted. Five throws in a row
disable it the same way (`error`); a single throw is logged and counted. The
tick goes on either way. A disabled mod comes back only with a restart.

Counters: `scriptModsRunning`, `scriptModsDisabled`, `scriptModFailures` in the
metrics log line; per-mod state, budgets, calls, failures by reason and intents
applied/refused under `mods.scripts` in `GET /api/v1/platform`.

### Isolation

Each mod gets its own WASM module instance, runtime and context
(`apps/server/src/mods/script/quickjs.ts`), so no heap, global or prototype is
shared between mods or with the host. Escape tests
(`apps/server/src/mods/script/quickjs.test.ts`) check that no host object or
Node global is reachable, that prototype pollution inside a sandbox never
reaches host objects, and that one mod cannot see another's state.

### The adapter

`apps/server/src/mods/script/sandbox.ts` is the whole contract between the host
and an engine — `ModSandboxFactory.create(spec)` returning a `ModSandbox` with
`call(hook, payload, cpuMs)` and `dispose()` — so OpenVibe.Run can implement the
same interface later (ADR-036) without the host changing. QuickJS
(`quickjs-emscripten`, exact version pinned in `apps/server/package.json`) is the
first implementation.

### Not yet

Capability API v2 (per-mod grants for script bindings, key/value storage),
seeded randomness, hot reload, multi-file mods, and installing script mods
through the mods API.
