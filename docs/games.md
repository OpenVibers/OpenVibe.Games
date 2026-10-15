# Games on the base

## Scraplandia

The default place (`GAMES_PLACE_ID=scraplandia`) loads `SCRAPLANDIA_PACK`. Its persistent
world, inventory, crafting, farming, PvP rules, and editor behavior stay as before. Extraction
events are the scored "Haul" mode: a living player who holds the recovery-bird circle secures
their at-risk valuables, and each secured stack scores `count × valuable.points` haul points.
The pack defines a first-visit achievement and three haul achievements (First haul, Big haul,
Haul week), all unlocked by server-confirmed events.

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
Scraplandia hauls are stored one row per extraction in `game_hauls`, keyed by account and
extraction event; its leaderboard ranks by the sum of haul points in the period rather than a
single best. `game_achievements` stores one unlock per game, criterion and player. Local guest
keys are SHA-256 hashes as for characters; Network subjects remain canonical. No score is written
until the server confirms a round or extraction. `GET /api/v1/games/:game/leaderboard?period=all|week&page=1`
reads the game's board on OpenVibe.Play (below): 25 entries per page (`rank`, `name`, `score`, `signedIn`, with
`pages` and `total`), kept 15 s, the viewer's address forwarded so Play's per-address limits count the viewer; 503
`boards_unavailable` when Play cannot be read. `week` starts Monday 00:00 UTC. `GET /api/v1/players/me/achievements` accepts the same
bearer or `X-Guest-Token` used by the ticket endpoint. Public reads have per-address limits.
The read-only `/leaderboard.html` page shows Salvage Rush's best round scores and Scraplandia's summed haul points, switchable in the page, all time or this week (from Monday 00:00 UTC), 25 a page.
Network account exports include results, best scores, unlocks and hauls; account erasure removes them.
Guest character adoption and Network subject merges move progression (including hauls) to the surviving subject.

## Creator worlds

`/worlds` lists the worlds players built and published; a signed-in OpenVibe account (not a guest) can keep up to
five (`GAMES_CREATOR_WORLDS_PER_PERSON`). A world is made at `/worlds`, built in the map editor at
`/editor?world=<id>` and played at `/play?world=<id>`.

- **Storage:** `creator_worlds` (migration 0010) holds the title, summary, status (`draft`, `published`, `hidden`)
  and the editor's v2 map document; `revision` is its hash and the editor's `If-Match`.
- **Editing:** the owner alone, over `PUT /api/worlds/:id/map`, with no collaboration socket (`/editor-ws` stays
  staff-only). Creator maps use the built-in materials: no uploaded textures, models or paint masks (they wait for
  the Pics safety pipeline), and smaller limits than staff maps (`CREATOR_MAP_LIMITS`: 2 MB, 4,000 statics, 16
  terrains, 400 nodes and props, 64 lights and zones). A save reaches a running world at once.
- **Running:** a world is the place `world:<id>` with the plain creator pack (`creatorWorldPack`, the same def set
  on server and client) and its map as the override. It starts on the first join (inside the router's admission
  chain), runs one room of `GAMES_CREATOR_WORLD_PLAYERS` (16), and stops after `GAMES_CREATOR_WORLD_IDLE_SECONDS`
  (180) empty. At most `GAMES_CREATOR_WORLDS_MAX` (2) run at once, so Scraplandia's tick keeps its budget; a join
  beyond that closes with 4005 `world_unavailable` and the client says the world is not open right now.
- **Sandbox:** characters are read but never saved in a creator world (`worlds/sandboxStore.ts`), and the room has
  no NPCs, world events, rewards, boards or events. Nothing gathered, crafted, traded or dropped in somebody's world
  reaches Scraplandia, the leaderboards or the Inventory. The world's own rows (props, constraints, clock) persist.
- **Who joins:** anyone for a published world; the owner for a draft; games staff for any. Staff
  (`staff.games.manage` or `staff.moderation.chat`) take a world down with `PATCH {status: "hidden"}`; the owner
  cannot publish it again. Deleting a world removes its place's rows. A world's first publication is the event
  `games.world.published` (OpenVibe.Quest's "Publish a creator world"); staff hiding, restoring or deleting someone
  else's world is a `games.moderation.action` (`world.hidden`, `world.restored`, `world.deleted`). Worlds are in the account export, follow an
  account merge and go with an account deletion.
- **Pages and Search:** a published world has its own page at `/worlds/<id>` (server-rendered, the link to share)
  and is an OpenVibe.Search document (`games.index_document.upserted`, contracts 0.195.0, through
  `openvibe-publishing/search-feed` and the event outbox; sequencer `games_index_revisions`, migration 0011). A
  draft, hidden or deleted world is a tombstone; a sweep a minute after boot and every six hours catches up.

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

OpenVibe.Play (play.openvibe.network, contracts 0.172.0) is the network's home for these per-title results,
achievements and leaderboards. With `GAMES_PLAY_URL` set, Games registers both titles there (Scraplandia's weekly
haul board sums extractions; Salvage Rush's board ranks each player's best round) and posts every round, haul, unlock
and guest adoption from the local tables (`apps/server/src/platform/playSync.ts`, position in `play_sync`). Every post
is idempotent, so the first run imports the history. The in-game boards read Play's (`apps/server/src/platform/playBoards.ts`).
The local tables stay as the record the achievement rules read (a haul's weekly total, a round's unlocks) and the sync's
source; nothing reads them for a board.
