import type {
  ConstraintDto,
  MediaMirrorDto,
  ModAuditDto,
  ModGrantDto,
  ModInstallDto,
  ModPlacementDto,
  ModStatus,
  PlayerDto,
  WorldEntityDto,
} from './dto.js'

/**
 * Repository boundary: gameplay/server code never touches SQL or the
 * database driver. Writes are designed to be batched — the server flushes
 * dirty entities periodically and on shutdown, not per mutation.
 */

export interface WorldEntityRepository {
  loadAll(): WorldEntityDto[]
  /** Transactional batch upsert. */
  upsertMany(entities: readonly WorldEntityDto[]): void
  deleteMany(ids: readonly string[]): void
  /** Bulk removal used on world-definition changes (e.g. all resource nodes). */
  deleteByKind(kind: string): void
}

export interface PlayerRepository {
  findByToken(token: string): PlayerDto | null
  /** All characters under an account token (max 3, ordered by slot). */
  listByToken(token: string): PlayerDto[]
  findByTokenSlot(token: string, slot: number): PlayerDto | null
  /** Offline lookups (prop protection checks owners who are not connected). */
  findById(id: string): PlayerDto | null
  upsert(player: PlayerDto): void
  upsertMany(players: readonly PlayerDto[]): void
  /** World-change safety: move every player to the given spawn. */
  resetAllPositions(pos: [number, number, number], yaw: number): void
}

export interface GuestRepository {
  /** Resolve a guest connection (ip + browser token) to its canonical account token. */
  resolve(ip: string, token: string): string
}

export interface ConstraintRepository {
  loadAll(): ConstraintDto[]
  upsertMany(constraints: readonly ConstraintDto[]): void
  deleteMany(ids: readonly string[]): void
}

/**
 * Canonical identity (ADR-0006): signed-in accounts are keyed by their
 * openvibe.network subject. Accounts created before that were keyed by a
 * legacy key (`ovn:<network user id>`); adoption moves them over once and
 * remembers the mapping.
 */
export interface IdentityRepository {
  /**
   * Moves every character under `legacyKey` to `subjectId` (slots the subject
   * does not already use) and records the mapping. Idempotent: a second call
   * moves nothing. Characters whose slot is taken stay under the legacy key
   * and are reported as `conflicts`.
   */
  adoptLegacyAccount(
    legacyKey: string,
    subjectId: string,
    source: string,
    now: number,
  ): { moved: number; conflicts: number }
  /** The subject a legacy key was adopted into, if any. */
  subjectForLegacy(legacyKey: string): string | null
  /**
   * Guest conversion (roadmap WS-B task 8): the character a browser played as a guest moves into the
   * account that signs in on it, into the first free slot (0..2). Once per guest token (remembered by
   * a hash of it, never the token); `moved` 0 when there is nothing to move, it was already adopted,
   * or every slot is taken (`full`).
   */
  adoptGuestCharacter(
    guestToken: string,
    subjectId: string,
    now: number,
  ): { moved: number; slot: number | null; full: boolean }
  /** Distinct account keys under a legacy prefix that still own characters. */
  legacyAccountKeys(prefix: string): string[]
}

/** Installed mods, their approved capabilities, placements and audit log. */
export interface ModRepository {
  list(): ModInstallDto[]
  get(id: string): ModInstallDto | null
  insert(mod: ModInstallDto): void
  setStatus(id: string, status: ModStatus, at: number): void
  grants(modId: string): ModGrantDto[]
  /** Grants (or re-grants) a capability. */
  upsertGrant(grant: ModGrantDto): void
  /** Returns false when the capability was not actively granted. */
  revokeGrant(modId: string, capability: string, by: string, at: number): boolean
  audit(entry: ModAuditDto): void
  auditLog(modId: string, limit: number): ModAuditDto[]
  placements(modId: string): ModPlacementDto[]
  setPlacement(placement: ModPlacementDto): void
  deletePlacement(modId: string, key: string): void
}

/** Queue of local assets to copy into OpenVibe.Media. */
export interface MediaMirrorRepository {
  /** Queues an asset; false when it is already known (queued or mirrored). */
  enqueue(
    asset: { assetHash: string; fileName: string; mime: string; bytes: number },
    now: number,
  ): boolean
  get(assetHash: string): MediaMirrorDto | null
  /** Pending rows whose next attempt is due, oldest first. */
  due(now: number, limit: number): MediaMirrorDto[]
  /** Remembers the Media object created for an asset before its bytes are confirmed. */
  noteObject(assetHash: string, mediaId: string, now: number): void
  markMirrored(assetHash: string, mediaId: string, publicUrl: string | null, now: number): void
  markFailed(
    assetHash: string,
    error: string,
    nextAttemptAt: number,
    terminal: boolean,
    now: number,
  ): void
  counts(): Record<MediaMirrorDto['status'], number>
}

export interface MetaRepository {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface PersistenceStore {
  readonly worldEntities: WorldEntityRepository
  readonly players: PlayerRepository
  guests: GuestRepository
  readonly constraints: ConstraintRepository
  readonly meta: MetaRepository
  readonly identity: IdentityRepository
  readonly mods: ModRepository
  readonly mediaMirrors: MediaMirrorRepository
  /**
   * Runs `fn` in one transaction (nested calls become savepoints). Anything
   * written inside — world rows, player rows, outbox events — commits or
   * rolls back together.
   */
  transaction<T>(fn: () => T): T
  close(): void
}
