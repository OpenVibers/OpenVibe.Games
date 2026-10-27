import { randomBytes } from 'node:crypto'
import { sql, type Db } from 'openvibe-sdk/db'
import { idList } from './sqlUtils.js'

/**
 * The asset store (migration 0016): builds and scripts creators publish for anyone to use in their own worlds. Callers
 * check a body first (the content package's creatorAssetOf); this module stores, lists, counts uses and removes.
 */

export type CreatorAssetKind = 'prefab' | 'script'
export type CreatorAssetStatus = 'published' | 'hidden'

export interface CreatorAsset {
  id: string
  ownerSubject: string
  ownerName: string
  kind: CreatorAssetKind
  title: string
  summary: string
  status: CreatorAssetStatus
  /** How many people (besides its creator) used it. */
  uses: number
  /** The world it came from, as it was then; null when none was named. */
  fromWorld: { id: string; title: string } | null
  createdAt: number
  updatedAt: number
  body: unknown
}

interface Row {
  id: string
  owner_subject: string
  owner_name: string
  kind: CreatorAssetKind
  title: string
  summary: string
  status: CreatorAssetStatus
  uses: number | string
  from_world: string | null
  from_world_title: string | null
  created_at: number | string
  updated_at: number | string
  body: unknown
}

const COLUMNS = sql`id, owner_subject, owner_name, kind, title, summary, status, uses, from_world, from_world_title, created_at, updated_at, body`

function fromRow(row: Row): CreatorAsset {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    ownerName: row.owner_name,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    uses: Number(row.uses),
    fromWorld: row.from_world ? { id: row.from_world, title: row.from_world_title ?? '' } : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    body: row.body,
  }
}

/** `a` + ten base-36 characters (content's CREATOR_ASSET_ID). */
export function newCreatorAssetId(): string {
  const bytes = randomBytes(10)
  let id = 'a'
  for (const b of bytes) id += (b % 36).toString(36)
  return id
}

export interface CreatorAssetStore {
  create(input: {
    ownerSubject: string
    ownerName: string
    kind: CreatorAssetKind
    title: string
    summary: string
    body: unknown
    fromWorld?: { id: string; title: string } | null
    now: number
  }): Promise<CreatorAsset>
  get(id: string): Promise<CreatorAsset | null>
  countByOwner(ownerSubject: string): Promise<number>
  listByOwner(ownerSubject: string): Promise<CreatorAsset[]>
  /** Published assets, newest first, of one kind or both. */
  listPublished(
    kind: CreatorAssetKind | null,
    limit: number,
    offset: number,
  ): Promise<CreatorAsset[]>
  update(
    id: string,
    patch: { title?: string; summary?: string; status?: CreatorAssetStatus },
    now: number,
  ): Promise<CreatorAsset | null>
  /** The creator's display name follows the Network's (set at each signed-in write). */
  rename(ownerSubject: string, ownerName: string): Promise<void>
  /** Counts this person's use of the asset once; true when it was their first. */
  countUse(id: string, subject: string, now: number): Promise<boolean>
  remove(id: string): Promise<boolean>
}

export function createCreatorAssetStore(db: Db): CreatorAssetStore {
  return {
    async create(input) {
      const id = newCreatorAssetId()
      const from = input.fromWorld ?? null
      const row = await db.one<Row>(sql`
        INSERT INTO creator_assets (id, owner_subject, owner_name, kind, title, summary, body, from_world, from_world_title,
                                    created_at, updated_at)
        VALUES (${id}, ${input.ownerSubject}, ${input.ownerName}, ${input.kind}, ${input.title}, ${input.summary},
                ${sql.json(input.body)}, ${from ? from.id : null}, ${from ? from.title : null}, ${input.now}, ${input.now})
        RETURNING ${COLUMNS}
      `)
      return fromRow(row)
    },
    async get(id) {
      const row = await db.maybe<Row>(sql`SELECT ${COLUMNS} FROM creator_assets WHERE id = ${id}`)
      return row ? fromRow(row) : null
    },
    async countByOwner(ownerSubject) {
      const row = await db.one<{ n: number | string }>(
        sql`SELECT count(*)::int AS n FROM creator_assets WHERE owner_subject = ${ownerSubject}`,
      )
      return Number(row.n)
    },
    async listByOwner(ownerSubject) {
      const rows = await db.many<Row>(
        sql`SELECT ${COLUMNS} FROM creator_assets WHERE owner_subject = ${ownerSubject} ORDER BY created_at DESC, id`,
      )
      return rows.map(fromRow)
    },
    async listPublished(kind, limit, offset) {
      const rows = await db.many<Row>(sql`
        SELECT ${COLUMNS} FROM creator_assets
        WHERE status = 'published' ${kind ? sql`AND kind = ${kind}` : sql``}
        ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}
      `)
      return rows.map(fromRow)
    },
    async update(id, patch, now) {
      const sets = [sql`updated_at = ${now}`]
      if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`)
      if (patch.summary !== undefined) sets.push(sql`summary = ${patch.summary}`)
      if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`)
      const row = await db.maybe<Row>(
        sql`UPDATE creator_assets SET ${sql.join(sets)} WHERE id = ${id} RETURNING ${COLUMNS}`,
      )
      return row ? fromRow(row) : null
    },
    async rename(ownerSubject, ownerName) {
      await db.exec(
        sql`UPDATE creator_assets SET owner_name = ${ownerName} WHERE owner_subject = ${ownerSubject} AND owner_name <> ${ownerName}`,
      )
    },
    async countUse(id, subject, now) {
      return db.tx(async () => {
        const added = await db.exec(sql`
          INSERT INTO creator_asset_uses (asset_id, subject, used_at) VALUES (${id}, ${subject}, ${now})
          ON CONFLICT (asset_id, subject) DO NOTHING
        `)
        if (added > 0)
          await db.exec(sql`UPDATE creator_assets SET uses = uses + 1 WHERE id = ${id}`)
        return added > 0
      })
    },
    async remove(id) {
      return (await db.exec(sql`DELETE FROM creator_assets WHERE id = ${id}`)) > 0
    },
  }
}

/** A person's assets and the ones they used, for their data export (ADR-033). */
export async function exportCreatorAssets(
  db: Db,
  subject: string,
): Promise<{ assets: Record<string, unknown>[]; uses: Record<string, unknown>[] }> {
  const assets = await db.many<Record<string, unknown>>(sql`
    SELECT id, owner_name, kind, title, summary, status, uses, from_world, from_world_title, created_at, updated_at, body
    FROM creator_assets WHERE owner_subject = ${subject} ORDER BY created_at
  `)
  const uses = await db.many<Record<string, unknown>>(sql`
    SELECT u.asset_id, a.title, u.used_at FROM creator_asset_uses u
    JOIN creator_assets a ON a.id = u.asset_id WHERE u.subject = ${subject} ORDER BY u.used_at
  `)
  return { assets, uses }
}

/** Erasure (ADR-033): the person's assets go, and so do the records of what they used. Answers how many assets. */
export async function eraseCreatorAssets(db: Db, subjects: readonly string[]): Promise<number> {
  if (!subjects.length) return 0
  await db.exec(sql`DELETE FROM creator_asset_uses WHERE subject IN (${idList(subjects)})`)
  return db.exec(sql`DELETE FROM creator_assets WHERE owner_subject IN (${idList(subjects)})`)
}

/**
 * Account merge (ADR-029): the folded-in account's assets belong to the survivor, and so do its uses (one per asset;
 * none on the survivor's own assets, which never count their creator).
 */
export async function moveCreatorAssets(db: Db, from: string, into: string): Promise<number> {
  if (from === into) return 0
  const moved = await db.exec(
    sql`UPDATE creator_assets SET owner_subject = ${into} WHERE owner_subject = ${from}`,
  )
  const touched = (
    await db.many<{ asset_id: string }>(
      sql`SELECT asset_id FROM creator_asset_uses WHERE subject = ${from}`,
    )
  ).map((r) => r.asset_id)
  await db.exec(sql`
    UPDATE creator_asset_uses u SET subject = ${into}
    WHERE u.subject = ${from}
      AND NOT EXISTS (SELECT 1 FROM creator_asset_uses o WHERE o.asset_id = u.asset_id AND o.subject = ${into})
  `)
  await db.exec(sql`DELETE FROM creator_asset_uses WHERE subject = ${from}`)
  await db.exec(sql`
    DELETE FROM creator_asset_uses u USING creator_assets a
    WHERE u.asset_id = a.id AND u.subject = a.owner_subject
  `)
  // Two uses that became one, or a use of what is now one's own, no longer count.
  await db.exec(sql`
    UPDATE creator_assets a SET uses = (SELECT count(*)::int FROM creator_asset_uses u WHERE u.asset_id = a.id)
    WHERE a.owner_subject = ${into}${touched.length ? sql` OR a.id IN (${idList(touched)})` : sql``}
  `)
  return moved
}
