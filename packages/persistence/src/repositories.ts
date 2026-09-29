import type { Db, Tx } from 'openvibe-sdk/db'
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
 * database driver. Every method is async (PostgreSQL through openvibe-sdk/db);
 * the server's write-behind flusher batches world rows in one transaction
 * rather than writing per mutation.
 */

export interface WorldEntityRepository {
  loadAll(): Promise<WorldEntityDto[]>
  /** Batch upsert, chunked multi-row INSERT … ON CONFLICT. */
  upsertMany(entities: readonly WorldEntityDto[]): Promise<void>
  deleteMany(ids: readonly string[]): Promise<void>
  /** Bulk removal used on world-definition changes (e.g. all resource nodes). */
  deleteByKind(kind: string): Promise<void>
}

export interface PlayerRepository {
  /** Looks a character up by account token; a guest token is hashed first. */
  findByToken(token: string): Promise<PlayerDto | null>
  /** All characters under an account token (max 3, ordered by slot). */
  listByToken(token: string): Promise<PlayerDto[]>
  findByTokenSlot(token: string, slot: number): Promise<PlayerDto | null>
  /** Offline lookups (prop protection checks owners who are not connected). */
  findById(id: string): Promise<PlayerDto | null>
  upsert(player: PlayerDto): Promise<void>
  upsertMany(players: readonly PlayerDto[]): Promise<void>
  /** World-change safety: move every player to the given spawn. */
  resetAllPositions(pos: [number, number, number], yaw: number): Promise<void>
}

export interface ConstraintRepository {
  loadAll(): Promise<ConstraintDto[]>
  upsertMany(constraints: readonly ConstraintDto[]): Promise<void>
  deleteMany(ids: readonly string[]): Promise<void>
}

/**
 * Canonical identity (ADR-0006): signed-in accounts are keyed by their
 * openvibe.network subject. Adoptions (a guest character joining the account
 * that signs in on it; a merged account's characters) are recorded once, in
 * `identity_adoptions`, so a redelivered event cannot move the same rows twice.
 */
export interface IdentityRepository {
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
  ): Promise<{ moved: number; slot: number | null; full: boolean }>
  /**
   * Account merge (roadmap WS-B task 5, ADR-029; network.subject.merged): the folded-in subject's characters
   * move to the survivor, each into its own slot when free there, else the first free one (0..2). A character
   * with no free slot stays under the folded-in subject (kept, never deleted). Once per merge id; `already`
   * when that merge was applied before.
   */
  mergeSubject(
    fromSubject: string,
    intoSubject: string,
    mergeId: string,
    now: number,
  ): Promise<{ moved: number; kept: number; already: boolean }>
  /**
   * What Games keeps about a subject, for their data export (roadmap WS-B task 7, ADR-033): their characters (without
   * the account key) and the world structures those characters own.
   */
  exportSubject(subject: string): Promise<{
    characters: Record<string, unknown>[]
    structures: Record<string, unknown>[]
  }>
  /**
   * Erase these subjects (a deleted account and the accounts merged into it; ADR-033), in one transaction: their
   * characters and adoption rows go; the structures their characters built stay in the world without an owner.
   * Returns counts.
   */
  eraseSubjects(subjects: string[]): Promise<{
    characters: number
    structures_unowned: number
    identity_rows: number
  }>
}

/** Installed mods, their approved capabilities, placements and audit log. */
export interface ModRepository {
  list(): Promise<ModInstallDto[]>
  get(id: string): Promise<ModInstallDto | null>
  insert(mod: ModInstallDto): Promise<void>
  setStatus(id: string, status: ModStatus, at: number): Promise<void>
  grants(modId: string): Promise<ModGrantDto[]>
  /** Grants (or re-grants) a capability. */
  upsertGrant(grant: ModGrantDto): Promise<void>
  /** Returns false when the capability was not actively granted. */
  revokeGrant(modId: string, capability: string, by: string, at: number): Promise<boolean>
  audit(entry: ModAuditDto): Promise<void>
  auditLog(modId: string, limit: number): Promise<ModAuditDto[]>
  placements(modId: string): Promise<ModPlacementDto[]>
  setPlacement(placement: ModPlacementDto): Promise<void>
  deletePlacement(modId: string, key: string): Promise<void>
}

/** Queue of local assets to copy into OpenVibe.Media. */
export interface MediaMirrorRepository {
  /** Queues an asset; false when it is already known (queued or mirrored). */
  enqueue(
    asset: { assetHash: string; fileName: string; mime: string; bytes: number },
    now: number,
  ): Promise<boolean>
  get(assetHash: string): Promise<MediaMirrorDto | null>
  /** Pending rows whose next attempt is due, oldest first. */
  due(now: number, limit: number): Promise<MediaMirrorDto[]>
  /** Remembers the Media object created for an asset before its bytes are confirmed. */
  noteObject(assetHash: string, mediaId: string, now: number): Promise<void>
  markMirrored(
    assetHash: string,
    mediaId: string,
    publicUrl: string | null,
    now: number,
  ): Promise<void>
  markFailed(
    assetHash: string,
    error: string,
    nextAttemptAt: number,
    terminal: boolean,
    now: number,
  ): Promise<void>
  counts(): Promise<Record<MediaMirrorDto['status'], number>>
}

/** Per-place key/value state. Values are JSON: env_time, env_weather, market_<id>, … */
export interface MetaRepository {
  get(key: string): Promise<unknown | null>
  set(key: string, value: unknown): Promise<void>
  /** Every key beginning with `prefix`, for boot-time loads (markets). */
  list(prefix: string): Promise<{ key: string; value: unknown }[]>
}

export interface PersistenceStore {
  /**
   * The openvibe-sdk/db handle. Exposed ONLY for apps/server's platform adapters that must share the
   * exact same transaction as the state they describe — the event outbox (createPgOutbox), the token
   * revocations (createPgRevocationStore) and the account-data adapter. Gameplay code goes through the
   * repositories below and never touches this.
   */
  readonly db: Db
  readonly placeId: string
  /** Upserts this instance's configured place; call once at boot before any world write. */
  ensurePlace(name?: string): Promise<void>
  readonly worldEntities: WorldEntityRepository
  readonly players: PlayerRepository
  readonly constraints: ConstraintRepository
  readonly meta: MetaRepository
  readonly identity: IdentityRepository
  readonly mods: ModRepository
  readonly mediaMirrors: MediaMirrorRepository
  /**
   * Runs `fn` in one transaction (a nested call becomes a savepoint). Anything written inside — world
   * rows, character rows, outbox events — commits or rolls back together. Plain repository and db calls
   * made inside `fn` join the transaction (the SDK's ambient mode). `fn` receives the SDK transaction
   * handle: the outbox must be handed exactly this handle, so an event cannot be written on a different
   * connection than the change it describes.
   */
  transaction<T>(fn: (t: Tx) => Promise<T>): Promise<T>
  close(): Promise<void>
}
