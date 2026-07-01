# OpenVibe Unified UI Shell

The Electron launcher and the in-game Source/VGUI embedded browser now load the same web shell.

## Hosts

- Electron loads `http://127.0.0.1:5173/client/?electron=1&shell=electron#portal`
- Source/VGUI loads `http://127.0.0.1:5173/client/?embedded=1&shell=source#portal`

Both are served by `tools/serve-client-ui.mjs` from the `launcher/` folder.

## In-game commands

- `ov_ui`
- `ov_main_menu`
- `ov_menu_main`
- `ov_menu_servers`
- `ov_menu_leaderboard`
- `ov_menu_inventory`
- `ov_menu_shop`
- `ov_menu_settings`
- `ov_menu_close`
- `ov_menu_reload`

## Bridge URLs

The in-game HTML panel accepts allowlisted `openvibe://` actions:

- `openvibe://join?mode=hub`
- `openvibe://join?mode=prophunt`
- `openvibe://join?mode=deathrun`
- `openvibe://join?mode=fortwars`
- `openvibe://join?mode=traitortown`
- `openvibe://close`
- `openvibe://reload`

Electron receives equivalent actions through `window.OV` in `preload.js`.

## Sync model

`launcher/openvibe-ui-sync.js` keeps route state in:

- `location.hash`
- `localStorage["openvibe.ui.state.v1"]`
- `BroadcastChannel("openvibe-ui-sync-v1")`

That gives Electron and in-game the same route/state contract without duplicating UI code.
