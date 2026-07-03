# OpenVibe GModJS Architecture

Goal: a full GMod-style scripting platform for OpenVibe: Source — GMod Lua API
shapes, implemented in JavaScript, with npm integration, hotloading, and an
HTML/JS/CSS GUI that is shared between the desktop launcher and the in-game
menu.

This document is the blueprint for the framework in `game/openvibe.games/js/`
plus its C++ bridge (`sdk/openvibe/`) and the unified web GUI (`client/`).

## Realms

Mirrors GMod's states (https://wiki.facepunch.com/gmod/States):

| Realm  | Global        | Where it runs |
| ------ | ------------- | ------------- |
| server | `SERVER=true` | QuickJS embedded in server DLL (`ov_js_backend embedded`) or `ov-runtime.js --realm server` (`node` backend, TCP 41999) |
| client | `CLIENT=true` | `ov-runtime.js --realm client` (TCP 41998; embedded client QuickJS was abandoned — clang-cl crash) |
| menu   | `MENU=true`   | The HTML GUI itself (Electron renderer / in-game CEF panel) |

Realm globals are published by `js/core/realm.js` from `OV.isServer()`.
Client<->server talk only via the `net` library. The menu talks to the game
via `openvibe://` bridge actions and to the runtimes via the runtime control
HTTP server (see Console).

## File layout (GMod-parity)

```text
game/openvibe.games/js/
  core/            hook, gamemode, net, timer, command, concommand, module,
                   addon, realm, file, entity, ents, scripted_ents, nwvars,
                   player_ext, util
  autorun/         *.js run on both realms   (auto-networked to clients)
  autorun/server/  *.js server only
  autorun/client/  *.js client only          (auto-networked)
  entities/<class>.js            single-file scripted entity (shared; guard with SERVER/CLIENT)
  entities/<class>/{shared,init,cl_init}.js  folder-form scripted entity
  gamemodes/<name>/manifest.json GMod <name>.txt equivalent (base, title, settings[])
  gamemodes/<name>/shared.js     both realms
  gamemodes/<name>/server.js     server entry (GMod init.lua)
  gamemodes/<name>/client.js     client entry (GMod cl_init.lua, auto-networked)
  node_modules/    npm packages (require()-able from any script)
addons/<name>/{addon.json,shared.js,server.js,client.js,entities/,autorun/}
```

Loading order (per realm, GMod Lua_Loading_Order-faithful):
core -> autorun (alphabetical; shared then realm dir) -> base gamemode ->
active gamemode (shared -> realm entry) -> scripted entities -> addons ->
`Initialize` -> `InitPostEntity`.

## Hook library (js/core/hook.js)

GMod semantics (Hook_Library_Usage):
- `hook.Add(event, id, fn)` — id is a string OR an object with `IsValid()`;
  invalid-object hooks are auto-removed at call time; object id is prepended
  as first arg (self).
- First non-`undefined` return short-circuits (false counts, undefined does
  not); hooks run before the `GAMEMODE` method; `hook.Run` = `hook.Call`
  with the active gamemode table.

## net library (js/core/net.js)

Full GMod surface: `Start(name, unreliable)`, writers/readers for
Bit/Bool/Int/UInt/UInt64/Float/Double/String/Data/Vector/Normal/Angle/Color/
Entity/Player/Table/Type, `Send/Broadcast/SendOmit/SendPVS/SendPAS/
SendToServer/Abort`, `BytesWritten/BytesLeft`, `Receive` (single handler,
name lowercased), `util.AddNetworkString/NetworkStringToID/IDToString`.

Faithful behaviors: 64KB payload cap enforced, read-past-end returns
defaults, server receivers get `(len, ply)` with authoritative sender,
per-player per-message rate limiting (`net.SetRateLimit`), names must be
pooled server-side before `Start`.

Transport (unchanged wire): serialized typed-field JSON, base64. S->C =
`OV.netEmit` -> `OVNet` usermessage -> client bridge -> client runtime.
C->S = `ov_net <name> <payload>` forwarded command -> `OVNetReceive` hook.
Payloads over the usermessage limit are chunked (`OVNetChunk`).

## Entities (js/core/entity.js, ents.js, scripted_ents.js, nwvars.js)

- `Entity` wrapper over `{entIndex, serial}` handles; `NULL` singleton;
  `IsValid()`; `Remove()` deferred to end of tick firing `CallOnRemove` then
  `OnRemove`. Server methods call native bindings (`OV.ent*`); everything
  degrades gracefully in the Node harness (pure-JS entity registry) so
  gamemodes are testable without the engine.
- `ents.Create/FindByClass(wildcards)/FindInSphere/GetAll/Iterator/
  GetByIndex/GetCount`, client `ents.CreateClientside`.
- `scripted_ents.Register(ENT, class)` with `Base` prototype chains and
  hot-repatch of live instances on re-register; lifecycle:
  `SetupDataTables -> KeyValue -> Initialize -> Think(NextThink) -> Use/
  Touch/OnTakeDamage -> OnRemove`.
- Networked state: `SetNW*/GetNW*` keyed store + `NetworkVar` DTVar-lite
  slots declared in `SetupDataTables`; server changes replicate to clients
  via internal `OV_NWSync` net messages; `SetNWVarProxy`/`NetworkVarNotify`.
- `Player` extends `Entity` (Nick/SteamID/UserID/Team/Kill/Give/Freeze/
  ChatPrint/...); `player.GetAll/GetByUserID/Iterator`; `LocalPlayer()` on
  the client.

## File networking (js/core/file.js) — AddCSLuaFile equivalents

- `AddCSJSFile(path?)` (alias `AddCSLuaFile` for muscle memory) — server-only
  effect; default = currently loading file. Auto-networked: `autorun/`,
  `autorun/client/`, gamemode `shared.js`/`client.js`, `entities/`.
- Server builds a manifest {path, sha256, size}; on `ClientFullyConnected`
  it net-sends the manifest; the client runtime diffs against its cache
  (`js/ov_downloads/`), requests missing files via `OV_FileRequest`, and
  loads client scripts from the synced set. `include(path)` executes a file
  in the caller realm with caller-dir relative resolution.

## Console commands (C++ + js/core/concommand.js)

- `concommand.Add(name, fn(ply, cmd, args, argStr))` per realm.
- Server: `js_run <code>`, `js_openscript <path>` (path relative to `js/`).
- Client: `js_run_cl <code>`, `js_openscript_cl <path>` — gated by replicated
  `sv_allowcsjs` (GMod's sv_allowcslua), never executable via the
  server->client command channel.
- Existing `ov_js_*` commands remain. `ov_npm <install|update> <pkg>` routes
  to the Node runtime which shells out to npm in `js/` then hot-reloads.

## Hotloading

- Node backend: `fs.watch` over `js/` + `addons/` (exists) -> targeted
  `require.reload` + `OnReloaded` hook; scripted entity re-register
  hot-patches live instances.
- Embedded backend: `ov_js_reload` full reload; `js_openscript` for ad-hoc.
- npm: `ov_npm install <pkg>` (console/GUI) -> npm child process ->
  watch-triggered reload. Works in the Node backend; embedded backend picks
  packages up via `core/module.js` on next reload.

## Runtime control server (engine/openvibe-js-runtime/ov-runtime.js)

HTTP on 127.0.0.1:41997 (`server` realm; 41996 for `client` realm):
- `GET  /logs`      — SSE stream of runtime + game log lines
- `POST /eval`      — `js_run` equivalent (body = code), returns result JSON
- `POST /exec`      — run a registered concommand / forward engine command
- `POST /npm`       — npm install/update into `js/`
- `GET  /state`     — realm, mode, players, gamemode, hooks, entities
This is what the GUI console talks to from both hosts.

## Unified GUI (client/)

One SPA (HTML/JS/CSS, no framework) served identically to Electron
(`serve-client-ui.mjs` :5173), the backend (`/client/` :3000) and the
in-game CEF panel (`ov_menu_url`). Routes: `portal, servers, leaderboard,
inventory, shop, settings, options, console, hud`.

- Console route: SSE log view + command input with history; JS eval
  (server/client realm select) via runtime control server; engine commands
  via `openvibe://cmd?c=` (in-game, allowlisted in C++) or runtime `/exec`.
- Options route: game/video/audio convars (allowlisted set via
  `openvibe://convar?name=&value=`), UI prefs (localStorage), account
  settings (backend). Gamemode `manifest.json settings[]` render here too.
- HUD route (`?hud=1` overlay): round state, teams, timers, health — driven
  by `OV_HudState` net messages -> client runtime -> `ov_menu_js` push.
- Launcher and in-game share route state via localStorage +
  BroadcastChannel (existing openvibe-ui-sync contract, kept).

## C++ additions (sdk/openvibe/)

1. `shared/ov_js_entity.cpp` — entity natives + JS class (create, spawn,
   remove, class/model/pos/angles/health/color/material/keyvalue/fire,
   find queries, physics init/wake). Registered next to the player class.
2. `openvibe_js_server.cpp` — `js_run`, `js_openscript`, `ov_npm`
   ConCommands; Node-mode event forwarding for PlayerSpawn/Death/
   InitialSpawn/Disconnected/Round* (gap fix).
3. `openvibe_js_client.cpp` — client event forwarding (LevelInit, Think
   ticks) to client runtime; `js_run_cl`, `js_openscript_cl` gated by
   replicated `sv_allowcsjs`.
4. `vgui_openvibe_menu.cpp` — bridge actions `cmd`, `convar`, `net`;
   route commands `ov_menu_console`, `ov_menu_options`; console spew tap ->
   `window.OV.onConsoleLine`.
5. `apply-openvibe-sdk.sh` — new files + VPC entries + usermessage
   `OVNetChunk`.

## Testing

Node harnesses (zero C++): `tools/smoke-js-core-node.mjs`,
`tools/smoke-js-gamemodes.mjs` (all modes), plus new
`tools/test-gmodjs.mjs` covering hooks (object ids, short-circuit), net
(loopback pair of realms, rate limits, chunking), entities (SENT lifecycle,
NW sync), file sync manifest, include/AddCSJSFile, concommand, hotload,
gamemode loader. GUI: `tools/smoke-ui.mjs` (serves + asserts routes).
SRCDS smoke unchanged.
