import { sql, type Db } from 'openvibe-sdk/db'

export type InstanceState = 'starting' | 'running' | 'draining' | 'stopped'

export interface InstanceLease {
  id: string
  placeId: string
  slot: number
  capacity: number
  state: InstanceState
  holder: string
  version: number
  heartbeatAt: number
  leaseUntil: number
}

/** The outcome of one heartbeat: the renewed lease, and whether its TTL had already lapsed. */
export interface LeaseHeartbeat {
  lease: InstanceLease
  /** True when the TTL had lapsed and no other holder had claimed the row (a regain, not a renew). */
  regained: boolean
}

/**
 * The heartbeat's own statement timeout in milliseconds. The lease TTL is 15 s and the heartbeat runs
 * every 5 s (main.ts). Without a cap one slow query waits on the connection's 15 s query timeout,
 * spans the whole TTL and loses the lease over a briefly slow database (production saw an 8.7 s
 * heartbeat UPDATE). Two seconds leaves room for a regain attempt before the next heartbeat and is
 * longer than a healthy round trip through PgBouncer.
 */
export const HEARTBEAT_STATEMENT_TIMEOUT_MS = 2_000

interface InstanceRow {
  id: string
  place_id: string
  slot: number
  capacity: number
  state: InstanceState
  holder: string
  lease_version: number
  heartbeat_at: number
  lease_until: number
}

function lease(row: InstanceRow): InstanceLease {
  return {
    id: row.id,
    placeId: row.place_id,
    slot: row.slot,
    capacity: row.capacity,
    state: row.state,
    holder: row.holder,
    version: Number(row.lease_version),
    heartbeatAt: Number(row.heartbeat_at),
    leaseUntil: Number(row.lease_until),
  }
}

/** PostgreSQL is the lease authority. Every transition checks holder and version. */
export class InstanceRegistry {
  constructor(
    private readonly db: Db,
    readonly placeId: string,
  ) {}

  async list(): Promise<InstanceLease[]> {
    return (
      await this.db.many<InstanceRow>(
        sql`SELECT * FROM game_instances WHERE place_id = ${this.placeId} ORDER BY slot`,
      )
    ).map(lease)
  }

  /** Claim one configured slot. Expired claims can be stolen; each steal fences the old holder. */
  async claim(
    slot: number,
    capacity: number,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<InstanceLease | null> {
    if (!Number.isInteger(slot) || slot < 0 || capacity < 1 || ttlMs < 1)
      throw new Error('invalid instance claim')
    const id = `${this.placeId}:${slot}`
    const row = await this.db.maybe<InstanceRow>(sql`
      INSERT INTO game_instances (place_id, slot, id, capacity, state, holder, heartbeat_at, lease_until)
      VALUES (${this.placeId}, ${slot}, ${id}, ${capacity}, 'starting', ${holder}, ${now}, ${now + ttlMs})
      ON CONFLICT (place_id, slot) DO UPDATE SET
        capacity = excluded.capacity, state = 'starting', holder = excluded.holder,
        lease_version = game_instances.lease_version + 1,
        heartbeat_at = excluded.heartbeat_at, lease_until = excluded.lease_until
      WHERE game_instances.lease_until <= ${now} OR game_instances.state = 'stopped'
      RETURNING *
    `)
    return row ? lease(row) : null
  }

  async renew(
    current: InstanceLease,
    now: number,
    ttlMs: number,
    state: InstanceState = current.state,
  ): Promise<InstanceLease | null> {
    const row = await this.db.maybe<InstanceRow>(sql`
      UPDATE game_instances SET heartbeat_at = ${now}, lease_until = ${now + ttlMs}, state = ${state}
      WHERE id = ${current.id} AND holder = ${current.holder}
        AND lease_version = ${current.version} AND lease_until > ${now}
      RETURNING *
    `)
    return row ? lease(row) : null
  }

  /**
   * One heartbeat in a single transaction, with its own short statement timeout:
   *
   *  1. renew while the lease is still valid (`lease_until > now`), or
   *  2. take the row back when this holder and version still own it and only the TTL lapsed because
   *     the database was unreachable. The UPDATE is fenced by holder and version, so a competing
   *     claim either commits first (this returns null) or sees the renewed lease (that claim fails).
   *
   * On the same holder and version the version is not bumped: the store's lease guard captured this
   * lease object, and writes queued before the outage must be valid again after the regain.
   *
   * Returns null when another holder owns the row (or it was stopped): that lease cannot be regained.
   * Throws on a database error; the caller treats that as "lease unconfirmed" and retries with backoff.
   */
  async heartbeat(
    current: InstanceLease,
    now: number,
    ttlMs: number,
    state: InstanceState = current.state,
  ): Promise<LeaseHeartbeat | null> {
    if (ttlMs < 1) throw new Error('invalid instance heartbeat')
    return this.db.tx(async (tx) => {
      // SET LOCAL is transaction-scoped, so the pool connection resumes its normal timeout afterwards.
      // The value comes from a constant, never from input.
      await tx.exec(sql.raw(`SET LOCAL statement_timeout = ${HEARTBEAT_STATEMENT_TIMEOUT_MS}`))
      const renewed = await tx.maybe<InstanceRow>(sql`
        UPDATE game_instances SET heartbeat_at = ${now}, lease_until = ${now + ttlMs}, state = ${state}
        WHERE id = ${current.id} AND holder = ${current.holder}
          AND lease_version = ${current.version} AND lease_until > ${now}
        RETURNING *
      `)
      if (renewed) return { lease: lease(renewed), regained: false }
      const regained = await tx.maybe<InstanceRow>(sql`
        UPDATE game_instances SET heartbeat_at = ${now}, lease_until = ${now + ttlMs}, state = ${state}
        WHERE id = ${current.id} AND holder = ${current.holder}
          AND lease_version = ${current.version} AND state <> 'stopped'
        RETURNING *
      `)
      return regained ? { lease: lease(regained), regained: true } : null
    })
  }

  async stop(current: InstanceLease): Promise<boolean> {
    const row = await this.db.maybe<{ id: string }>(sql`
      UPDATE game_instances SET state = 'stopped', lease_until = 0
      WHERE id = ${current.id} AND holder = ${current.holder} AND lease_version = ${current.version}
      RETURNING id
    `)
    return row !== null
  }

  /** Call in the same transaction as the protected write. SELECT FOR UPDATE blocks a competing claim. */
  async assertHeld(current: InstanceLease, now: number): Promise<void> {
    const row = await this.db.maybe<{ id: string }>(sql`
      SELECT id FROM game_instances WHERE id = ${current.id} AND holder = ${current.holder}
        AND lease_version = ${current.version} AND lease_until > ${now}
        AND state IN ('starting', 'running', 'draining') FOR UPDATE
    `)
    if (!row) throw new Error(`instance lease lost: ${current.id}`)
  }
}
