import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openTestDb } from '../testing.js'
import { MIGRATIONS_DIR } from '../migrations.js'

/**
 * The surf place rename (migration 0019) moves the old `surf-lagoon` rows to
 * `surf_lagoon` without losing a character's saved room position, and keeps an
 * already-canonical row when both exist during a rolling deploy.
 */
const MIGRATION = readFileSync(join(MIGRATIONS_DIR, '0019_surf_place_ids.sql'), 'utf8')

const OLD = 'surf-lagoon'
const NEW = 'surf_lagoon'

async function seedCharacter(
  db: Awaited<ReturnType<typeof openTestDb>>,
  id: string,
  placeId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO characters
       (id, account_key, slot, name, place_id, pos_x, pos_y, pos_z, yaw, inventory, updated_at)
     VALUES ($1, $2, 0, 'Surfer', $3, 1, 2, 3, 0, '[]'::jsonb, 100)`,
    [id, `usr_${id}`, placeId],
  )
}

describe('surf place id migration', () => {
  it('moves places, instances, positions, characters and world state to the map id', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO places (id, name) VALUES ($1, 'Surf Lagoon')`, [OLD])
    await db.query(
      `INSERT INTO game_instances
         (place_id, slot, id, capacity, state, holder, lease_version, heartbeat_at, lease_until)
       VALUES ($1, 0, $2, 8, 'running', 'old-holder', 3, 100, 200)`,
      [OLD, `${OLD}:0`],
    )
    await seedCharacter(db, 'char-old', OLD)
    await db.query(
      `INSERT INTO character_instance_positions
         (character_id, instance_id, pos_x, pos_y, pos_z, yaw, updated_at)
       VALUES ('char-old', $1, 4, 5, 6, 1, 100)`,
      [`${OLD}:0`],
    )
    await db.query(
      `INSERT INTO world_meta (place_id, key, value) VALUES ($1, 'world_id', '"x"'::jsonb)`,
      [OLD],
    )
    await db.query(
      `INSERT INTO mod_storage (place_id, mod_id, key, value) VALUES ($1, 'mod', 'k', '"v"'::jsonb)`,
      [OLD],
    )

    await db.query(MIGRATION)

    expect(
      await db.many(`SELECT id, name FROM places WHERE id IN ($1, $2) ORDER BY id`, [OLD, NEW]),
    ).toEqual([{ id: NEW, name: NEW }])
    expect(await db.many(`SELECT id FROM game_instances WHERE place_id = $1`, [NEW])).toEqual([
      { id: `${NEW}:0` },
    ])
    expect(await db.many(`SELECT instance_id FROM character_instance_positions`)).toEqual([
      { instance_id: `${NEW}:0` },
    ])
    expect(await db.many(`SELECT place_id FROM characters WHERE id = 'char-old'`)).toEqual([
      { place_id: NEW },
    ])
    expect(await db.many(`SELECT place_id FROM world_meta`)).toEqual([{ place_id: NEW }])
    expect(await db.many(`SELECT place_id FROM mod_storage`)).toEqual([{ place_id: NEW }])
  })

  it('keeps the canonical instance and position when both rows already exist', async () => {
    const db = await openTestDb()
    await db.query(`INSERT INTO places (id, name) VALUES ($1, 'old'), ($2, $2)`, [OLD, NEW])
    for (const [place, holder, lease] of [
      [OLD, 'old-holder', 3],
      [NEW, 'new-holder', 7],
    ] as const) {
      await db.query(
        `INSERT INTO game_instances
           (place_id, slot, id, capacity, state, holder, lease_version, heartbeat_at, lease_until)
         VALUES ($1, 0, $2, 8, 'running', $3, $4, 100, 200)`,
        [place, `${place}:0`, holder, lease],
      )
    }
    await seedCharacter(db, 'char-both', OLD)
    for (const place of [OLD, NEW]) {
      await db.query(
        `INSERT INTO character_instance_positions
           (character_id, instance_id, pos_x, pos_y, pos_z, yaw, updated_at)
         VALUES ('char-both', $1, 4, 5, 6, 1, 100)`,
        [`${place}:0`],
      )
    }

    await db.query(MIGRATION)

    expect(
      await db.many(`SELECT id, holder, lease_version FROM game_instances WHERE place_id = $1`, [
        NEW,
      ]),
    ).toEqual([{ id: `${NEW}:0`, holder: 'new-holder', lease_version: 7 }])
    expect(await db.many(`SELECT instance_id FROM character_instance_positions`)).toEqual([
      { instance_id: `${NEW}:0` },
    ])
    expect(await db.many(`SELECT id FROM places WHERE id = $1`, [OLD])).toEqual([])
  })
})
