# Live legacy game data: import, map or exclude

Roadmap Wave 12 migration gate: OpenVibe.Live's legacy HoboQuest and canvas
data is either imported into OpenVibe.Games or excluded with a recorded
reason, and every source row is reconciled.

**Status (2026-09-23):** decisions recorded, importer and tests in place,
dry run done on copies of both production databases (below).
**Not applied to production.** The owner runs the apply after review
([host commands](#production-run)).

- Importer: [`apps/server/scripts/importLiveLegacy.ts`](../apps/server/scripts/importLiveLegacy.ts)
  (CLI) and [`apps/server/src/platform/liveLegacyImport.ts`](../apps/server/src/platform/liveLegacyImport.ts)
  (decisions, mapping, reconciliation).
- Tests: [`apps/server/src/platform/liveLegacyImport.test.ts`](../apps/server/src/platform/liveLegacyImport.test.ts).
- Destination: `legacy_live_rows` in `world.db` (schema 13).

## What the legacy data is

Until it was retired, Live ran two things that Games is now supposed to own:

- **HoboQuest**: a 2D, tile-based RPG with a procedural world (its seed
  is in `game_world_state`). It had eight skills (mining, fishing, woodcut,
  farming, combat, crafting, agility, smithing) with an uncapped curve
  (`level = floor(sqrt(xp / 25)) + 1`). Players hold 253 distinct item ids
  (ores, fish, loot, gems, tools, rods, hats, cosmetic effects, joke items)
  and 128 unlocked recipe ids. It also had achievements, a bank, dungeons,
  daily quests and tile buildings. The game was removed from Live (`server/index.js`: "Game &
  Canvas — migrated to openvibe.games"), but the tables stayed and one path
  still writes to them. [See below](#live-still-creates-game_players-rows).
- **Canvas**: an r/place-style 512×512 pixel board with placement
  cooldowns and moderation. Production data covers one day (2026-03-15), three
  accounts, 429 placements and 417 blocked attempts. Live's `/canvas` still
  301-redirects to `https://openvibe.games/canvas`, which serves the Games
  portal: there is no canvas in Games.

Scraplandia (Games) is a different game: a 3D physics sandbox with six
skills (woodcutting, mining, scavenging, farming, crafting, construction,
capped at 50 with `xpToNextLevel = 60 · level^1.45`, 347,327 XP to reach 50),
59 item definitions, blueprint unlocks by recipe id, per-account character
slots, and no achievement, fishing, bank, dungeon or daily-quest system.

Measured against the production copy:

- 1 of the 253 distinct HoboQuest item ids in inventories and banks exists
  in Scraplandia's content: `fertilizer`, a name collision (a HoboQuest
  farm consumable versus a Scraplandia crop input). It is not the same item.
- 0 of the 128 HoboQuest recipe ids exist as a Scraplandia recipe or item.
- 22 of the 70 `game_players` rows have any XP; 13 have XP in one of the four
  skills whose names also exist in Scraplandia (mining, woodcut, farming,
  crafting). The largest is 840,227 mining XP (HoboQuest level 184): copied
  1:1 it would be 2.4× the XP needed to max Scraplandia mining.

## Decisions

Three outcomes are possible for a table:

- **import**: the row is copied, whole and unchanged, into
  `legacy_live_rows` under its owner's Network subject;
- **map**: the row is translated into Scraplandia's gameplay model
  (characters, inventories, skills, unlocks);
- **exclude**: the row is not copied, and the reason is recorded here and in
  `LEGACY_TABLES`.

**No table is mapped.** Every per-player HoboQuest table is imported as an
archive, and nothing is written into Scraplandia's gameplay state:

1. Items and recipes have no counterpart (above). A map would drop all but a
   name collision.
2. Skill XP comes from a different game with a different, uncapped curve.
   Scraplandia levels unlock recipes and interactions. A raw copy would max
   the top players on day one. A rescaled copy would still give Scraplandia
   progression for play that did not happen in Scraplandia. Either way this
   is a game-design decision, not a migration step.
3. A Scraplandia character is created by its player (name, slot,
   appearance) under their account key. Making characters for 11 accounts
   that may never have opened Scraplandia would put characters they did
   not create into their slots.

The archive keeps every column of every imported row, keyed by subject. A
later feature (a "HoboQuest veteran" cosmetic, a legacy profile tab, a
tuned skill grant) can read it without going back to Live. `ADR-0006`
applies: rows are keyed by the canonical `usr_…` subject, never by Live's
integer id (the Live id is stored beside it for audit).

| Live table                                                                        | Rows | What it is                                                                                                                              | Equivalent in Games                                                                                                       | Decision         | Reason                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game_players`                                                                    |   70 | HoboQuest profile: tile position, 8 skill XPs, HP/attack/defense/stamina, 6 equipment slots, sleeping bag, cosmetics, lifetime counters | Partial: `players` has skills (4 of 8 skill names overlap), armor slot, appearance; no stamina, equipment slots, counters | import (archive) | Different game, curve and cap; no character to attach to (see above). **47 placeholder rows are excluded row by row** ([below](#live-still-creates-game_players-rows)) |
| `game_inventory`                                                                  |  399 | Carried item stacks `(user, item_id, quantity)`                                                                                         | `players.inventory` (slot-based, Scraplandia item ids)                                                                    | import (archive) | 252 of 253 item ids have no Scraplandia item; the remaining one is a name collision                                                                                    |
| `game_bank`                                                                       |  115 | Banked item stacks (safe on death)                                                                                                      | None (no bank; storage boxes are world props)                                                                             | import (archive) | As above                                                                                                                                                               |
| `game_achievements`                                                               |  122 | Completed achievements (26 ids)                                                                                                         | None: Scraplandia has no achievement system (README)                                                                      | import (archive) | Nothing to map onto; kept for a future legacy badge                                                                                                                    |
| `game_recipes`                                                                    |  140 | Unlocked recipes                                                                                                                        | `players.unlocks` (blueprint recipe ids)                                                                                  | import (archive) | 0 of 128 recipe ids exist in Scraplandia                                                                                                                               |
| `game_fish_collection`                                                            |   13 | Fish album (times caught, best weight, first catch)                                                                                     | None (no fishing)                                                                                                         | import (archive) | Nothing to map onto                                                                                                                                                    |
| `game_battle_stats`                                                               |    3 | PvP record (wins, losses, streaks, stolen/lost)                                                                                         | None persisted (combat exists, no record)                                                                                 | import (archive) | Nothing to map onto                                                                                                                                                    |
| `game_structures`                                                                 |    1 | A furnace on tile (4, 190)                                                                                                              | World props are 3D physics entities in a different world                                                                  | import (archive) | No position or object mapping exists; kept as an ownership record                                                                                                      |
| `game_farm_plots`                                                                 |    0 | Tile farm plots                                                                                                                         | Planter boxes (world props)                                                                                               | import (archive) | Empty; listed so a non-empty snapshot would still be handled                                                                                                           |
| `game_world_state`                                                                |    1 | Seed of HoboQuest's procedural world                                                                                                    | Scraplandia's world is its own definition (`world_id` in `meta`)                                                          | exclude          | Describes a world that no longer exists                                                                                                                                |
| `game_daily_quest_progress`                                                       |  131 | Per-day quest counters, 2026-03-10 to 2026-03-17                                                                                        | None                                                                                                                      | exclude          | Daily quests reset each day; these days' quests can no longer be claimed                                                                                               |
| `game_daily_quest_claims`                                                         |    0 | Claimed daily quests                                                                                                                    | None                                                                                                                      | exclude          | Empty; past days only                                                                                                                                                  |
| `game_effects`                                                                    |    0 | Timed buffs                                                                                                                             | Status effects are runtime state                                                                                          | exclude          | Empty; any buff would have expired                                                                                                                                     |
| `game_dungeon_runs`                                                               |    0 | Dungeon sessions                                                                                                                        | None                                                                                                                      | exclude          | Empty; session state                                                                                                                                                   |
| `game_leaderboard`                                                                |    0 | Leaderboard cache                                                                                                                       | None                                                                                                                      | exclude          | Empty; derived from `game_players`                                                                                                                                     |
| `canvas_tiles`                                                                    |  375 | Current pixel of each painted tile, with painter id, username and **IP address**                                                        | None                                                                                                                      | exclude          | Canvas is not a Games feature. The rows carry IP addresses                                                                                                             |
| `canvas_actions`                                                                  |  846 | Placement and "blocked" log, with IP addresses                                                                                          | None                                                                                                                      | exclude          | As above                                                                                                                                                               |
| `canvas_settings`                                                                 |    8 | Board size, palette, cooldowns                                                                                                          | None                                                                                                                      | exclude          | Configuration of the excluded board                                                                                                                                    |
| `canvas_snapshots`, `canvas_bans`, `canvas_region_locks`, `canvas_user_overrides` |    0 | Canvas snapshots and moderation                                                                                                         | None                                                                                                                      | exclude          | Empty                                                                                                                                                                  |

**Canvas.** The pixel board belongs with Live's community features, or with a
future product, not with Scraplandia. Its data stays in Live's database and
backups until the owner decides whether Live drops it. The excluded rows are
counted in every reconciliation. Follow-up for Live: the `/canvas` redirect
now lands on the Games portal, so it should be removed or pointed at a
notice.

**Legacy tables named in the gate:** `game_players` 70, `game_inventory` 399,
`game_bank` 115, `game_achievements` 122, `game_recipes` 140, `canvas_tiles`
375, `canvas_actions` 846. These match the audit. The importer also covers the
other game and canvas tables. If a `game_*` or `canvas_*` table appears
without a decision, the run is marked not reconciled and `--apply` refuses.

### What the archive loses

- **Nothing inside an imported row.** The payload is the full source row as
  canonical JSON (sorted keys). Integers and reals stay JSON numbers, and
  `DATETIME` values stay the text Live stored (UTC, `YYYY-MM-DD HH:MM:SS`).
- **The link to Live's `users` row.** The owner is re-keyed to the Network
  subject. The Live user id is kept in `live_user_id`, and the payload's own
  `user_id`/`owner_id` column still holds it.
- **Held rows are not imported** (listed below) until their owner gets a
  Network subject. Excluded tables, and the placeholder `game_players`
  rows, are not imported at all. The placeholder rows hold only defaults.
- **Nothing in Scraplandia changes.** No character, inventory, skill or
  unlock is created or modified. `live_user_id` and the payload are kept for
  whoever designs a legacy grant.

### Live still creates `game_players` rows

Live's chat profile routes (`server/chat/routes.js` and
`server/chat/live-context-routes.js`) still call `game.getPlayer(userId)` to
show game levels on a profile. That function inserts a default row, at the
outpost spawn, for any user who has none. `game_players` therefore grows
with every new profile Live shows. Its newest row is from 2026-09-19, and 47
of the 70 rows are such placeholders.

The importer excludes a `game_players` row one by one
(`isPlaceholderPlayer`) when all of these hold:

- it was never acted on (`last_action = created_at`);
- every XP, `total_*`, `battle_*`, `structures_built` and
  `resources_gathered` column is 0;
- it has no equipment, sleeping bag, name/particle effect or sprite skin;
- its user owns no row in any other legacy game table.

Rows of real players are not affected. The exclusion shows in the report as
`excluded` under `game_players`. A placeholder created after the dry run is
excluded the same way, so the counts still reconcile.

Follow-up for Live, not done here: make that profile lookup read-only, so
the table stops growing before Live drops it.

## Identity mapping

A row's owner is its Live user id (`user_id`, or `owner_id` for
`game_structures`). The Live user id becomes a subject like this:

1. **The Network is the authority.** The importer calls the Network identity
   service (`POST /internal/identity/resolve-batch` with
   `{ system: 'live', type: 'user', ids }`) as the `games` service principal,
   which already holds the grant `identity.subject.resolve` on
   `openvibe.network`. The Network answers from its `identity_legacy_map`, which
   holds 327 `live/user` rows.
2. **Live's own record is a cross-check.** Live stores the subject a signed-in
   user's token carried in `linked_accounts(service = 'network').subject_id`.
   On production only 1 of 327 Network links has it filled, so on its own it
   is not a usable source.
3. A row is **held**, never guessed, when:
   - the Network does not know the Live user (`no-subject`);
   - Live has a subject that the Network does not confirm (`subject-unconfirmed`);
   - Live and the Network disagree, or Live has two (`subject-conflict`);
   - the row names no user (`no-owner`);
   - the row was already imported with different content
     (`differs-from-earlier-import`: an import is never overwritten).

   The run lists held rows by Live user, with their source keys.

For an offline dry run, `--subjects <file>` takes the same answers as a JSON
object `{ "<live user id>": "usr_…" }` exported from the Network (command
below). `--apply` requires `--subjects network` or such a map.

On 2026-09-23 both sources were checked on the host for the 70 Live users
that own importable rows. The identity service (games principal) and the
exported map agreed on all 70: 49 resolved, 21 unknown, 0 disagreements.
After the placeholder rows are excluded, 23 Live users still own
importable rows: 11 resolve and 12 are held.

The 12 held users are Live accounts created 2026-03-10 to 2026-03-15 and
last seen the day they were created. They have no linked account of any
kind and no password, so nobody can sign in to them any more (Live is
SSO-only). None of them appears in the Network's `live` or `hobostreamer`
legacy maps. If the Network later records a verified `live/user/<id>`
mapping for one of them (`POST /internal/identity/legacy-map`), re-run the
importer. The test "picks up rows whose subject appears later" checks that
only that user's rows are written.

Re-checked 2026-09-24 (dry run against a fresh Live snapshot, subjects from the
Network identity service): unchanged. 616 rows import (already in
`legacy_live_rows`), 200 rows of the same 12 users stay held (`no-subject`),
1,408 are excluded, and the totals balance. These 12 are the standing
import-hold. `players.subject_id` needs no backfill: the only Network-keyed
player (`ovn:1`) moved to its subject on 2026-09-23 (`identity_legacy_map`),
and the other 27 rows are device-token guests and deploy probes, which have
no subject until the guest signs in.

## The archive table (`world.db`, schema 13)

```sql
CREATE TABLE legacy_live_rows (
  source_table TEXT NOT NULL,     -- e.g. game_inventory
  source_key TEXT NOT NULL,       -- the source primary key, '/'-joined (e.g. '2107', '4/first_blood')
  live_user_id INTEGER NOT NULL,
  subject_id TEXT NOT NULL,       -- usr_…
  payload TEXT NOT NULL,          -- the whole source row, canonical JSON
  imported_at INTEGER NOT NULL,   -- ms epoch
  PRIMARY KEY (source_table, source_key)
);
CREATE INDEX idx_legacy_live_rows_subject ON legacy_live_rows (subject_id);
```

The table is added by the forward-only migration 12 → 13 in
`packages/persistence/src/sqlite/sqliteStore.ts`. Only the importer writes
it, and nothing in the simulation reads it.

**Idempotency.** Rows are keyed by `(source_table, source_key)` and written
with `ON CONFLICT DO NOTHING` inside one transaction. The number of rows
written must equal the plan or the transaction rolls back. A re-run of the
same snapshot writes 0 rows and reports the same `imported` counts.

## Dry run on production copies (2026-09-23)

Sources:

- `live.db` and `world.db` were copied on the host with
  `sudo sqlite3 -readonly <db> ".backup /tmp/…"` and then copied to a
  workstation. Both copies passed `integrity_check`.
- The subject map was exported read-only from the Network's
  `identity_legacy_map`.

Command: `node --import tsx apps/server/scripts/importLiveLegacy.ts --live <live copy>
--world <world copy> --subjects <exported map>`. The exit code was 0 and
the world copy was byte-identical afterwards. The local copies were deleted
after the run.

```
Live legacy import: DRY RUN (nothing written); subjects from subject map <exported from the Network identity_legacy_map>

table                      decision  read  imported  written  held  excluded  check
game_players               import      70        11       11    12        47     ok
game_inventory             import     399       316      316    83         0     ok
game_bank                  import     115        64       64    51         0     ok
game_achievements          import     122        68       68    54         0     ok
game_recipes               import     140       140      140     0         0     ok
game_fish_collection       import      13        13       13     0         0     ok
game_battle_stats          import       3         3        3     0         0     ok
game_structures            import       1         1        1     0         0     ok
game_farm_plots            import       0         0        0     0         0     ok
game_world_state           exclude      1         0        0     0         1     ok
game_effects               exclude      0         0        0     0         0     ok
game_dungeon_runs          exclude      0         0        0     0         0     ok
game_leaderboard           exclude      0         0        0     0         0     ok
game_daily_quest_progress  exclude    131         0        0     0       131     ok
game_daily_quest_claims    exclude      0         0        0     0         0     ok
canvas_tiles               exclude    375         0        0     0       375     ok
canvas_actions             exclude    846         0        0     0       846     ok
canvas_settings            exclude      8         0        0     0         8     ok
canvas_snapshots           exclude      0         0        0     0         0     ok
canvas_bans                exclude      0         0        0     0         0     ok
canvas_region_locks        exclude      0         0        0     0         0     ok
canvas_user_overrides      exclude      0         0        0     0         0     ok
TOTAL                                2224       616      616   200      1408     ok

read 2224 = imported 616 + held 200 + excluded 1408: balanced
Live users owning importable rows: 23; mapped to a subject: 11; held: 12 no-subject
Excluded rows of import tables: game_players: placeholder rows Live's profile lookup created for people who never played: 47

Held rows (by Live user; table[source keys]):
  live user 2 (no-subject): game_players[2] game_inventory[285,1376,2847,2849,2850,2854,2859,2862,2863,2867,2874,2890,2931,2939,2949] game_bank[2,12,14,27,44,59,129,189,209,210,211,212,217,225,265,456,471,709,712,759,908,1004,1048,1049,1053,1059,1062,1069,1070,1071,1266,1273,1274,1280,1284,1322] game_achievements[2/chest_open_1,2/chest_open_25,2/dragonite_found,2/explorer_10k,2/explorer_1k,2/first_blood,2/first_gather,2/gather_100,2/gather_500,2/level_10_any,2/level_25_any,2/level_50_any,2/mob_slayer_10,2/mob_slayer_50,2/total_level_100,2/total_level_50]
  live user 4 (no-subject): game_players[4] game_inventory[2107,2108,2147,2149,2163,2173,2175,2177,2178,2180,2183,2188,2198,2199,2219] game_achievements[4/chest_open_1,4/first_blood,4/first_gather,4/mob_slayer_10]
  live user 5 (no-subject): game_players[5] game_inventory[531,532,533,538,2488] game_achievements[5/chest_open_1,5/explorer_1k,5/first_blood,5/level_10_any]
  live user 7 (no-subject): game_players[7] game_inventory[2985,2986,2990,2992,2993,2995,2996,3019,3024,3025,3042,3070,3087,3090,3094,3111,3122,3132,3141,3145,3150,3152] game_achievements[7/chest_open_1,7/crystal_wood,7/explorer_1k,7/first_blood,7/first_gather,7/level_10_any,7/level_25_any,7/mob_slayer_10,7/mob_slayer_50,7/total_level_50]
  live user 10 (no-subject): game_players[10] game_inventory[2489] game_achievements[10/chest_open_1,10/first_blood,10/level_10_any]
  live user 11 (no-subject): game_players[11] game_inventory[2379,2381,2382,2384,2406,2415] game_bank[3677,3683,3684,3685,3687,3693,3695,3698,3701,3720,3727,3732,3736,3741,3742] game_achievements[11/chest_open_1,11/explorer_1k,11/first_blood,11/first_gather,11/level_10_any,11/level_25_any,11/level_50_any,11/mob_slayer_10,11/total_level_100,11/total_level_50]
  live user 23 (no-subject): game_players[23]
  live user 24 (no-subject): game_players[24] game_achievements[24/level_10_any]
  live user 25 (no-subject): game_players[25] game_achievements[25/level_10_any]
  live user 27 (no-subject): game_players[27] game_inventory[37123,37133,37139,37140,37141,37142,37144,37147,37153,37154,37155,37156,37163,37168,37170,37171,38652,38661,38662] game_achievements[27/chest_open_1,27/crystal_wood,27/explorer_1k,27/first_blood,27/first_gather]
  live user 31 (no-subject): game_players[31]
  live user 44 (no-subject): game_players[44]
  no-subject: the Live user has no Network subject

RECONCILED
```

Reading it: 616 rows would be archived for 11 subjects. 200 rows of 12
unlinkable Live accounts are held. 1,408 rows are excluded: 47 placeholder
`game_players` rows, the 131 daily-quest rows, the world seed and all 1,229
canvas rows. Every table balances.

## Production run

Run these on `openvibe-ovh`, logged in as `ubuntu` (the owner of
`/opt/openvibe.games`; `sqlite3` without `sudo` below runs as `ubuntu` so
no root-owned `-wal`/`-shm` files appear next to the service's database), after this commit is deployed to
`/opt/openvibe.games`. Deploying means pull, `pnpm install
--frozen-lockfile` (the server gained the `better-sqlite3` dependency), then
restart `openvibe-games`. On its first start the server upgrades `world.db`
to schema 13, and Live is not touched. The importer runs as `ubuntu` with
the service's environment, the same way as the service, through a
transient unit.

```bash
# --- 0. Variables ----------------------------------------------------------
TS=$(date -u +%Y%m%dT%H%M%SZ)
W=/opt/openvibe.games/data/legacy-import
RUN="sudo systemd-run --quiet --wait --pipe --collect --uid=ubuntu --gid=ubuntu \
  -p EnvironmentFile=/etc/openvibe/games.env -p WorkingDirectory=/opt/openvibe.games/apps/server \
  /usr/bin/env node --import tsx scripts/importLiveLegacy.ts"
sudo install -d -o ubuntu -g ubuntu -m 700 "$W"
curl -fsS http://127.0.0.1:8000/api/ready   # the deployed build is up

# --- 1. Snapshot Live (read-only on the production file) -------------------
sudo sqlite3 -readonly /opt/openvibe.live/data/live.db ".backup $W/live-$TS.db"
sudo chown ubuntu:ubuntu "$W/live-$TS.db" && sudo chmod 600 "$W/live-$TS.db"
sqlite3 -readonly "$W/live-$TS.db" "PRAGMA integrity_check"   # as ubuntu; expect: ok

# --- 2. Dry run (writes nothing; exit 0 = reconciled) ----------------------
$RUN --live "$W/live-$TS.db" --world /opt/openvibe.games/data/world.db --subjects network \
  | tee "$W/dry-run-$TS.txt"
# Expect the table above: read 2224 = imported 616 + held 200 + excluded 1408, RECONCILED
# (game_players grows by one placeholder, excluded, for each new profile Live shows).

# --- 3. Apply: backs up world.db to --backup, verifies it, imports in one transaction
$RUN --live "$W/live-$TS.db" --world /opt/openvibe.games/data/world.db --subjects network \
  --apply --backup "$W/world-before-$TS.db" | tee "$W/apply-$TS.txt"
# stderr: "backup written and verified (integrity_check ok): …" and "wrote 616 rows to legacy_live_rows"

# --- 4. Verify -------------------------------------------------------------
sqlite3 -readonly /opt/openvibe.games/data/world.db \
  "SELECT source_table, count(*) FROM legacy_live_rows GROUP BY 1 ORDER BY 1"
# game_achievements 68, game_bank 64, game_battle_stats 3, game_fish_collection 13,
# game_inventory 316, game_players 11, game_recipes 140, game_structures 1
sqlite3 -readonly /opt/openvibe.games/data/world.db \
  "SELECT count(DISTINCT subject_id) FROM legacy_live_rows"            # 11
sqlite3 -readonly /opt/openvibe.games/data/world.db "PRAGMA integrity_check"   # ok
$RUN --live "$W/live-$TS.db" --world /opt/openvibe.games/data/world.db --subjects network \
  | grep -E '^TOTAL|balanced|RECONCILED'   # idempotency: written 0 on every row
curl -fsS http://127.0.0.1:8000/api/ready

# --- 5. Clean up the Live snapshot (user data); keep the world backup until satisfied
sudo rm -f "$W/live-$TS.db" "$W/live-$TS.db-wal" "$W/live-$TS.db-shm"
```

The importer refuses to start (exit 2) in these cases:

- `--apply` without `--backup` or `--subjects`;
- a `--backup` path that already exists;
- a `--live` path under `/opt/openvibe.live/`, the production file;
- a world database that does not exist.

It exits 3 when the plan does not reconcile, and then writes nothing.

**Rollback.** The import only inserts into `legacy_live_rows`, so it can
be undone without touching the game:
`sqlite3 /opt/openvibe.games/data/world.db "DELETE FROM legacy_live_rows"` (as `ubuntu`).
A full restore of `$W/world-before-$TS.db` (stop the service, replace
`world.db`, remove `world.db-wal`/`-shm`, start) would also discard any
player progress made since the backup. Use it only if `world.db` itself is
damaged.

**Offline dry run.** This is how the run above was made. It needs no
service secret. Export the map on the host, then pass it with
`--subjects <file>`:

```bash
sudo sqlite3 -readonly /opt/openvibe.network/data/network.db \
  "SELECT json_group_object(m.source_id, m.subject_id) FROM identity_legacy_map m
   JOIN users u ON u.subject_id = m.subject_id
   WHERE m.source_system = 'live' AND m.source_type = 'user'" > live-subjects.json
```
