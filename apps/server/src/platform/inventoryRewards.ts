/** Inventory items earned by Games achievements. All network work happens after unlock commits. */
import { sql, type Db } from 'openvibe-sdk/db'
import { SCRAPLANDIA_PACK } from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'

const AUDIENCE = 'openvibe.inventory'
const SCOPE = 'inventory.item.grant'
const RETRY_MS = 3 * 60_000
const CACHE_MS = 60 * 60_000
const TIMEOUT_MS = 5000
const rewards = {
  scraplandia: SCRAPLANDIA_PACK.achievements ?? [],
  'salvage-rush': SALVAGE_RUSH_PACK.game?.achievements ?? [],
}

type Row = {
  game_id: string
  achievement_id: string
  account_key: string
  item_state: string | null
  item_attempts?: number | null
  item_updated_at?: number | string | null
}

/** A failed grant waits 2^attempts minutes (at most 6 h) before the timer tries it again. */
function backoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 2 ** Math.min(9, Math.max(1, attempts)) * 60_000)
}

export class InventoryRewards {
  private timer: ReturnType<typeof setInterval> | null = null
  private cache: { at: number; aliases: Map<string, string> } | null = null
  private readonly active = new Set<string>()
  private scanning = false

  constructor(
    private readonly opts: {
      db: Db
      url: string
      enabled: boolean
      tokens: { getToken(ctx?: { audience?: string; scope?: string }): Promise<string> } | null
      fetchImpl?: typeof fetch
      now?: () => number
      warn?: (message: string) => void
    },
  ) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)()
  }
  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }
  private get base(): string {
    return this.opts.url.replace(/\/+$/, '')
  }

  private definition(game: string, achievement: string) {
    if (game !== 'scraplandia' && game !== 'salvage-rush') return null
    return rewards[game].find((def) => def.id === achievement && def.reward) ?? null
  }

  private async definitionId(alias: string): Promise<string> {
    if (!this.cache || this.now - this.cache.at >= CACHE_MS) {
      const response = await this.fetchImpl(
        `${this.base}/api/v1/definitions?issuer=service%3Alive&limit=500`,
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      if (!response.ok) throw new Error(`Inventory definitions ${response.status}`)
      const body = (await response.json()) as {
        definitions?: { id: string; issuer: string; aliases?: string[] }[]
      }
      const aliases = new Map<string, string>()
      for (const def of body.definitions ?? []) {
        if (def.issuer === 'service:live')
          for (const name of def.aliases ?? []) aliases.set(name, def.id)
      }
      this.cache = { at: this.now, aliases }
    }
    const id = this.cache.aliases.get(alias)
    if (!id) throw new Error(`Inventory definition missing: ${alias}`)
    return id
  }

  /** Settle one committed unlock, or every pending unlock for a newly adopted subject. */
  async settleSubject(subject: string): Promise<void> {
    if (!this.opts.enabled || !this.opts.tokens || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject))
      return
    const rows = await this.opts.db.many<Row>(sql`
      SELECT game_id, achievement_id, account_key, item_state FROM game_achievements
      WHERE account_key = ${subject} AND item_state IS DISTINCT FROM 'granted'
      ORDER BY unlocked_at LIMIT 50
    `)
    for (const row of rows) await this.settle(row)
  }

  private async settle(row: Row): Promise<void> {
    if (
      !this.opts.enabled ||
      !this.opts.tokens ||
      row.item_state === 'granted' ||
      !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(row.account_key)
    )
      return
    const def = this.definition(row.game_id, row.achievement_id)
    if (!def?.reward) return
    const key = `${row.game_id}:${row.achievement_id}:${row.account_key}`
    if (this.active.has(key)) return
    this.active.add(key)
    try {
      const current = await this.opts.db.maybe<Row>(sql`
        SELECT game_id, achievement_id, account_key, item_state FROM game_achievements
        WHERE game_id = ${row.game_id} AND achievement_id = ${row.achievement_id}
          AND account_key = ${row.account_key}
      `)
      if (!current || current.item_state === 'granted') return
      const id = await this.definitionId(def.reward.item)
      const token = await this.opts.tokens.getToken({ audience: AUDIENCE, scope: SCOPE })
      const response = await this.fetchImpl(`${this.base}/api/v1/grants`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          definition_id: id,
          subject: row.account_key,
          idempotency_key: `games:${key}`,
          origin: 'earned',
          reason: `Games: ${row.game_id} — ${def.name}`.slice(0, 200),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = (await response.json().catch(() => null)) as {
        instance?: { id?: string }
        code?: string
      } | null
      if (!response.ok)
        throw new Error(`Inventory ${response.status}${body?.code ? `: ${body.code}` : ''}`)
      await this.opts.db.exec(sql`
        UPDATE game_achievements SET item_state = 'granted', item_error = NULL,
          item_instance = ${body?.instance?.id ?? null}, item_attempts = item_attempts + 1,
          item_updated_at = ${this.now}
        WHERE game_id = ${row.game_id} AND achievement_id = ${row.achievement_id}
          AND account_key = ${row.account_key}
      `)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200)
      this.opts.warn?.(`Inventory reward ${key}: ${message}`)
      await this.opts.db.exec(sql`
        UPDATE game_achievements SET item_state = 'failed', item_error = ${message},
          item_attempts = item_attempts + 1, item_updated_at = ${this.now}
        WHERE game_id = ${row.game_id} AND achievement_id = ${row.achievement_id}
          AND account_key = ${row.account_key} AND item_state IS DISTINCT FROM 'granted'
      `)
    } finally {
      this.active.delete(key)
    }
  }

  /** Bounded scan also catches achievements unlocked before item rewards existed. */
  async retryPending(limit = 50): Promise<void> {
    if (!this.opts.enabled || !this.opts.tokens || this.scanning) return
    this.scanning = true
    try {
      const rows = await this.opts.db.many<Row>(sql`
        SELECT game_id, achievement_id, account_key, item_state, item_attempts, item_updated_at FROM game_achievements
        WHERE account_key LIKE 'usr_%' AND item_state IS DISTINCT FROM 'granted'
          AND ((game_id = 'scraplandia' AND achievement_id IN ('first-haul', 'big-haul', 'haul-week'))
            OR (game_id = 'salvage-rush' AND achievement_id IN ('first-haul', 'big-haul', 'arena-winner')))
        ORDER BY COALESCE(item_updated_at, 0), unlocked_at LIMIT ${Math.max(1, Math.min(limit, 100))}
      `)
      for (const row of rows) {
        // An Inventory that keeps refusing (an outage, or the grant not yet in place) is not asked every 3 minutes.
        if (row.item_state === 'failed' && this.now - Number(row.item_updated_at ?? 0) < backoffMs(Number(row.item_attempts ?? 0)))
          continue
        await this.settle(row)
      }
    } finally {
      this.scanning = false
    }
  }

  start(intervalMs = RETRY_MS): void {
    if (!this.opts.enabled || !this.opts.tokens || this.timer) return
    const run = () =>
      void this.retryPending().catch((error: unknown) => this.opts.warn?.(String(error)))
    run()
    this.timer = setInterval(run, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
