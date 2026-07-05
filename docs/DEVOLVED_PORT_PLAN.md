# Devolved → OpenVibe: Source — Port Plan

> The live system is branded **OpenVibe Economy**; Devolved is the
> inspiration/import source.

Bringing the Devolved community's economy/admin systems (from `~/src/devolvedttt`
+ `~/src/devolvedadmin2`, GMod Lua) onto the OpenVibe GModJS platform: JS
addons/gamemodes + the unified HTML main menu + the Node backend.

## Source systems (analyzed)

| System | Devolved (Lua) | Shape |
|---|---|---|
| Cades (barricades) | `autorun/cades/*.lua` (129) + `sh_cades.lua` + `prop_cade` | flat registry `Cades[Name]={mdl,cost,hp,lvl,hidden}`; `cade_buy <Name>` → validate (lvl/cost/cap/cooldown) → `prop_cade` entity w/ DT ints owner/hp/maxhp; per-player cap 7–15, per-type caps, 1s cooldown, discounts. |
| Admin | `devolvedadmin2/` | `AddPlugin(Name,Ranks,Desc,Type,Func,Args,NoSpace,Pri)`; `plugins/`=server, `ply_plugins/`=player-targeted; ranks Moderator/Administrator/Manager from `ply.Ranks` (forum DB by SteamID64); `!cmd` chat + `DA2_RunCMD` net + 3-level cascading GUI. |
| Inventory/crates/keys/craft | `sh_items`, `sh_crates`, `sh_rares`, `f4tabs/1.lua`, `player_data.lua`, `player_inventory.lua` | See "Inventory analysis" below. |

## Inventory analysis (devolvedttt, 2026-07-04)

- **State model**: everything hangs off `ply.DTTT` (server truth in
  `lua/jackooldotcom/base/server/player_data.lua`, MySQL table `robby_ttt`,
  one column per key; tables as JSON, booleans as `"btrue"/"bfalse"`).
  `DTTT.extras` is the inventory proper: a flat ordered array of item-id
  strings — `item_<Name>`, `crate_<Name>`, or a bare rare name. No stacking;
  "stacks" are distinct item types. Metadata always resolved at render/use
  time from the shared registries (`Dev_SH.*`, populated by `sh_*.lua`).
- **Currency**: `bucks` (earned as a % of XP), progression `xp`/`lvl` with
  per-level threshold `900*(lvl*0.8)` (xp subtracts on level-up).
- **Crates** (`sh_crates.lua`, ~60): `{icon, key, limited, host, items:[{name,chance}]}`.
  Open roll (`player_inventory.lua:1240`): visit entries in random order, win
  on `math.random(1, chance+2) == chance`; if nothing hits take the
  least-chance entry (random among ties); non-limited crates gain a bonus
  `item_50 Scratch Cards` entry at chance 12. Limited crates capped globally
  (`robby_tttlimited` JSON counters).
- **Rares** (`sh_rares.lua`, ~290) are the glue: crate drops are rares; a rare
  `{type, var}` redeems out of `extras` into the equipped collections
  (`cades/mats/specweps/jihads/taunts/weps/wepskins`), unredeem reverses it
  (making it tradable again). Equipped `weps` are given on spawn
  (`sv_equips.lua` PlayerLoadout override).
- **Crafting**: 3 data recipes (`Dev.AddRecipe`, gated on owning
  `item_Recipe: X`) + a large imperative ladder in `Dev_SH.ReturnCraft`
  (`sh_items.lua:1227`): 2 identical rares→Refined Metal, 2 same-type
  rares→Reclaimed, 2 crates→metals, metal ladder up to Metal Key, stack/
  unstack, plus many special combos.
- **The drag-and-drop inventory** is the F4 tab (`f4tabs/1.lua`): hand-rolled
  pointer drag (icon follows cursor, release over another icon swaps slots →
  net `Dev_Inv_Move(old,new)`; server swaps `extras` entries). Right-click
  menu: Use / Redeem / add-to-craft / use-key-on-crate. Server-side sort
  (`Dev_SortInv`).
- **Not ported yet (documented gaps)**: trading (`sv_trading`), market/auction
  house (`sv_market`), quests runtime, gangs, scratch-card gambling, timed
  crate drops (`Dev.TimedCrateDrop` pacing + playtime gating), item expiry
  (`ItemsExpire`), the special-combo half of `ReturnCraft`, the separate
  "Rust" survival grid inventory (flat-file, independent of `DTTT`).

## Target architecture (OpenVibe)

- **Backend (Node/Postgres, `backend/`)** — authoritative economy: items, inventory
  (with stacks + slot positions), crates + drop tables, keys, recipes, trades.
  New migration extends the flat `shop_items`/`player_items` model.
- **Main menu (`client/index.html`)** — the drag-and-drop inventory, crate
  opening, crafting, and admin UI as routes, talking to the backend over `/v1/*`.
- **In-game JS (`game/openvibe.games/js/`)** — addons/gamemode code using the
  platform I just built (scripted_ents, weapons/SWEP, HUD, net): a `cades` addon
  (registry + `prop_cade` scripted entity + `ov_cade_buy` command + HUD buy
  grid), item granting, and an admin addon (plugin registry + rank check + net).
- **Steam auth** — already implemented end-to-end (client `ov_auth_steam` →
  backend `/v1/auth/steam` → session). Only needs `STEAM_WEB_API_KEY` set.

## Mapping the primitives

- Lua `Dev_SH.AddCade(...)` + `file.Find("autorun/cades/*")` → JS
  `cades.Register(def)` + loader over `js/cades/*.js` (mirrors the `scripted_ents`
  / `weapons` loaders already in place).
- Lua `prop_cade` entity (DT owner/hp/maxhp, OnTakeDamage) → JS `scripted_ents`
  entity `ov_prop_cade` with `NetworkVar` ints + `OnTakeDamage`.
- Lua `cade_buy` concommand → JS `concommand.Add("ov_cade_buy", …)` that
  validates against the backend (currency/level) then `ents.Create`.
- Lua `ply.DTTT.lvl` / `AddBucks` / caps → backend `players.xp`/`currency_balance`
  + a per-player owned-entity counter in the cades addon.
- Lua admin `ply.Ranks` (forum DB) → backend player `ranks` column resolved from
  SteamID; JS admin addon reads it via the session/profile.

## Phases

1. **Steam auth live** — DONE except the secret: the whole flow
   (`ov_auth_steam` → `GetAuthTicketForWebApi` → `POST /v1/auth/steam` →
   session token → `OVApp.onSteamAuthResult`) is implemented and the backend
   correctly returns `501 steam_auth_not_configured` until a real
   `STEAM_WEB_API_KEY` is pasted into `backend/.env` (get one at
   https://steamcommunity.com/dev/apikey; `STEAM_APP_ID=243750` already set).
   Dev auth (`POST /v1/auth/dev`) verified end-to-end 2026-07-04.
2. **Economy data model** — DONE (2026-07-04). `migrations/003_devolved_economy.sql`
   (`econ_defs`, `econ_inventory` slot-based, `econ_players` loadout/stats JSONB,
   `econ_counters` limited accounting). `src/economy.ts` (EconomyService — faithful
   crate roll, level formula, craft ladder subset, redeem/unredeem, buy/equip),
   `economy-repository-{pg,memory}.ts`, `routes-economy.ts`
   (`/v1/economy/{defs,state,move,sort,use,redeem,unredeem,crates/open,craft,buy,equip}`
   + `/v1/admin/economy/grant`), session-token identity w/ dev fallback.
   17 vitest cases + live HTTP smoke pass. `migrate.ts` fixed to apply ALL
   migrations (was hardcoded to 001).
   **Content**: `tools/import-devolved.mjs` parses the original Lua registries →
   `backend/seed/devolved-content.json` (763 defs: 87 items, 60 crates, 289 rares,
   129 cades, 74 permas, 34 tiers, 14 roundbuys, 8 specweps, 15 taunts, 7 mats,
   3 recipes, 44 quests; zero silent drops; un-ported Lua `use`/`check` function
   sources archived in the JSON as `luaUse`/`luaCheck`). Seeded automatically at
   backend boot; `npm run seed:devolved` for manual runs.
3. **Drag-and-drop inventory** — DONE (2026-07-04). The menu `inventory` route
   is a Devolved economy hub (Inventory/Crafting/Loadout/Store sub-tabs, bucks +
   level/XP header). Pointer-event drag (4px threshold, ghost, optimistic move
   with rollback), click-to-swap, custom context menu (Use/Open Crate/Redeem/
   Add to Crafting), tooltips with drop tables, server-side sort buttons.
   Original crate/item .png icons copied by `tools/copy-devolved-icons.mjs`
   (80 files → `client/assets/devolved/`); placeholder tiles otherwise.
   Verified in headless Chrome (31 runtime assertions incl. real DnD, a live
   unbox, craft, buy) + `tools/smoke-ui.mjs` extended with 13 hub markers.
4. **Crates + keys** — DONE end-to-end (server roll + limited caps; menu reel:
   40 weighted tiles, 4.5s ease-out landing on the server-decided winner,
   reduced-motion fallback, missing_key toast).
5. **Craftables** — DONE for the economy backbone (metal ladder, rare/crate
   combining, data recipes gated on Recipe unlocks; 8-slot craft UI with combo
   hints). Special combos from `ReturnCraft` still to port (archived in seed
   JSON as `luaUse` sources).
6. **Cades** — JS addon `addons/devolved/` DONE for ownership/placement:
   backend state sync on spawn (Player.SteamID64() added in pure JS),
   Devolved_State push + bucks/level HUD, perma-weapon grant on spawn via
   41-entry Devolved→HL2DM class map, cade placement gates (hidden⇒owned,
   level, balance, per-life cap, cooldown) on the existing `ov_prop_cade`.
   Gap: in-round bucks charge is soft-debited only — needs a backend charge
   endpoint (`TODO(economy-charge)` in server.js). 213/213 platform checks pass.
7. **Admin** — not started. DevolvedAdmin2 analysis (2026-07-04): thin
   command+GUI layer; ranks came from an external forum DB (`ply.Ranks`,
   `TheDB` MySQL: `robby_bans`, `robby_bantimes`, `robby_stafflogs`,
   `robby_screenshot`). Port = backend `roles[]` on the player + a
   command-descriptor registry (mirror `DA_SH.AddPlugin(Name,Ranks,Type,Args,
   Priority)`) + menu admin route; permission checks server-side.

## Still open after this pass

- `STEAM_WEB_API_KEY` (user secret) → live Steam login.
- Fuller earn loop: `OV.reward`/`OV.endMatch` stubs → match-end rewards via
  `/v1/matches/end`; the full Devolved AddEXP formula (kill streaks, round
  bonuses) beyond the flat 5-bucks/15-xp kill-reward seed. (The in-game
  charge/reward path itself is DONE: `POST /v1/economy/server/charge` +
  `/v1/economy/server/reward`, server-secret auth vs `game_servers`, ledger
  reasons `game:<serverId>:<reason>`; the addon persists cade costs with
  revoke-on-insufficient-bucks and soft-debit network fallback.)
- ~~Trading, market~~ DONE: `/v1/economy/market/*` (list/browse/buy/cancel/mine,
  escrowed listings, `market:buy:`/`market:sale:` ledger) and
  `/v1/economy/trade/*` (offer/list/accept/decline/cancel, atomic two-lock
  accept, `trade:<id>:send|receive` ledger) per
  `docs/ECONOMY_TRADE_MARKET_API.md`; menu has Market + Trades tabs and a
  lottery-style crate reel (server-rolled `won`, weighted 50-tile strip).
- ~~Steam login stuck~~ DONE: Steam OpenID web login (`/v1/auth/steam/openid/*`)
  for the Electron launcher (popup via `OV.steamLogin()`) and plain browsers
  (`#ovtoken` return); in-game ticket flow got never-hang C++ error callbacks
  (needs CI Windows-DLL rebuild to show in the launcher-run client) plus a 20s
  page-side watchdog (live immediately).
- Timed crate drops (playtime pacing), quests runtime, gangs, scratch cards,
  item expiry, special craft combos, admin system (phase 7).
