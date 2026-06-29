# Architecture

OpenVibe: Source uses Source dedicated servers for gameplay and OpenVibe.Games as the central account/orchestration platform.

## Services

```text
Source client
  → OpenVibe VGUI menu / launcher
  → Steam auth / dev auth → OpenVibe.Games API
  → Hub SRCDS (portal pads → ov_join)

Hub SRCDS                         ov_hub.nut
  → portal pads (trigger → ov_join <mode>)
  → shop NPC / inventory station
  → sidecar → /v1/servers/heartbeat

Minigame SRCDS × 4                ov_prophunt.nut
  → Prop Hunt                     ov_deathrun.nut
  → Deathrun                      ov_fortwars.nut
  → Fort Wars                     ov_traitortown.nut
  → Traitor Town
  → sidecar → /v1/matches/end

Sidecar (ov-sidecar.mjs)
  → tails SRCDS log file
  → routes [OV] events to API
  → sends 30 s heartbeat

Backend API (Fastify/TypeScript)
  → /v1/auth/{dev,steam}
  → /v1/me  /v1/shop  /v1/equip
  → /v1/assets/manifest
  → /v1/servers/{register,heartbeat}
  → /v1/travel/{request,validate}
  → /v1/matches/end
  → /v1/leaderboard
  → /v1/admin/shop/items

PostgreSQL
  → players, currency_ledger
  → shop_items, player_items
  → game_servers, join_tokens
  → match_results

Redis (optional)
  → auth sessions

CDN/static hosting
  → cosmetic assets served under openvibe.games
```

## Modes

| Mode | Map | Port | VScript | Purpose |
| --- | --- | ---: | --- | --- |
| Hub | `ov_hub` | 27015 | `ov_hub.nut` | Social lobby, portals, NPCs, shops |
| Prop Hunt | `ph_openvibe_dev` | 27016 | `ov_prophunt.nut` | Props vs hunters prototype |
| Deathrun | `dr_openvibe_dev` | 27017 | `ov_deathrun.nut` | Runner/trap prototype |
| Fort Wars | `fw_openvibe_dev` | 27018 | `ov_fortwars.nut` | Build/combat prototype |
| Traitor Town | `tt_openvibe_dev` | 27019 | `ov_traitortown.nut` | Social deduction prototype |

## Trust Model

- Clients do not mutate currency or inventory directly.
- Source servers validate join tokens before allowing authenticated travel.
- Match rewards are idempotent by `match_id + steam_id`.
- Server heartbeat and reward APIs require `serverSecret`.
- The backend owns item IDs, asset paths, prices, and equipped cosmetics.
- Admin endpoints require `X-Admin-Secret` header.
- Production Steam auth is done by the backend calling Steam Web API ticket validation. The client never receives the Steam Web API publisher key.

## VScript → API Event Protocol

VScript cannot make HTTP requests directly.  The sidecar bridges the gap:

1. VScript prints `[OV] EVENTTYPE data…` to the SRCDS server console.
2. SRCDS writes the line to `game/openvibe.games/logs/lDDMMNNN.log`.
3. `ov-sidecar.mjs` tails the log file and routes events to the REST API.

| Event | Fields | API call |
|-------|--------|----------|
| `BOOT` | `serverId mode` | `POST /v1/servers/register` |
| `HEARTBEAT` | `serverId count max state` | `POST /v1/servers/heartbeat` |
| `REWARD` | `matchId serverId secret uid mode coins xp` | `POST /v1/matches/end` |
| `SAY` | `message…` | log only |

## C++ Travel Flow

The authenticated travel flow is implemented for rebuilt OpenVibe client DLLs:

```text
1. Player steps on portal pad.
2. The map fires `point_clientcommand -> ov_join <mode>`.
3. Client C++ calls `/v1/travel/request` with SteamID + mode.
4. Backend reserves a short-lived join token and returns `{ connect, joinToken }`.
5. Client stores the token in userinfo and runs `connect host:port`.
6. Destination server reads the token after player activation.
7. Server C++ validates the token with `/v1/travel/validate`.
```

The checked-in dev BSPs currently use direct local `connect` commands as a Proton fallback. Regenerate VMFs with `OPENVIBE_USE_OV_JOIN=1` to bake the authenticated path into portal pads.

## GameDLL Feature Hooks

Tracked C++ patch sources live under `sdk/openvibe/` and are copied into the local Valve SDK checkout by `tools/apply-openvibe-sdk.sh`.

| Feature | Command / hook | Notes |
| --- | --- | --- |
| Authenticated travel | `ov_join <mode>` | Client HTTP travel request + connect. |
| Arrival validation | `ClientActive` hook | Server validates `ov_join_token`. |
| Main menu | `openvibe_menu`, `ov_menu` | VGUI hub selector. |
| Steam auth | `ov_auth_steam` | Client obtains Steam Web API ticket; backend validates it. |
| Prop Hunt disguise | `ov_prophunt_disguise`, `ov_prophunt_reset_disguise` | Server-side allowlisted model swap. |
| Fort Wars placement | `ov_fortwars_spawn` | Server-side allowlisted physics prop spawn. |
