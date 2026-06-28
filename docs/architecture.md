# Architecture

OpenVibe: Source uses Source dedicated servers for gameplay and OpenVibe.Games as the central account/orchestration platform.

## Services

```text
Source client
  → OpenVibe main menu
  → Steam auth / dev auth → OpenVibe.Games API
  → Hub SRCDS (portal pads → direct connect)

Hub SRCDS                         ov_hub.nut
  → portal pads (trigger → connect)
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

## Next C++ Work

The current portal pads use `point_clientcommand` with hardcoded `connect` commands.
Replace this with a proper authenticated travel flow:

```text
1. Player steps on portal pad → VScript prints [OV] TRAVEL_REQUEST steamId mode
2. Sidecar calls /v1/travel/request → gets { connect, joinToken }
3. Sidecar sends RCON command: ov_send_travel {userId} {connect} {joinToken}
4. C++ ConCommand parses the command, sends connect + token to the client
5. Destination server receives player + token
6. Server VScript prints [OV] ARRIVAL steamId token
7. Sidecar calls /v1/travel/validate → confirms token is valid
```

Or with a C++ HTTP client built into the GameDLL:

```text
ov_join prophunt   → ConCommand calls /v1/travel/request
                   → receives { connect, joinToken }
                   → engine.ClientCommand("connect {connect}")
                   → token stored for validation on arrival
```
