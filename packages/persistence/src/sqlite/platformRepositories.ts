import type Database from 'better-sqlite3'
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

/**
 * SQLite repositories for the platform-integration tables (schema 12): the
 * legacy identity map, the mod registry and the Media mirror queue. The game
 * simulation never touches these; apps/server's platform adapters do.
 */

export function createIdentityRepository(db: Database.Database): IdentityRepository {
  const takenSlots = db.prepare<[string], { char_slot: number }>(
    'SELECT char_slot FROM players WHERE token = ?',
  )
  const legacyRows = db.prepare<[string], { id: string; char_slot: number }>(
    'SELECT id, char_slot FROM players WHERE token = ? ORDER BY char_slot',
  )
  const moveRow = db.prepare('UPDATE players SET token = ?, subject_id = ? WHERE id = ?')
  const recordMap = db.prepare(`
    INSERT INTO identity_legacy_map (legacy_key, subject_id, source, moved, conflicts, adopted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(legacy_key) DO UPDATE SET
      moved = identity_legacy_map.moved + excluded.moved,
      conflicts = excluded.conflicts
  `)
  const mapped = db.prepare<[string], { subject_id: string }>(
    'SELECT subject_id FROM identity_legacy_map WHERE legacy_key = ?',
  )

  const adopt = db.transaction(
    (legacyKey: string, subjectId: string, source: string, now: number) => {
      const existing = mapped.get(legacyKey)
      if (existing && existing.subject_id !== subjectId) {
        // A legacy key belongs to exactly one subject; a different answer
        // later is a data problem to look at, never a silent re-home.
        throw new Error(
          `legacy key ${legacyKey} is already mapped to ${existing.subject_id}, not ${subjectId}`,
        )
      }
      const taken = new Set(takenSlots.all(subjectId).map((r) => r.char_slot))
      let moved = 0
      let conflicts = 0
      for (const row of legacyRows.all(legacyKey)) {
        if (taken.has(row.char_slot)) {
          conflicts++
          continue
        }
        moveRow.run(subjectId, subjectId, row.id)
        taken.add(row.char_slot)
        moved++
      }
      recordMap.run(legacyKey, subjectId, source, moved, conflicts, now)
      return { moved, conflicts }
    },
  )

  return {
    adoptLegacyAccount: (legacyKey, subjectId, source, now) =>
      adopt(legacyKey, subjectId, source, now),
    subjectForLegacy(legacyKey) {
      return mapped.get(legacyKey)?.subject_id ?? null
    },
    legacyAccountKeys(prefix) {
      // substr, not LIKE: `_` and `%` in a prefix must not act as wildcards.
      const rows = db
        .prepare(
          'SELECT DISTINCT token FROM players WHERE substr(token, 1, length(@p)) = @p ORDER BY token',
        )
        .all({ p: prefix }) as { token: string }[]
      return rows.map((r) => r.token)
    },
  }
}

interface ModRow {
  id: string
  name: string
  version: string
  target: string
  runtime: string
  manifest: string
  pack: string
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
  detail: string | null
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
  manifest: JSON.parse(r.manifest) as Record<string, unknown>,
  pack: JSON.parse(r.pack) as Record<string, unknown>,
  trustTier: r.trust_tier as ModTrustTier,
  status: r.status as ModStatus,
  installedBy: r.installed_by,
  installedAt: r.installed_at,
  updatedAt: r.updated_at,
})

const rowToGrant = (r: GrantRow): ModGrantDto => ({
  modId: r.mod_id,
  capability: r.capability,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
})

export function createModRepository(db: Database.Database): ModRepository {
  const insertMod = db.prepare(`
    INSERT INTO mods (id, name, version, target, runtime, manifest, pack, trust_tier, status, installed_by, installed_at, updated_at)
    VALUES (@id, @name, @version, @target, @runtime, @manifest, @pack, @trust_tier, @status, @installed_by, @installed_at, @updated_at)
  `)
  const upsertGrant = db.prepare(`
    INSERT INTO mod_grants (mod_id, capability, granted_by, granted_at, revoked_at, revoked_by)
    VALUES (@mod_id, @capability, @granted_by, @granted_at, @revoked_at, @revoked_by)
    ON CONFLICT(mod_id, capability) DO UPDATE SET
      granted_by = excluded.granted_by, granted_at = excluded.granted_at,
      revoked_at = excluded.revoked_at, revoked_by = excluded.revoked_by
  `)
  const insertAudit = db.prepare(`
    INSERT INTO mod_audit (mod_id, action, capability, actor, detail, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const setPlacement = db.prepare(`
    INSERT INTO mod_placements (mod_id, placement_key, entity_id, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(mod_id, placement_key) DO UPDATE SET entity_id = excluded.entity_id, at = excluded.at
  `)

  return {
    list() {
      return (db.prepare('SELECT * FROM mods ORDER BY installed_at, id').all() as ModRow[]).map(
        rowToMod,
      )
    },
    get(id) {
      const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(id) as ModRow | undefined
      return row ? rowToMod(row) : null
    },
    insert(mod) {
      insertMod.run({
        id: mod.id,
        name: mod.name,
        version: mod.version,
        target: mod.target,
        runtime: mod.runtime,
        manifest: JSON.stringify(mod.manifest),
        pack: JSON.stringify(mod.pack),
        trust_tier: mod.trustTier,
        status: mod.status,
        installed_by: mod.installedBy,
        installed_at: mod.installedAt,
        updated_at: mod.updatedAt,
      })
    },
    setStatus(id, status, at) {
      db.prepare('UPDATE mods SET status = ?, updated_at = ? WHERE id = ?').run(status, at, id)
    },
    grants(modId) {
      return (
        db
          .prepare('SELECT * FROM mod_grants WHERE mod_id = ? ORDER BY capability')
          .all(modId) as GrantRow[]
      ).map(rowToGrant)
    },
    upsertGrant(g) {
      upsertGrant.run({
        mod_id: g.modId,
        capability: g.capability,
        granted_by: g.grantedBy,
        granted_at: g.grantedAt,
        revoked_at: g.revokedAt,
        revoked_by: g.revokedBy,
      })
    },
    revokeGrant(modId, capability, by, at) {
      const r = db
        .prepare(
          'UPDATE mod_grants SET revoked_at = ?, revoked_by = ? WHERE mod_id = ? AND capability = ? AND revoked_at IS NULL',
        )
        .run(at, by, modId, capability)
      return r.changes > 0
    },
    audit(e) {
      insertAudit.run(
        e.modId,
        e.action,
        e.capability,
        e.actor,
        e.detail ? JSON.stringify(e.detail) : null,
        e.at,
      )
    },
    auditLog(modId, limit) {
      return (
        db
          .prepare('SELECT * FROM mod_audit WHERE mod_id = ? ORDER BY id DESC LIMIT ?')
          .all(modId, limit) as AuditRow[]
      ).map((r): ModAuditDto => ({
        id: r.id,
        modId: r.mod_id,
        action: r.action,
        capability: r.capability,
        actor: r.actor,
        detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
        at: r.at,
      }))
    },
    placements(modId) {
      return (
        db
          .prepare('SELECT * FROM mod_placements WHERE mod_id = ? ORDER BY placement_key')
          .all(modId) as PlacementRow[]
      ).map((r): ModPlacementDto => ({
        modId: r.mod_id,
        key: r.placement_key,
        entityId: r.entity_id,
        at: r.at,
      }))
    },
    setPlacement(p) {
      setPlacement.run(p.modId, p.key, p.entityId, p.at)
    },
    deletePlacement(modId, key) {
      db.prepare('DELETE FROM mod_placements WHERE mod_id = ? AND placement_key = ?').run(
        modId,
        key,
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
  bytes: r.bytes,
  status: r.status as MediaMirrorDto['status'],
  mediaId: r.media_id,
  publicUrl: r.public_url,
  attempts: r.attempts,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  updatedAt: r.updated_at,
})

export function createMediaMirrorRepository(db: Database.Database): MediaMirrorRepository {
  return {
    enqueue(asset, now) {
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO media_mirrors (asset_hash, file_name, mime, bytes, status, attempts, next_attempt_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(asset.assetHash, asset.fileName, asset.mime, asset.bytes, now, now)
      return r.changes > 0
    },
    get(assetHash) {
      const row = db.prepare('SELECT * FROM media_mirrors WHERE asset_hash = ?').get(assetHash) as
        MirrorRow | undefined
      return row ? rowToMirror(row) : null
    },
    due(now, limit) {
      return (
        db
          .prepare(
            `SELECT * FROM media_mirrors WHERE status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at, asset_hash LIMIT ?`,
          )
          .all(now, limit) as MirrorRow[]
      ).map(rowToMirror)
    },
    noteObject(assetHash, mediaId, now) {
      db.prepare('UPDATE media_mirrors SET media_id = ?, updated_at = ? WHERE asset_hash = ?').run(
        mediaId,
        now,
        assetHash,
      )
    },
    markMirrored(assetHash, mediaId, publicUrl, now) {
      db.prepare(
        `UPDATE media_mirrors SET status = 'mirrored', media_id = ?, public_url = ?, last_error = NULL,
           attempts = attempts + 1, updated_at = ? WHERE asset_hash = ?`,
      ).run(mediaId, publicUrl, now, assetHash)
    },
    markFailed(assetHash, error, nextAttemptAt, terminal, now) {
      db.prepare(
        `UPDATE media_mirrors SET status = ?, last_error = ?, attempts = attempts + 1,
           next_attempt_at = ?, updated_at = ? WHERE asset_hash = ?`,
      ).run(terminal ? 'failed' : 'pending', error.slice(0, 500), nextAttemptAt, now, assetHash)
    },
    counts() {
      const out: Record<MediaMirrorDto['status'], number> = { pending: 0, mirrored: 0, failed: 0 }
      for (const r of db
        .prepare('SELECT status, COUNT(*) AS n FROM media_mirrors GROUP BY status')
        .all() as { status: MediaMirrorDto['status']; n: number }[]) {
        out[r.status] = r.n
      }
      return out
    },
  }
}
