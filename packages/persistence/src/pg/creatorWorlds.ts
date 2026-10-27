import { createHash, randomBytes } from 'node:crypto'
import { sql, type Db } from 'openvibe-sdk/db'
import { idList } from './sqlUtils.js'

/**
 * Creator worlds (migration 0010): a signed-in player's place, built in /editor and published at /worlds. The map
 * is stored as the validated v2 document; callers validate it first (the content package's parseMapFile and
 * creatorMapIssues), this module only stores, lists and removes. A world runs as the place `world:<id>`, so removing
 * one also removes that place's rows.
 */

export type CreatorWorldStatus = 'draft' | 'published' | 'hidden'
/** How the world is seen (migration 0017): first person, or straight down on the player (2D). */
export type CreatorWorldView = '3d' | 'top'

export interface CreatorWorld {
  id: string
  ownerSubject: string
  ownerName: string
  title: string
  summary: string
  status: CreatorWorldStatus
  revision: string
  plays: number
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  /** The world this one was remixed from, as it was then (migration 0013); null for an original. */
  remixedFrom: { id: string; title: string; owner: string } | null
  /** How often other people remixed this world. */
  remixes: number
  view: CreatorWorldView
}

interface Row {
  id: string
  owner_subject: string
  owner_name: string
  title: string
  summary: string
  status: CreatorWorldStatus
  revision: string
  plays: number
  created_at: number | string
  updated_at: number | string
  published_at: number | string | null
  remixed_from: string | null
  remixed_from_title: string | null
  remixed_from_owner: string | null
  remixes: number | string | null
  view: CreatorWorldView | null
}

const COLUMNS = sql`id, owner_subject, owner_name, title, summary, status, revision, plays, created_at, updated_at, published_at, remixed_from, remixed_from_title, remixed_from_owner, remixes, view`

function fromRow(row: Row): CreatorWorld {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    ownerName: row.owner_name,
    title: row.title,
    summary: row.summary,
    status: row.status,
    revision: row.revision,
    plays: Number(row.plays),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    remixedFrom: row.remixed_from
      ? {
          id: row.remixed_from,
          title: row.remixed_from_title ?? '',
          owner: row.remixed_from_owner ?? '',
        }
      : null,
    remixes: Number(row.remixes ?? 0),
    view: row.view === 'top' ? 'top' : '3d',
  }
}

/** The revision of a stored map: a hash of the document as it is stored. */
export function mapRevision(map: unknown): string {
  return createHash('sha256').update(JSON.stringify(map)).digest('hex').slice(0, 24)
}

/** `w` + ten base-36 characters (content's CREATOR_WORLD_ID). */
export function newCreatorWorldId(): string {
  const bytes = randomBytes(10)
  let id = 'w'
  for (const b of bytes) id += (b % 36).toString(36)
  return id
}

/** The place ids a world's state lives under: its own and any extra room's (`<place>:instance:<n>`). */
function placeMatch(worldId: string) {
  const place = `world:${worldId}`
  return sql`(place_id = ${place} OR place_id LIKE ${`${place}:instance:%`})`
}

/** One of a world's editors besides its owner (migration 0015). */
export interface CreatorWorldMember {
  subject: string
  name: string
  addedAt: number
}

export interface CreatorWorldStore {
  create(input: {
    ownerSubject: string
    ownerName: string
    title: string
    summary: string
    map: unknown
    now: number
    /** A remix: the world it copies, as it is now (kept as the credit). */
    remixedFrom?: { id: string; title: string; owner: string }
    view?: CreatorWorldView
  }): Promise<CreatorWorld>
  get(id: string): Promise<CreatorWorld | null>
  /** The stored map document and its revision. */
  map(id: string): Promise<{ map: unknown; revision: string } | null>
  /** The world's scripts as stored (validated before they were saved; migration 0014). Null when the world is gone. */
  scripts(id: string): Promise<unknown[] | null>
  /** Replaces the world's scripts (callers validate them first). Answers the world, or null when it is gone. */
  saveScripts(id: string, scripts: unknown[], now: number): Promise<CreatorWorld | null>
  countByOwner(ownerSubject: string): Promise<number>
  listByOwner(ownerSubject: string): Promise<CreatorWorld[]>
  /** Published worlds, newest first. */
  listPublished(limit: number, offset: number): Promise<CreatorWorld[]>
  /**
   * Replaces the map when `ifMatch` is the stored revision (or absent). Answers the new world, 'conflict' when the
   * revision moved, or null when the world is gone.
   */
  saveMap(
    id: string,
    map: unknown,
    ifMatch: string | null,
    now: number,
  ): Promise<CreatorWorld | 'conflict' | null>
  update(
    id: string,
    patch: {
      title?: string
      summary?: string
      status?: CreatorWorldStatus
      view?: CreatorWorldView
    },
    now: number,
  ): Promise<CreatorWorld | null>
  /** The owner's display name follows the Network's (set at each signed-in write). */
  rename(ownerSubject: string, ownerName: string): Promise<void>
  countPlay(id: string): Promise<void>
  /** One more remix of this world by someone else. */
  countRemix(id: string): Promise<void>
  /** The world's editors besides its owner, longest-standing first. */
  members(id: string): Promise<CreatorWorldMember[]>
  isMember(id: string, subject: string): Promise<boolean>
  /** Adds (or renames) an editor. */
  addMember(id: string, subject: string, name: string, now: number): Promise<void>
  removeMember(id: string, subject: string): Promise<boolean>
  /** Worlds this person edits as a team member (not their own), most recently changed first. */
  listByMember(subject: string): Promise<CreatorWorld[]>
  /** Sets the world's invite (the hash of its token and when it stops working), or clears it. */
  setInvite(id: string, hash: string | null, expires: number | null): Promise<void>
  /** When the world's invite stops working, or null when it has none (or it has run out). */
  inviteExpires(id: string, now: number): Promise<number | null>
  /** The world an invite token's hash opens, while it still works. */
  byInvite(hash: string, now: number): Promise<CreatorWorld | null>
  /** Removes the world and its place's rows. */
  remove(id: string): Promise<boolean>
}

export function createCreatorWorldStore(db: Db): CreatorWorldStore {
  return {
    async create(input) {
      const id = newCreatorWorldId()
      const from = input.remixedFrom ?? null
      const row = await db.one<Row>(sql`
        INSERT INTO creator_worlds (id, owner_subject, owner_name, title, summary, map, revision, created_at, updated_at,
                                    remixed_from, remixed_from_title, remixed_from_owner, view)
        VALUES (${id}, ${input.ownerSubject}, ${input.ownerName}, ${input.title}, ${input.summary},
                ${sql.json(input.map)}, ${mapRevision(input.map)}, ${input.now}, ${input.now},
                ${from ? from.id : null}, ${from ? from.title : null}, ${from ? from.owner : null}, ${input.view ?? '3d'})
        RETURNING ${COLUMNS}
      `)
      return fromRow(row)
    },
    async get(id) {
      const row = await db.maybe<Row>(sql`SELECT ${COLUMNS} FROM creator_worlds WHERE id = ${id}`)
      return row ? fromRow(row) : null
    },
    async map(id) {
      const row = await db.maybe<{ map: unknown; revision: string }>(
        sql`SELECT map, revision FROM creator_worlds WHERE id = ${id}`,
      )
      return row ? { map: row.map, revision: row.revision } : null
    },
    async scripts(id) {
      const row = await db.maybe<{ scripts: unknown }>(
        sql`SELECT scripts FROM creator_worlds WHERE id = ${id}`,
      )
      if (!row) return null
      return Array.isArray(row.scripts) ? row.scripts : []
    },
    async saveScripts(id, scripts, now) {
      const row = await db.maybe<Row>(sql`
        UPDATE creator_worlds SET scripts = ${sql.json(scripts)}, updated_at = ${now}
        WHERE id = ${id} RETURNING ${COLUMNS}
      `)
      return row ? fromRow(row) : null
    },
    async countByOwner(ownerSubject) {
      const row = await db.one<{ n: number | string }>(
        sql`SELECT count(*)::int AS n FROM creator_worlds WHERE owner_subject = ${ownerSubject}`,
      )
      return Number(row.n)
    },
    async listByOwner(ownerSubject) {
      const rows = await db.many<Row>(
        sql`SELECT ${COLUMNS} FROM creator_worlds WHERE owner_subject = ${ownerSubject} ORDER BY updated_at DESC`,
      )
      return rows.map(fromRow)
    },
    async listPublished(limit, offset) {
      const rows = await db.many<Row>(sql`
        SELECT ${COLUMNS} FROM creator_worlds WHERE status = 'published'
        ORDER BY published_at DESC, id LIMIT ${limit} OFFSET ${offset}
      `)
      return rows.map(fromRow)
    },
    async saveMap(id, map, ifMatch, now) {
      return db.tx(async () => {
        const current = await db.maybe<{ revision: string }>(
          sql`SELECT revision FROM creator_worlds WHERE id = ${id} FOR UPDATE`,
        )
        if (!current) return null
        if (ifMatch && ifMatch !== current.revision) return 'conflict' as const
        const row = await db.one<Row>(sql`
          UPDATE creator_worlds SET map = ${sql.json(map)}, revision = ${mapRevision(map)}, updated_at = ${now}
          WHERE id = ${id} RETURNING ${COLUMNS}
        `)
        return fromRow(row)
      })
    },
    async update(id, patch, now) {
      const sets = [sql`updated_at = ${now}`]
      if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`)
      if (patch.summary !== undefined) sets.push(sql`summary = ${patch.summary}`)
      if (patch.view !== undefined) sets.push(sql`view = ${patch.view}`)
      if (patch.status !== undefined) {
        sets.push(sql`status = ${patch.status}`)
        // The first publication dates the listing; unpublishing and publishing again keeps the date.
        if (patch.status === 'published')
          sets.push(sql`published_at = COALESCE(published_at, ${now})`)
      }
      const row = await db.maybe<Row>(
        sql`UPDATE creator_worlds SET ${sql.join(sets)} WHERE id = ${id} RETURNING ${COLUMNS}`,
      )
      return row ? fromRow(row) : null
    },
    async rename(ownerSubject, ownerName) {
      await db.exec(
        sql`UPDATE creator_worlds SET owner_name = ${ownerName} WHERE owner_subject = ${ownerSubject} AND owner_name <> ${ownerName}`,
      )
    },
    async countPlay(id) {
      await db.exec(sql`UPDATE creator_worlds SET plays = plays + 1 WHERE id = ${id}`)
    },
    async countRemix(id) {
      await db.exec(sql`UPDATE creator_worlds SET remixes = remixes + 1 WHERE id = ${id}`)
    },
    async members(id) {
      const rows = await db.many<{ subject: string; name: string; added_at: number | string }>(
        sql`SELECT subject, name, added_at FROM creator_world_members WHERE world_id = ${id} ORDER BY added_at, subject`,
      )
      return rows.map((r) => ({ subject: r.subject, name: r.name, addedAt: Number(r.added_at) }))
    },
    async isMember(id, subject) {
      const row = await db.maybe<{ one: number }>(
        sql`SELECT 1 AS one FROM creator_world_members WHERE world_id = ${id} AND subject = ${subject}`,
      )
      return !!row
    },
    async addMember(id, subject, name, now) {
      await db.exec(sql`
        INSERT INTO creator_world_members (world_id, subject, name, added_at) VALUES (${id}, ${subject}, ${name}, ${now})
        ON CONFLICT (world_id, subject) DO UPDATE SET name = excluded.name
      `)
    },
    async removeMember(id, subject) {
      return (
        (await db.exec(
          sql`DELETE FROM creator_world_members WHERE world_id = ${id} AND subject = ${subject}`,
        )) > 0
      )
    },
    async listByMember(subject) {
      const rows = await db.many<Row>(sql`
        SELECT ${COLUMNS} FROM creator_worlds
        WHERE id IN (SELECT world_id FROM creator_world_members WHERE subject = ${subject})
        ORDER BY updated_at DESC
      `)
      return rows.map(fromRow)
    },
    async setInvite(id, hash, expires) {
      await db.exec(
        sql`UPDATE creator_worlds SET invite_hash = ${hash}, invite_expires = ${expires} WHERE id = ${id}`,
      )
    },
    async inviteExpires(id, now) {
      const row = await db.maybe<{ invite_expires: number | string | null }>(
        sql`SELECT invite_expires FROM creator_worlds WHERE id = ${id} AND invite_hash IS NOT NULL`,
      )
      const at = row && row.invite_expires !== null ? Number(row.invite_expires) : null
      return at !== null && at > now ? at : null
    },
    async byInvite(hash, now) {
      const row = await db.maybe<Row>(sql`
        SELECT ${COLUMNS} FROM creator_worlds WHERE invite_hash = ${hash} AND invite_expires > ${now}
      `)
      return row ? fromRow(row) : null
    },
    async remove(id) {
      return db.tx(async () => {
        const gone = await db.exec(sql`DELETE FROM creator_worlds WHERE id = ${id}`)
        await removeWorldPlaces(db, [id])
        return gone > 0
      })
    },
  }
}

/** Every row a creator world's place left behind (call inside the transaction that removes the worlds). */
export async function removeWorldPlaces(db: Db, worldIds: readonly string[]): Promise<void> {
  for (const id of worldIds) {
    const where = placeMatch(id)
    await db.exec(sql`
      DELETE FROM character_instance_positions
      WHERE instance_id IN (SELECT id FROM game_instances WHERE ${where})
    `)
    await db.exec(sql`DELETE FROM game_instances WHERE ${where}`)
    await db.exec(sql`DELETE FROM world_constraints WHERE ${where}`)
    await db.exec(sql`DELETE FROM world_entities WHERE ${where}`)
    await db.exec(sql`DELETE FROM world_meta WHERE ${where}`)
    await db.exec(sql`DELETE FROM mod_storage WHERE ${where}`)
    const place = `world:${id}`
    await db.exec(sql`DELETE FROM places WHERE id = ${place} OR id LIKE ${`${place}:instance:%`}`)
  }
}

/** A person's worlds, for their data export (ADR-033): everything but the account key. */
export async function exportCreatorWorlds(
  db: Db,
  subject: string,
): Promise<Record<string, unknown>[]> {
  return db.many<Record<string, unknown>>(sql`
    SELECT id, owner_name, title, summary, status, view, revision, plays, created_at, updated_at, published_at, map
    FROM creator_worlds WHERE owner_subject = ${subject} ORDER BY created_at
  `)
}

/** The account export's team memberships (ADR-033): the worlds this person edits for someone else. */
export async function exportWorldTeams(
  db: Db,
  subject: string,
): Promise<Record<string, unknown>[]> {
  return db.many<Record<string, unknown>>(sql`
    SELECT m.world_id, w.title, m.name, m.added_at FROM creator_world_members m
    JOIN creator_worlds w ON w.id = m.world_id WHERE m.subject = ${subject} ORDER BY m.added_at
  `)
}

/** Erasure (ADR-033): the worlds go with their places, and the person leaves every team. Answers how many worlds. */
export async function eraseCreatorWorlds(db: Db, subjects: readonly string[]): Promise<number> {
  if (!subjects.length) return 0
  await db.exec(sql`DELETE FROM creator_world_members WHERE subject IN (${idList(subjects)})`)
  const ids = (
    await db.many<{ id: string }>(
      sql`SELECT id FROM creator_worlds WHERE owner_subject IN (${idList(subjects)})`,
    )
  ).map((r) => r.id)
  if (!ids.length) return 0
  await db.exec(sql`DELETE FROM creator_worlds WHERE id IN (${idList(ids)})`)
  await removeWorldPlaces(db, ids)
  return ids.length
}

/**
 * Account merge (ADR-029): the folded-in account's worlds belong to the survivor, and so do its team places (one per
 * world; none on a world the survivor now owns).
 */
export async function moveCreatorWorlds(db: Db, from: string, into: string): Promise<number> {
  if (from === into) return 0
  const moved = await db.exec(
    sql`UPDATE creator_worlds SET owner_subject = ${into} WHERE owner_subject = ${from}`,
  )
  await db.exec(sql`
    UPDATE creator_world_members m SET subject = ${into}
    WHERE m.subject = ${from}
      AND NOT EXISTS (SELECT 1 FROM creator_world_members o WHERE o.world_id = m.world_id AND o.subject = ${into})
  `)
  await db.exec(sql`DELETE FROM creator_world_members WHERE subject = ${from}`)
  await db.exec(sql`
    DELETE FROM creator_world_members m USING creator_worlds w
    WHERE m.world_id = w.id AND m.subject = w.owner_subject
  `)
  return moved
}
