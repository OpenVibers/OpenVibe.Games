# OpenVibe Unified UI Shell

The Electron launcher, the in-game Source/VGUI embedded browser, and the
backend all serve/load the SAME app: the repo-root `client/` directory
(`client/index.html` + `client/ui-sync.js`).

## Hosts

- Electron loads `http://127.0.0.1:5173/client/?electron=1&shell=electron#portal`
  (window.OV = preload IPC bridge; the app object is `window.OVApp`)
- Source/VGUI loads `http://127.0.0.1:5173/client/?embedded=1&shell=source#portal`
  (window.OV = the app object, talks via `openvibe://` navigations)
- The backend serves the identical files at `http://127.0.0.1:3000/client/`
- HUD overlay: append `&hud=1` (or `#hud`) — translucent, pointer-events none

Port 5173 is `tools/serve-client-ui.mjs`, which now serves the repo `client/`
directory for `/client/*` (plus `/health` and `launcher/assets` at `/assets/*`).

## Routes

`portal, servers, leaderboard, inventory, shop, settings, options, console, hud`

- `#console` — merged SSE log view (server runtime 127.0.0.1:41997/logs,
  client runtime 127.0.0.1:41996/logs), JS eval per realm (`POST /eval`),
  engine commands via `openvibe://cmd?c=` in-game or `POST 41997/exec`
  elsewhere; `]cmd` forces engine, `npm …` goes to `POST /npm`.
- `#options` — game convars (allowlisted, `openvibe://convar?name=&value=`,
  current values pushed via `window.OV.onConvars`), UI prefs
  (`localStorage["openvibe.options.v1"]`, synced across hosts), account
  fields, and the active gamemode's `manifest.json settings[]` from
  `GET 41997/state`. Account auth stays on `#settings`.
- `#hud` / `?hud=1` — round banner, team + timer, health, gamemode name;
  driven by `window.OV.onHudState(obj)` with `GET 41996/41997 /state` polling
  as fallback.

## In-game commands

- `ov_ui`, `ov_main_menu`, `ov_menu_main`
- `ov_menu_servers`, `ov_menu_leaderboard`, `ov_menu_inventory`,
  `ov_menu_shop`, `ov_menu_settings`, `ov_menu_options`, `ov_menu_console`
- `ov_menu_close`, `ov_menu_reload`

## Bridge URLs

The in-game HTML panel accepts allowlisted `openvibe://` actions:

- `openvibe://join?mode=<hub|prophunt|deathrun|fortwars|traitortown>`
- `openvibe://cmd?c=<urlencoded engine command>` (allowlisted in C++)
- `openvibe://convar?name=<name>&value=<value>` (allowlisted convars)
- `openvibe://convar_get?names=<a,b,c>` → C++ replies via `window.OV.onConvars`
- `openvibe://close`, `openvibe://reload`, `openvibe://ready`

Electron receives equivalent actions through the `window.OV` preload bridge
(`launcher/preload.js`); the `ui:set-route` allowlist in `launcher/main.js`
includes `options` and `console`.

C++ push entry points on the page (in-game): `window.OV.onConsoleLine(lines)`,
`window.OV.onConvars(obj)`, `window.OV.onHudState(obj)`.

## Keyboard

- `F1` portal, `F2` servers
- `` ` `` or `F10` toggles the console route
- `Esc` → `openvibe://close` (in-game)

## Sync model

`client/ui-sync.js` keeps route + UI-pref state in:

- `location.hash`
- `localStorage["openvibe.ui.state.v1"]`
- `BroadcastChannel("openvibe-ui-sync-v1")`

That gives Electron and in-game the same route/state contract without
duplicating UI code. The `hud` route is never applied remotely.

## Test

`node tools/smoke-ui.mjs` — serves the app on an ephemeral port and asserts
all route markers, the sync layer, `/health`, and the backend's on-disk
`client/index.html` mapping.

`launcher/index.html` + `renderer.js` remain only as the offline fallback
Electron loads if the UI server cannot start.
