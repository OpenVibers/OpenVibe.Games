import { sql, type Db } from 'openvibe-sdk/db'
import { accountKey } from '../accountKey.js'
import type {
  MediaMirrorDto,
  ModAuditDto,
  ModGrantDto,
  ModInstallDto,
  ModPlacementDto,
  ModStatus,
  ModTrustTier,
} from '../dto.js'
import type { IdentityRepository, MediaMirrorRepository, ModRepository } from '../repositories.js'
import { idList } from './sqlUtils.js'

/**
 * PostgreSQL repositories for the platform-integration tables: the adoption ledger, the mod registry
 * and the Media mirror queue. The game simulation never touches these; apps/server's platform
 * adapters do.
 */

/** An exported character row without its account key (the sign-in identity). */
function withoutAccountKey(row: Record<string, unknown>): Record<string, unknown> {
  const { account_key: _ignored, ...rest } = row
  return rest
}

export function createIdentityRepository(db: Db): IdentityRepository {
  async function takenSlots(account: string): Promise<Set<number>> {
    const rows = await db.many<{ slot: number }>(
      sql`SELECT slot FROM characters WHERE account_key = ${account}`,
    )
    return new Set(rows.map((r) => r.slot))
  }
  async function rowsFor(account: string): Promise<{ id: string; slot: number }[]> {
    return db.many<{ id: string; slot: number }>(
      sql`SELECT id, slot FROM characters WHERE account_key = ${account} ORDER BY slot`,
    )
  }
  const adopted = (key: string) =>
    db.maybe<{ subject_id: string }>(
      sql`SELECT subject_id FROM identity_adoptions WHERE adoption_key = ${key}`,
    )
  const moveToSlot = (id: string, account: string, subject: string, slot: number) =>
    db.exec(
      sql`UPDATE characters SET account_key = ${account}, subject_id = ${subject}, slot = ${slot} WHERE id = ${id}`,
    )
  const recordAdoption = (
    key: string,
    subject: string,
    source: string,
    moved: number,
    conflicts: number,
    now: number,
  ) =>
    db.exec(sql`
      INSERT INTO identity_adoptions (adoption_key, subject_id, source, moved, conflicts, adopted_at)
      VALUES (${key}, ${subject}, ${source}, ${moved}, ${conflicts}, ${now})
      ON CONFLICT (adoption_key) DO UPDATE SET
        moved = identity_adoptions.moved + excluded.moved,
        conflicts = excluded.conflicts
    `)

  return {
    adoptGuestCharacter(guestToken, subjectId, now) {
      return db.tx(async () => {
        // Once per guest token, remembered by a hash of it, never the token.
        const key = accountKey(guestToken)
        const none = { moved: 0, slot: null, full: false }
        if (await adopted(key)) return none
        const rows = await rowsFor(key)
        if (rows.length === 0) return none
        const taken = await takenSlots(subjectId)
        let moved = 0
        let slot: number | null = null
        for (const row of rows) {
          const free = [0, 1, 2].find((s) => !taken.has(s))
          if (free === undefined) break
          await moveToSlot(row.id, subjectId, subjectId, free)
          taken.add(free)
          slot ??= free
          moved++
        }
        if (moved === 0) return { moved: 0, slot: null, full: true }
        await recordAdoption(key, subjectId, 'guest', moved, rows.length - moved, now)
        return { moved, slot, full: false }
      })
    },

    mergeSubject(from, into, mergeId, now) {
      return db.tx(async () => {
        const key = `merge:${mergeId}`
        if (await adopted(key)) return { moved: 0, kept: 0, already: true }
        const taken = await takenSlots(into)
        const rows = await rowsFor(from)
        let moved = 0
        // First every character whose own slot is free there, then the rest into what is left.
        const clashing: { id: string; slot: number }[] = []
        for (const row of rows) {
          if (taken.has(row.slot)) {
            clashing.push(row)
            continue
          }
          await moveToSlot(row.id, into, into, row.slot)
          taken.add(row.slot)
          moved++
        }
        let kept = 0
        for (const row of clashing) {
          const slot = [0, 1, 2].find((s) => !taken.has(s))
          if (slot === undefined) {
            kept++
            continue
          }
          await moveToSlot(row.id, into, into, slot)
          taken.add(slot)
          moved++
        }
        await recordAdoption(key, into, 'merge', moved, kept, now)
        return { moved, kept, already: false }
      })
    },

    async exportSubject(subject) {
      const characters = await db.many<Record<string, unknown>>(
        sql`SELECT * FROM characters WHERE account_key = ${subject} OR subject_id = ${subject} ORDER BY slot`,
      )
      const ids = characters.map((c) => String(c.id))
      const structures = ids.length
        ? await db.many<Record<string, unknown>>(
            sql`SELECT * FROM world_entities WHERE owner_id IN (${idList(ids)})`,
          )
        : []
      return {
        characters: characters.map(withoutAccountKey),
        structures,
      }
    },

    eraseSubjects(subjects) {
      return db.tx(async () => {
        const out = { characters: 0, structures_unowned: 0, identity_rows: 0 }
        if (!subjects.length) return out
        const ids = (
          await db.many<{ id: string }>(
            sql`SELECT id FROM characters WHERE account_key IN (${idList(subjects)}) OR subject_id IN (${idList(subjects)})`,
          )
        ).map((r) => r.id)
        if (ids.length) {
          out.structures_unowned = await db.exec(
            sql`UPDATE world_entities SET owner_id = NULL WHERE owner_id IN (${idList(ids)})`,
          )
          out.characters = await db.exec(sql`DELETE FROM characters WHERE id IN (${idList(ids)})`)
        }
        out.identity_rows = await db.exec(
          sql`DELETE FROM identity_adoptions WHERE subject_id IN (${idList(subjects)})`,
        )
        return out
      })
    },
  }
}

interface ModRow {
  id: string
  name: string
  version: string
  target: string
  runtime: string
  manifest: unknown
  pack: unknown
  trust_tier: string
  status: string
  installed_by: string
  installed_at: number
  updated_at: number
}

interface GrantRow {
  mod_id: string
  capability: string
  granted_by: string
  granted_at: number
  revoked_at: number | null
  revoked_by: string | null
}

interface AuditRow {
  id: number
  mod_id: string
  action: string
  capability: string | null
  actor: string
  detail: unknown
  at: number
}

interface PlacementRow {
  mod_id: string
  placement_key: string
  entity_id: string | null
  at: number
}

const rowToMod = (r: ModRow): ModInstallDto => ({
  id: r.id,
  name: r.name,
  version: r.version,
  target: r.target,
  runtime: r.runtime,
  manifest: (r.manifest ?? {}) as Record<string, unknown>,
  pack: (r.pack ?? {}) as Record<string, unknown>,
  trustTier: r.trust_tier as ModTrustTier,
  status: r.status as ModStatus,
  installedBy: r.installed_by,
  installedAt: Number(r.installed_at),
  updatedAt: Number(r.updated_at),
})

const rowToGrant = (r: GrantRow): ModGrantDto => ({
  modId: r.mod_id,
  capability: r.capability,
  grantedBy: r.granted_by,
  grantedAt: Number(r.granted_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  revokedBy: r.revoked_by,
})

export function createModRepository(db: Db): ModRepository {
  return {
    async list() {
      const rows = await db.many<ModRow>(sql`SELECT * FROM mods ORDER BY installed_at, id`)
      return rows.map(rowToMod)
    },
    async get(id) {
      const row = await db.maybe<ModRow>(sql`SELECT * FROM mods WHERE id = ${id}`)
      return row ? rowToMod(row) : null
    },
    async insert(mod) {
      await db.exec(sql`
        INSERT INTO mods (id, name, version, target, runtime, manifest, pack, trust_tier, status, installed_by, installed_at, updated_at)
        VALUES (${mod.id}, ${mod.name}, ${mod.version}, ${mod.target}, ${mod.runtime},
          ${sql.json(mod.manifest)}, ${sql.json(mod.pack)}, ${mod.trustTier}, ${mod.status},
          ${mod.installedBy}, ${mod.installedAt}, ${mod.updatedAt})
      `)
    },
    async setStatus(id, status, at) {
      await db.exec(sql`UPDATE mods SET status = ${status}, updated_at = ${at} WHERE id = ${id}`)
    },
    async grants(modId) {
      const rows = await db.many<GrantRow>(
        sql`SELECT * FROM mod_grants WHERE mod_id = ${modId} ORDER BY capability`,
      )
      return rows.map(rowToGrant)
    },
    async upsertGrant(g) {
      await db.exec(sql`
        INSERT INTO mod_grants (mod_id, capability, granted_by, granted_at, revoked_at, revoked_by)
        VALUES (${g.modId}, ${g.capability}, ${g.grantedBy}, ${g.grantedAt}, ${g.revokedAt}, ${g.revokedBy})
        ON CONFLICT (mod_id, capability) DO UPDATE SET
          granted_by = excluded.granted_by, granted_at = excluded.granted_at,
          revoked_at = excluded.revoked_at, revoked_by = excluded.revoked_by
      `)
    },
    async revokeGrant(modId, capability, by, at) {
      const changes = await db.exec(sql`
        UPDATE mod_grants SET revoked_at = ${at}, revoked_by = ${by}
        WHERE mod_id = ${modId} AND capability = ${capability} AND revoked_at IS NULL
      `)
      return changes > 0
    },
    async audit(e) {
      await db.exec(sql`
        INSERT INTO mod_audit (mod_id, action, capability, actor, detail, at)
        VALUES (${e.modId}, ${e.action}, ${e.capability}, ${e.actor},
          ${e.detail === null || e.detail === undefined ? null : sql.json(e.detail)}, ${e.at})
      `)
    },
    async auditLog(modId, limit) {
      const rows = await db.many<AuditRow>(
        sql`SELECT * FROM mod_audit WHERE mod_id = ${modId} ORDER BY id DESC LIMIT ${limit}`,
      )
      return rows.map((r): ModAuditDto => ({
        id: Number(r.id),
        modId: r.mod_id,
        action: r.action,
        capability: r.capability,
        actor: r.actor,
        detail: (r.detail ?? null) as Record<string, unknown> | null,
        at: Number(r.at),
      }))
    },
    async placements(modId) {
      const rows = await db.many<PlacementRow>(
        sql`SELECT * FROM mod_placements WHERE mod_id = ${modId} ORDER BY placement_key`,
      )
      return rows.map((r): ModPlacementDto => ({
        modId: r.mod_id,
        key: r.placement_key,
        entityId: r.entity_id,
        at: Number(r.at),
      }))
    },
    async setPlacement(p) {
      await db.exec(sql`
        INSERT INTO mod_placements (mod_id, placement_key, entity_id, at)
        VALUES (${p.modId}, ${p.key}, ${p.entityId}, ${p.at})
        ON CONFLICT (mod_id, placement_key) DO UPDATE SET entity_id = excluded.entity_id, at = excluded.at
      `)
    },
    async deletePlacement(modId, key) {
      await db.exec(
        sql`DELETE FROM mod_placements WHERE mod_id = ${modId} AND placement_key = ${key}`,
      )
    },
  }
}

interface MirrorRow {
  asset_hash: string
  file_name: string
  mime: string
  bytes: number
  status: string
  media_id: string | null
  public_url: string | null
  attempts: number
  last_error: string | null
  next_attempt_at: number
  updated_at: number
}

const rowToMirror = (r: MirrorRow): MediaMirrorDto => ({
  assetHash: r.asset_hash,
  fileName: r.file_name,
  mime: r.mime,
  bytes: Number(r.bytes),
  status: r.status as MediaMirrorDto['status'],
  mediaId: r.media_id,
  publicUrl: r.public_url,
  attempts: Number(r.attempts),
  lastError: r.last_error,
  nextAttemptAt: Number(r.next_attempt_at),
  updatedAt: Number(r.updated_at),
})

export function createMediaMirrorRepository(db: Db): MediaMirrorRepository {
  return {
    async enqueue(asset, now) {
      const changes = await db.exec(sql`
        INSERT INTO media_mirrors (asset_hash, file_name, mime, bytes, status, attempts, next_attempt_at, updated_at)
        VALUES (${asset.assetHash}, ${asset.fileName}, ${asset.mime}, ${asset.bytes}, 'pending', 0, ${now}, ${now})
        ON CONFLICT (asset_hash) DO NOTHING
      `)
      return changes > 0
    },
    async get(assetHash) {
      const row = await db.maybe<MirrorRow>(
        sql`SELECT * FROM media_mirrors WHERE asset_hash = ${assetHash}`,
      )
      return row ? rowToMirror(row) : null
    },
    async due(now, limit) {
      const rows = await db.many<MirrorRow>(sql`
        SELECT * FROM media_mirrors WHERE status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at, asset_hash LIMIT ${limit}
      `)
      return rows.map(rowToMirror)
    },
    async noteObject(assetHash, mediaId, now) {
      await db.exec(
        sql`UPDATE media_mirrors SET media_id = ${mediaId}, updated_at = ${now} WHERE asset_hash = ${assetHash}`,
      )
    },
    async markMirrored(assetHash, mediaId, publicUrl, now) {
      await db.exec(sql`
        UPDATE media_mirrors SET status = 'mirrored', media_id = ${mediaId}, public_url = ${publicUrl},
          last_error = NULL, attempts = attempts + 1, updated_at = ${now} WHERE asset_hash = ${assetHash}
      `)
    },
    async markFailed(assetHash, error, nextAttemptAt, terminal, now) {
      await db.exec(sql`
        UPDATE media_mirrors SET status = ${terminal ? 'failed' : 'pending'}, last_error = ${error.slice(0, 500)},
          attempts = attempts + 1, next_attempt_at = ${nextAttemptAt}, updated_at = ${now}
        WHERE asset_hash = ${assetHash}
      `)
    },
    async counts() {
      const out: Record<MediaMirrorDto['status'], number> = { pending: 0, mirrored: 0, failed: 0 }
      const rows = await db.many<{ status: MediaMirrorDto['status']; n: number }>(
        sql`SELECT status, COUNT(*) AS n FROM media_mirrors GROUP BY status`,
      )
      for (const r of rows) out[r.status] = Number(r.n)
      return out
    },
  }
}
