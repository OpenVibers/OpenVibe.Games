import { sql, type Db, type Sql, type Tx } from 'openvibe-sdk/db'
import type { InventoryDto, SkillsDto } from '@openvibe/gameplay'
import type { ConstraintDto, PlayerDto, WorldEntityDto } from '../dto.js'
import type {
  ConstraintRepository,
  MetaRepository,
  PersistenceStore,
  PlayerRepository,
  WorldEntityRepository,
} from '../repositories.js'
import { accountKey } from '../accountKey.js'
import {
  createIdentityRepository,
  createMediaMirrorRepository,
  createModRepository,
} from './platformRepositories.js'
import { BATCH_CHUNK, chunks, idList } from './sqlUtils.js'

export interface PgStoreOptions {
  /** GAMES_PLACE_ID (default 'scraplandia'): the place every world row belongs to on this instance. */
  placeId?: string
}

export interface PgPersistenceStore extends PersistenceStore {
  readonly db: Db
  readonly placeId: string
}

interface WorldEntityRow {
  id: string
  kind: string
  def_id: string
  owner_id: string | null
  pos_x: number
  pos_y: number
  pos_z: number
  rot_x: number
  rot_y: number
  rot_z: number
  rot_w: number
  motion: string
  state: unknown
  updated_at: number
}

interface CharacterRow {
  id: string
  account_key: string
  slot: number
  subject_id: string | null
  name: string
  pos_x: number
  pos_y: number
  pos_z: number
  yaw: number
  inventory: unknown
  skills: unknown
  friends: unknown
  appearance: unknown
  stats: unknown
  armor: unknown
  reputation: unknown
  unlocks: unknown
  // active_job is a text column holding the JSON of the job/progress pair (ADR-0007 job spec).
  active_job: string | null
  updated_at: number
}

interface ConstraintRow {
  id: string
  type: string
  entity_a: string
  entity_b: string
  params: unknown
  updated_at: number
}

export function openPgStore(db: Db, opts: PgStoreOptions = {}): PgPersistenceStore {
  const placeId = opts.placeId ?? process.env.GAMES_PLACE_ID ?? 'scraplandia'

  const worldEntities: WorldEntityRepository = {
    async loadAll(): Promise<WorldEntityDto[]> {
      const rows = await db.many<WorldEntityRow>(
        sql`SELECT id, kind, def_id, owner_id, pos_x, pos_y, pos_z, rot_x, rot_y, rot_z, rot_w, motion, state, updated_at
            FROM world_entities WHERE place_id = ${placeId}`,
      )
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind as WorldEntityDto['kind'],
        defId: row.def_id,
        ownerId: row.owner_id,
        pos: [row.pos_x, row.pos_y, row.pos_z],
        rot: [row.rot_x, row.rot_y, row.rot_z, row.rot_w],
        motion: row.motion as WorldEntityDto['motion'],
        state: (row.state ?? null) as WorldEntityDto['state'],
        updatedAt: Number(row.updated_at),
      }))
    },
    async upsertMany(entities: readonly WorldEntityDto[]): Promise<void> {
      for (const chunk of chunks(entities, BATCH_CHUNK)) {
        const rows = chunk.map((e) => ({
          place_id: placeId,
          id: e.id,
          kind: e.kind,
          def_id: e.defId,
          owner_id: e.ownerId,
          pos_x: e.pos[0],
          pos_y: e.pos[1],
          pos_z: e.pos[2],
          rot_x: e.rot[0],
          rot_y: e.rot[1],
          rot_z: e.rot[2],
          rot_w: e.rot[3],
          motion: e.motion,
          state: e.state === null ? null : sql.json(e.state),
          updated_at: e.updatedAt,
        }))
        await db.query(sql`
          INSERT INTO world_entities
          ${sql.insert(rows, [
            'place_id',
            'id',
            'kind',
            'def_id',
            'owner_id',
            'pos_x',
            'pos_y',
            'pos_z',
            'rot_x',
            'rot_y',
            'rot_z',
            'rot_w',
            'motion',
            'state',
            'updated_at',
          ])}
          ON CONFLICT (place_id, id) DO UPDATE SET
            pos_x=excluded.pos_x, pos_y=excluded.pos_y, pos_z=excluded.pos_z,
            rot_x=excluded.rot_x, rot_y=excluded.rot_y, rot_z=excluded.rot_z, rot_w=excluded.rot_w,
            motion=excluded.motion, state=excluded.state, owner_id=excluded.owner_id, updated_at=excluded.updated_at
        `)
      }
    },
    async deleteMany(ids: readonly string[]): Promise<void> {
      for (const chunk of chunks(ids, BATCH_CHUNK)) {
        if (chunk.length === 0) continue
        await db.exec(
          sql`DELETE FROM world_entities WHERE place_id = ${placeId} AND id IN (${idList(chunk)})`,
        )
      }
    },
    async deleteByKind(kind: string): Promise<void> {
      await db.exec(sql`DELETE FROM world_entities WHERE place_id = ${placeId} AND kind = ${kind}`)
    },
  }

  const characterRow = (p: PlayerDto) => ({
    id: p.id,
    account_key: accountKey(p.token),
    slot: p.charSlot ?? 0,
    subject_id: p.subjectId ?? null,
    name: p.name,
    place_id: placeId,
    pos_x: p.pos[0],
    pos_y: p.pos[1],
    pos_z: p.pos[2],
    yaw: p.yaw,
    inventory: sql.json(p.inventory),
    skills: sql.json(p.skills),
    friends: sql.json(p.friends),
    appearance: p.appearance === null ? null : sql.json(p.appearance),
    stats: p.stats === null ? null : sql.json(p.stats),
    armor: p.armor === null ? null : sql.json(p.armor),
    reputation: sql.json(p.reputation ?? {}),
    unlocks: sql.json(p.unlocks ?? []),
    active_job: p.activeJob === null ? null : JSON.stringify(p.activeJob),
    updated_at: p.updatedAt,
  })

  const CHARACTER_COLUMNS = [
    'id',
    'account_key',
    'slot',
    'subject_id',
    'name',
    'place_id',
    'pos_x',
    'pos_y',
    'pos_z',
    'yaw',
    'inventory',
    'skills',
    'friends',
    'appearance',
    'stats',
    'armor',
    'reputation',
    'unlocks',
    'active_job',
    'updated_at',
  ]

  const rowToPlayer = (row: CharacterRow): PlayerDto => ({
    id: row.id,
    // The account key doubles as the DTO token: for a Network account it is the subject; for a guest it
    // is `guest:<sha256>`, never the raw browser token (which is not stored).
    token: row.account_key,
    name: row.name,
    pos: [row.pos_x, row.pos_y, row.pos_z],
    yaw: row.yaw,
    inventory: (row.inventory ?? {}) as InventoryDto,
    skills: (row.skills ?? {}) as SkillsDto,
    friends: (row.friends ?? []) as string[],
    appearance: (row.appearance ?? null) as PlayerDto['appearance'],
    armor: (row.armor ?? null) as PlayerDto['armor'],
    reputation: (row.reputation ?? {}) as PlayerDto['reputation'],
    unlocks: (row.unlocks ?? []) as string[],
    activeJob:
      row.active_job === null || row.active_job === undefined
        ? null
        : (JSON.parse(row.active_job) as PlayerDto['activeJob']),
    stats: (row.stats ?? null) as PlayerDto['stats'],
    charSlot: row.slot ?? 0,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    updatedAt: Number(row.updated_at),
  })

  const characters = sql`SELECT * FROM characters`
  const players: PlayerRepository = {
    async findByToken(token: string): Promise<PlayerDto | null> {
      const row = await db.maybe<CharacterRow>(
        sql`${characters} WHERE account_key = ${accountKey(token)}`,
      )
      return row ? rowToPlayer(row) : null
    },
    async listByToken(token: string): Promise<PlayerDto[]> {
      const rows = await db.many<CharacterRow>(
        sql`${characters} WHERE account_key = ${accountKey(token)} ORDER BY slot`,
      )
      return rows.map(rowToPlayer)
    },
    async findByTokenSlot(token: string, slot: number): Promise<PlayerDto | null> {
      const row = await db.maybe<CharacterRow>(
        sql`${characters} WHERE account_key = ${accountKey(token)} AND slot = ${slot}`,
      )
      return row ? rowToPlayer(row) : null
    },
    async findById(id: string): Promise<PlayerDto | null> {
      const row = await db.maybe<CharacterRow>(sql`${characters} WHERE id = ${id}`)
      return row ? rowToPlayer(row) : null
    },
    async upsert(player: PlayerDto): Promise<void> {
      await db.query(upsertCharacter([player]))
    },
    async upsertMany(list: readonly PlayerDto[]): Promise<void> {
      for (const chunk of chunks(list, BATCH_CHUNK)) {
        if (chunk.length === 0) continue
        await db.query(upsertCharacter(chunk))
      }
    },
    async resetAllPositions(pos: [number, number, number], yaw: number): Promise<void> {
      await db.exec(
        sql`UPDATE characters SET pos_x = ${pos[0]}, pos_y = ${pos[1]}, pos_z = ${pos[2]}, yaw = ${yaw}`,
      )
    },
  }

  function upsertCharacter(list: readonly PlayerDto[]): Sql {
    return sql`
      INSERT INTO characters
      ${sql.insert(list.map(characterRow), CHARACTER_COLUMNS)}
      ON CONFLICT (id) DO UPDATE SET
        subject_id = COALESCE(excluded.subject_id, characters.subject_id),
        name = excluded.name, place_id = excluded.place_id,
        pos_x = excluded.pos_x, pos_y = excluded.pos_y, pos_z = excluded.pos_z, yaw = excluded.yaw,
        inventory = excluded.inventory, skills = excluded.skills, friends = excluded.friends,
        appearance = excluded.appearance, stats = excluded.stats, armor = excluded.armor,
        reputation = excluded.reputation, unlocks = excluded.unlocks,
        active_job = excluded.active_job, updated_at = excluded.updated_at
    `
  }

  const constraints: ConstraintRepository = {
    async loadAll(): Promise<ConstraintDto[]> {
      const rows = await db.many<ConstraintRow>(
        sql`SELECT id, type, entity_a, entity_b, params, updated_at FROM world_constraints WHERE place_id = ${placeId}`,
      )
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        entityA: row.entity_a,
        entityB: row.entity_b,
        params: (row.params ?? null) as Record<string, unknown> | null,
        updatedAt: Number(row.updated_at),
      }))
    },
    async upsertMany(list: readonly ConstraintDto[]): Promise<void> {
      for (const chunk of chunks(list, BATCH_CHUNK)) {
        if (chunk.length === 0) continue
        const rows = chunk.map((c) => ({
          place_id: placeId,
          id: c.id,
          type: c.type,
          entity_a: c.entityA,
          entity_b: c.entityB,
          params: c.params === null ? null : sql.json(c.params),
          updated_at: c.updatedAt,
        }))
        await db.query(sql`
          INSERT INTO world_constraints
          ${sql.insert(rows, ['place_id', 'id', 'type', 'entity_a', 'entity_b', 'params', 'updated_at'])}
          ON CONFLICT (place_id, id) DO UPDATE SET
            params = excluded.params, updated_at = excluded.updated_at
        `)
      }
    },
    async deleteMany(ids: readonly string[]): Promise<void> {
      for (const chunk of chunks(ids, BATCH_CHUNK)) {
        if (chunk.length === 0) continue
        await db.exec(
          sql`DELETE FROM world_constraints WHERE place_id = ${placeId} AND id IN (${idList(chunk)})`,
        )
      }
    },
  }

  const meta: MetaRepository = {
    async get(key: string): Promise<unknown | null> {
      const value = await db.value<unknown>(
        sql`SELECT value FROM world_meta WHERE place_id = ${placeId} AND key = ${key}`,
      )
      return value ?? null
    },
    async set(key: string, value: unknown): Promise<void> {
      await db.exec(sql`
        INSERT INTO world_meta (place_id, key, value) VALUES (${placeId}, ${key}, ${sql.json(value)})
        ON CONFLICT (place_id, key) DO UPDATE SET value = excluded.value
      `)
    },
    async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
      const rows = await db.many<{ key: string; value: unknown }>(
        sql`SELECT key, value FROM world_meta WHERE place_id = ${placeId} AND key LIKE ${`${prefix}%`} ORDER BY key`,
      )
      return rows.map((r) => ({ key: r.key, value: r.value }))
    },
  }

  return {
    db,
    placeId,
    async ensurePlace(name = placeId): Promise<void> {
      await db.exec(
        sql`INSERT INTO places (id, name) VALUES (${placeId}, ${name}) ON CONFLICT (id) DO NOTHING`,
      )
    },
    worldEntities,
    players,
    constraints,
    meta,
    identity: createIdentityRepository(db),
    mods: createModRepository(db),
    mediaMirrors: createMediaMirrorRepository(db),
    transaction<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
      return db.tx(fn)
    },
    close(): Promise<void> {
      return db.close()
    },
  }
}
