# Cutover — content runtime `games-content@2` (OpenVibe.Games PR #7)

This runbook is the cutover for the one data-facing change in PR #7: the content runtime a mod
install records moves from `games-content@1` to `games-content@2`
(`apps/server/src/mods/manifest.ts`), packs may now carry `defs`/`map` sections and
`games-quickjs@1` script mods (`packages/content/src/schema/scriptMod.ts`), and
`packages/persistence/src/dto.ts` documents the new runtime id.

**No SQL migration ships with this PR, and none is needed.** The `mods`, `mod_grants`,
`mod_placements` and `mod_audit` tables and their column types are unchanged; `mods.runtime` is a
plain `text`. Only the value a _new_ install records and the sections a pack may carry change. Every
`games-content@1` pack already stored had `announcements`/`props` only, which are a strict subset of
the v2 pack schema, and the boot path (`ModRegistry.load` → `loadDefinitionPacks`) re-reads installs
without re-running `checkForGames`, so the new build keeps running them as they are. Nothing rewrites
a row, so the cutover is a release, and the way back is the previous release.

## What changes

| Thing                                             | Before (`games-content@1`)   | After (`games-content@2`)                                                       |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| New install's `runtime` / `compatibility.runtime` | `games-content@1` / `^1.0.0` | `games-content@2` / `^2.0.0`                                                    |
| Pack sections                                     | `announcements`, `props`     | plus `defs`, `map` (each needs `games.def.define`)                              |
| Pack mods (`mods: [...]`)                         | none                         | `games-quickjs@1` script mods                                                   |
| Executable mods                                   | refused                      | still refused through the install API; a script mod ships with the place's code |
| Script mods at runtime                            | —                            | off unless `GAMES_SCRIPT_MODS=1` (or `true`) is set for the instance            |

Existing installs keep `mods.runtime = 'games-content@1'`. That is expected, not a fault: the install
API re-validates only on `POST /api/v1/mods` (install), never on enable, grant or boot.

## Order of operations

1. **Back up** the four mod tables (below) and keep the previous release checkout for rollback.
2. **Deploy** the release. The SDK migrator applies `packages/persistence/migrations` at boot as the
   owner; there is nothing new to apply.
3. **Verify** `/api/ready`, the existing installs, and one fresh `games-content@2` install.
4. **Way back** only if verification fails: `deploy.sh --rollback`; the mod tables were not edited, so
   the dump is a belt-and-braces restore, not a step in the normal path.

Do not edit `mods.runtime` or the stored `manifest`/`pack` jsonb by hand: an old row is not a
migration debt, and rewriting the jsonb would change what the install API reports without changing
what runs.

## Backup

The only rows whose meaning changes are the mod tables; take a consistent, compressed dump as the
owner (a direct connection, not PgBouncer):

```bash
pg_dump "$DATABASE_DIRECT_URL" -Fc \
  -t mods -t mod_grants -t mod_placements -t mod_audit \
  -f /var/backups/openvibe-games-mods-pr7.dump
pg_restore --list /var/backups/openvibe-games-mods-pr7.dump | tail
```

Keep the dump until the release has served a full cycle. The world tables (`places`,
`world_entities`, …), the map file under `MAP_PATH` and the editor assets are untouched by this
change and are not part of the cutover.

## Deploy

```bash
sudo /opt/openvibe.games/deploy/scripts/deploy.sh --wait-idle
```

`--wait-idle` holds the restart until nobody is playing. ovhost pulls, builds and restarts; on failure
it restores and rebuilds the previous checkout and restarts it (exit 3), so no separate abort step is
required. The boot migrator applies the same `0001_initial.sql` that is already applied and adds
nothing.

## Verification

1. **Readiness.** `curl -s https://openvibe.games/api/ready | jq .status` → `"ready"` with
   `checks.db` and `checks.tick` both ok.
2. **Existing installs still load.** `curl -s https://openvibe.games/api/v1/mods | jq '.mods[] |
{id, runtime, status}'` lists every install that was there before; an enabled install is still
   `enabled` with its grants, and its `runtime` reads `games-content@1`. A `games-content@1` value
   here is the point of the cutover, not a failure.
3. **Play the place.** The props and periodic announcements of an existing install are still in the
   world after the restart; `journalctl -u openvibe-games | grep -i 'mod '` shows no
   `manifest cannot run here` and no `mod definitions skipped` for an install that used to load.
4. **A fresh install takes the new runtime.** From a staff session,
   `POST /api/v1/mods` with `runtime: "games-content@2"`, `compatibility.runtime: "^2.0.0"` and a
   `defs` section is accepted (a `games-content@1` manifest is refused by the same endpoint with
   `mod.runtime_unsupported`). Restart the instance (defs merge at boot), then a client connects
   without `content_mismatch`, i.e. the def-set digest matches.
5. **Script mods stay off unless enabled.** Without `GAMES_SCRIPT_MODS` the log has
   `script mods off for this place` and the mods still sit in the def set (the digest does not depend
   on the flag).

## Way back

The change is additive, so the previous release starts on the same schema:

```bash
sudo /opt/openvibe.games/deploy/scripts/deploy.sh --rollback
```

`ovhost rollback games` rebuilds the previous commit and restarts it. There is no down migration: the
new rows a `games-content@2` install may have written are valid rows the old build ignores or refuses
to re-validate. If, and only if, someone edited the mod tables during the window, restore them from
the dump into a scratch database first and compare before applying:

```bash
pg_restore --data-only -t mods -t mod_grants -t mod_placements -t mod_audit \
  -d "$SCRATCH_DATABASE_DIRECT_URL" /var/backups/openvibe-games-mods-pr7.dump
```

## Rehearsal

Run on a scratch PostgreSQL: main's migrations, the repository's fixtures, this PR's migrations
(none), then the commands below. The base schema is already the cutover schema, so the block proves
that claim and that a legacy `games-content@1` row survives a round trip unchanged — no `UPDATE`, no
rewrite, no DDL.

```rehearse
migrations: packages/persistence/migrations
seed: none
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name in ('mods','mod_grants','mod_placements','mod_audit')" | grep -qx 4
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "select data_type from information_schema.columns where table_schema='public' and table_name='mods' and column_name='runtime'" | grep -qx text
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "begin; insert into mods (id,name,version,target,runtime,manifest,pack,trust_tier,status,installed_by,installed_at,updated_at) values ('cutover-legacy','Cutover legacy','1.0.0','games.browser','games-content@1','{\"runtime\":\"games-content@1\",\"compatibility\":{\"runtime\":\"^1.0.0\"}}'::jsonb,'{\"props\":[]}'::jsonb,'unreviewed','enabled','cutover',1,1); select runtime from mods where id='cutover-legacy'; rollback;" | grep -qx "games-content@1"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "select count(*) from mods where id='cutover-legacy'" | grep -qx 0
```
