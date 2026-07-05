# OpenVibe JavaScript Scripting (GModJS)

OpenVibe embeds a GMod-shaped JavaScript platform in Source. The same
`game/openvibe.games/js/` framework runs under two backends:

- **embedded** — QuickJS compiled into the server DLL (`ov_js_backend embedded`)
- **node** — `engine/openvibe-js-runtime/ov-runtime.js` over TCP
  (`ov_js_backend node`; server realm 41999, client realm 41998) with full
  npm (including native modules), fs.watch hot-reload, and the runtime
  control server for the GUI console.

See `docs/GMODJS_ARCHITECTURE.md` for the design blueprint.

## Realms

GMod States parity: `SERVER` / `CLIENT` globals (`js/core/realm.js`). The
server realm is the embedded QuickJS or the server Node runtime; the client
realm is the client Node runtime; the menu realm is the HTML GUI.

## File layout & loading order

```text
js/
  core/            hook, gamemode, util, net, entity, ents, player, team,
                   file, concommand, command, timer, module, addon, loader
  autorun/         both realms          (auto-networked)
  autorun/server/  server only
  autorun/client/  client only          (auto-networked)
  entities/        scripted entities (single-file or folder form)
  gamemodes/<mode>/{manifest.json, shared.js, server.js, client.js}
  node_modules/    npm packages (require()-able)
  vendor/          local packages referenced from package.json (file:)
addons/<name>/{addon.json, shared.js, server.js, client.js}
```

Per realm (GMod Lua_Loading_Order): core → autorun (alphabetical; shared then
realm dir) → gamemode chain (base first via `manifest.json "base"`) →
scripted entities → addons → `Initialize`.

## Hook library

GMod semantics (`js/core/hook.js`):

```js
hook.Add("PlayerSpawn", "MyAddon.Spawn", function (ply) { ... });
hook.Add("Think", someEntity, function (self) { ... }); // object id: auto-removed when invalid, self prepended
hook.Remove("PlayerSpawn", "MyAddon.Spawn");
const result = hook.Run("SomeHook", a, b); // first non-undefined return wins (false counts)
```

Registered hooks run before the `GAMEMODE` method and can override it.

## Gamemodes

```js
const GM = { mode: "mymode", name: "My Mode",
  CreateTeams() { team.SetUp(2, "Red", Color(235,75,60)); },
  Initialize() {}, PlayerSpawn(ply) { hook.Run("PlayerLoadout", ply); } };
gamemode.set(GM); // registers + derives from base + publishes GAMEMODE
```

`gamemode.Register`, `DeriveGamemode`, `baseclass.Get("gamemode_<name>")`
exist for GMod parity. `manifest.json` is the `<name>.txt` equivalent
(`base`, `settings[]` rendered in the Options GUI).

The base gamemode provides the round state machine
(`idle → countdown → active → ended`), `RoundStart`/`RoundEnd` hooks, the
`team` library, and HUD state replication (`OV_HudState` net message every
3s + on transitions → client realm → HTML HUD overlay).

## net library

Full GMod surface (`js/core/net.js`): `net.Start(name, unreliable)` (name must
be pooled server-side with `util.AddNetworkString` first), writers/readers for
`Bit/Bool/Int/UInt/UInt64/Float/Double/String/Data/Vector/Normal/Angle/Color/
Entity/Player/Table/Type`, `Send/Broadcast/SendOmit/SendToServer/Abort`,
`BytesWritten/BytesLeft`, `net.Receive(name, fn(len, ply))` (one handler per
name, case-insensitive; `ply` only on the server — the authoritative sender).

Faithful limits: 64KB payload cap, read-past-end returns type defaults, and
per-player rate limiting: `net.SetRateLimit("MyMsg", 10)` (default 30/s).
Transport chunks payloads over the 255-byte `OVNet` usermessage automatically.
`SendPVS/SendPAS` currently broadcast (no native PVS data yet).

```js
// server
util.AddNetworkString("MyMsg");
net.Receive("MyMsg", function (len, ply) {
  const value = net.ReadUInt(8);       // validate: never trust the client
  if (value > 100) return;
});
// client
net.Start("MyMsg"); net.WriteUInt(42, 8); net.SendToServer();
```

## Entities

`js/core/entity.js` + `ents.js`: `Entity` wrapper with `IsValid/EntIndex/
GetPos/SetPos/GetAngles/SetModel/Health/SetHealth/TakeDamage/PhysicsInit/
GetPhysicsObject/SetParent/SetOwner/SetColor/SetKeyValue/Fire/Remove/
CallOnRemove/...`, the `NULL` singleton, `SetNW*/GetNW*` networked vars, and
DTVar-lite `NetworkVar` declared in `SetupDataTables` — server writes
replicate to client shells automatically (`__ovnw`/`__ovdt`).

`ents.Create/FindByClass("wildcard*")/FindInSphere/GetAll/Iterator/
GetByIndex`, client `ents.CreateClientside`. With the native entity bridge
compiled in, `ents.Create` drives real engine entities (`OV.entCreate` /
`OV.entCall`); otherwise entities are logical (harness/tests/round logic).

Scripted entities (GMod SENT layout, `js/entities/`):

```text
entities/ov_bouncy_crate/shared.js   ENT.Type/Base/PrintName/SetupDataTables
entities/ov_bouncy_crate/init.js     server: AddCSJSFile + include(shared) + Initialize/Think/Use/OnTakeDamage/OnRemove
entities/ov_bouncy_crate/cl_init.js  client: include(shared)
```

`scripted_ents.Register(ENT, class)` hot-patches live instances on
re-register (`OnReloaded` fires). `Think` honors `self.NextThink(CurTime()+t)`.

## Players

`Player` extends `Entity`: `Nick/SteamID/UserID/Team/SetTeam/Alive/Kill/
Freeze/ChatPrint/ConCommand/Frags/...` plus the legacy lowercase API
(`ply.chat`, `ply.setTeam`, ...). `player.GetAll/GetByUserID/GetBySteamID/
Iterator`; `LocalPlayer()` on the client. Native handles from either backend
are wrapped automatically in hook arguments.

## AddCSJSFile / include / client script sync

`AddCSJSFile(path?)` (alias `AddCSLuaFile`) marks a `js/`-relative file for
client download; `autorun/`, `autorun/client/`, gamemode `shared.js`/
`client.js` + `manifest.json`, and `entities/` are auto-networked.
`include(path)` executes a file in the caller's realm (js/-rooted with
caller-dir fallback). On join the server net-sends a `{path, hash, size}`
manifest; the client requests missing files (rate-limited, allowlisted to the
manifest) and caches them under `js/ov_downloads/`, then fires
`OVFilesSynced`.

## Console commands & script execution

`concommand.Add(name, fn(ply, cmd, args, argStr))` per realm;
`RunConsoleCommand(name, ...args)` with a blocklist (can never trigger
`js_run_cl` etc.). Chat commands stay on `command.Add` (`!cmd`).

Engine console (GMod `lua_*` equivalents):

```text
js_run <code>            server realm eval
js_openscript <path>     run js/<path> on the server (re-runs on repeat)
js_run_cl <code>         client realm eval        (gated by sv_allowcsjs)
js_openscript_cl <path>  run js/<path> on the client (gated by sv_allowcsjs)
ov_npm install <pkg>     npm into js/ + hot-reload (node backend)
ov_js_reload / ov_js_status / ov_js_fire / ov_js_cmd   (existing)
```

## Hotloading

- node backend: `fs.watch` on `js/` + `addons/` → full reload → `Initialize`
  + `OnReloaded`; scripted entity re-register hot-patches live instances;
  `require.reload(id)` for targeted reloads. The watcher only reacts to
  `*.js`/`*.json` changes (dotfiles, extension-less editor scratch files, and
  `~`/`.swp`/`.tmp`/`.bak` backups are ignored) and debounces bursts 500ms, so
  an editor save storm re-bootstraps once; re-bootstrap boot chatter is
  demoted to the debug log stream.
- embedded backend: `ov_js_reload` (full), `js_openscript` (ad-hoc).
- npm: `ov_npm install <pkg>` (console), `POST /npm` (GUI console), or edit
  `js/package.json` — the watcher reloads on node_modules changes. Local
  packages live in `js/vendor/` via `file:` deps.
- declared npm deps (node backend): an addon's `addon.json` or a gamemode's
  `manifest.json` may declare dependencies:

  ```json
  { "npm": { "nanoid": "^5", "ov-leftpad": "file:vendor/ov-leftpad" } }
  ```

  At framework load the runtime diffs every declared dep against
  `js/package.json` + installed `js/node_modules` and batch-installs only
  what's missing (one `npm install pkg@range ...`, non-blocking — a failed
  install warns and the realm keeps loading; the post-install reload picks the
  new packages up). `file:` ranges resolve relative to `js/` (the npm root),
  so vendored packages live at `js/vendor/<name>` (see
  `addons/hello-world/addon.json` for a working example). Package names must
  be npm-valid, version ranges are character-validated, and npm always runs
  via execFile arg arrays — never a shell. The embedded QuickJS backend
  ignores the `npm` key (no npm there; vendor pure-JS files for it instead).

## Runtime control server (GUI console backend)

Each Node runtime serves HTTP on 127.0.0.1 (server realm 41997, client 41996):

```text
GET  /health   GET /state   GET /logs (SSE)
POST /eval {code}   POST /exec {command}   POST /npm {args}   POST /openscript {path}
```

## Testing (no C++ build needed)

```bash
node tools/test-gmodjs.mjs        # 131-check framework suite (paired realms)
node tools/smoke-js-core-node.mjs # legacy core smoke
node tools/smoke-js-gamemodes.mjs # all five modes lifecycle
node tools/smoke-runtime-ipc.mjs  # real TCP IPC flow across both runtimes
```
