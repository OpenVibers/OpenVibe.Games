# openvibe-economy — OpenVibe Economy (in-game half)

GModJS addon that connects a game server to the OpenVibe backend economy
(`http://127.0.0.1:3000`, override with the `OVECON_API_BASE` env var of the
Node runtime host).

**Provenance:** this system is a port of the economy from Devolved, the
community that inspired OpenVibe. The live product is branded OpenVibe
Economy; Devolved remains the import source — content defs (item/crate/rare
ids), the weapon class map keys and the importer tooling
(`tools/import-devolved.mjs`, `backend/seed/devolved-content.json`,
`npm run seed:devolved`) keep their Devolved-named identity so old Devolved
user inventories port straight in.

## What it does

- **Sync** (`server.js`): on `PlayerInitialSpawn` (and on `ov_econ_refresh`,
  server console or client request) fetches
  `GET /v1/economy/state?steamId=<steamid64>` and caches the view per player.
  SteamID64s come from `Player.SteamID64()` / `util.SteamIDTo64()` (pure JS,
  no C++ changes). The equipped-only snapshot
  `{bucks, lvl, xp, xpInLevel, xpNext, weps, equippedCosmetics}` is pushed to
  the owning client over the `OVEcon_State` net message, and mirrored into
  `Player.SetMoney/SetLevel` NW vars.
- **Perma weapons** (`PlayerLoadout` hook): every `loadout.weps` entry with
  `equipped: true` is mapped from its original Devolved class to an HL2DM C++
  weapon class via `OVEconomy.MapWeaponClass` (`shared.js` — exact table +
  prefix rules, e.g. the `weapon_zm_improvised_*` knife family →
  `weapon_crowbar`) and granted with `Player.Give`. Unmapped classes are
  skipped with a once-per-class log line.
- **Cades**: buying/placing (`ov_econ_cade <name>` → `OVEcon_CadeBuy`)
  is validated server-side against the synced backend state using the existing
  `js/core/cades.js` registry + `js/entities/ov_prop_cade` entity (not
  duplicated here): hidden cades require `loadout.cades[name]`, level gate,
  balance check, per-life placement cap (8 default / 15 hard max, from
  Devolved, reset each spawn) and the 1s cooldown.
- **Client** (`client.js`): Bucks + Level HUD counters (bottom-right,
  `js/core/hud.js` declarative elements), `ov_econ_inv` opens the HTML
  menu's `inventory` route via the engine's `ov_menu_inventory` command
  (fallback: `OV.menuJS` page-router call), `ov_econ_refresh` requests a
  re-sync, `ov_econ_menu` toggles the cade quick menu.

Note: `ov_econ_*` are JS-realm client commands the engine does not know
about — engine keybinds and the `openvibe://cmd` bridge must invoke them
through the client-side forwarder, e.g. `bind "c" "ov_js_cmd_cl ov_econ_menu"`
(see `cfg/openvibe_client_default.cfg`).

## Backend degradation

The Node runtime (`ov_js_backend node`) provides real `require('http')`; the
embedded QuickJS backend does not. `server.js` feature-detects this and, when
http is unavailable, logs **one** warning and skips backend sync — loadout
hooks, cade validation (with zeroed defaults) and all net plumbing still load.

## Cade charges and kill rewards are persisted

In-round spends and rewards go through server-authenticated backend endpoints
(secret validated against `game_servers`; the addon calls
`POST /v1/servers/register` once at load):

- **Cade placement** — ownership / level / balance / cap / cooldown are
  enforced from the synced state (fast path), then the cost is persisted via
  `POST /v1/economy/server/charge` (ledger reason `game:<serverId>:cade:<name>`).
  If the backend answers `insufficient_bucks` the optimistic placement is
  revoked and the state re-synced; on network failure it falls back to the old
  local soft-debit (warned once) so gameplay never blocks on the backend.
- **Kill reward** — `PlayerDeath` grants the attacker 5 bucks / 15 xp via
  `POST /v1/economy/server/reward` (reason `game:<serverId>:kill`); self/world
  kills are ignored.

Server identity comes from `OPENVIBE_SERVER_ID` / `OPENVIBE_SERVER_SECRET`
(defaults `local-dev` / `dev-secret`, matching the dev backend).

## Testing

Covered by `node tools/test-gmodjs.mjs` (SteamID64 conversion, addon manifest,
class-map lookups, state push + loadout grant + cade gating with injected
backend state). `OVEconomy.server._setState(steamId64, view)` exists exactly
for that injection.
