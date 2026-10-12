# Games on the base

## Scraplandia

The default place (`GAMES_PLACE_ID=scraplandia`) loads `SCRAPLANDIA_PACK`. Its persistent
world, inventory, crafting, farming, PvP rules, and editor behavior stay as before. The
pack defines a first-visit achievement unlocked by a server-confirmed join. Its leaderboard
is public but empty until Scraplandia has a scored game event.

## Salvage Rush

The same Games server process also loads `SALVAGE_RUSH_PACK`: a flat 44-metre arena
with primitive obstacles and eight virtual scrap pickup points. Players move on foot. After
a 10-second intermission, a 90-second round begins. Crossing within 1.5 metres of an available
pickup scores one point; it respawns after eight seconds. Ties share a rank. The server reads
positions from its movement simulation; clients have no score intent. A room has its own round.
The HUD shows phase, remaining time and scores. The Tab menu's Achievements panel reads the player's
unlock list in both games. `/play?game=salvage-rush` fetches its own content and joins a Salvage
Rush room on the same WebSocket endpoint. A missing or unknown place in `hello` joins the
`GAMES_PLACE_ID` default. Each place has its own map, world rows, instance registry and room
leases. Room transfers remain within their place. The editor map applies to the configured
default place; Salvage Rush currently uses the map in its built-in content pack.

Completed results are stored in `game_round_results`, keyed by game, round and account key.
`game_best_scores` holds each player's all-time best; weekly bests come from the results table.
`game_achievements` stores one unlock per game, criterion and player. Local guest keys are
SHA-256 hashes as for characters; Network subjects remain canonical. No score is written
until a server round ends. `GET /api/v1/games/:game/leaderboard?period=all|week&page=1`
returns 20 personal bests per page, ordered by score, then earliest completion. `week`
starts Monday 00:00 UTC. `GET /api/v1/players/me/achievements` accepts the same
bearer or `X-Guest-Token` used by the ticket endpoint. Public reads have per-address limits.
The read-only `/leaderboard.html` page shows Salvage Rush's best round scores, all time or this week (from Monday 00:00 UTC), 20 a page. Scraplandia has no scored mode, so it has no board yet.
Network account exports include results, best scores and unlocks; account erasure removes them.
Guest character adoption and Network subject merges move progression to the surviving subject.

## Adding another game

1. Create a `games-content@2` built-in pack with a validated map document and declarative
   rules and achievements. Keep game-specific logic behind a place check.
2. Add a server gameplay module that reads simulated state and emits completed results.
   Never expose score writes as client intents.
3. Add the place to server boot and content selection, with its own `InstanceRegistry`,
   persistence store and gameplay module. Add a client HUD behind a dynamic import and a
   local portal card.
4. Add lifecycle, score integrity, criteria, persistence, join routing and API tests.
   More Games processes may later be used for scale.

OpenVibe.Play is the later home of these per-title results, achievements and leaderboards.
The local tables and APIs are the seed for that extraction; Play is not yet running.
