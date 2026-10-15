import { createRequire } from 'node:module'
import type { CreatorWorld } from '@openvibe/persistence'
import type { Db, Tx } from 'openvibe-sdk/db'
import { sql } from 'openvibe-sdk/db'

/**
 * Creator worlds in OpenVibe.Search (openvibe-publishing/search-feed, contracts 0.195.0): one
 * search.index-document@1 per published world (/worlds/<id>), sent as games.index_document.upserted|deleted through
 * Games' event outbox in the transaction of the change. A world that is a draft, hidden or gone is a tombstone. The
 * document is what the world's page says: its title, who made it and their summary. The sequencer
 * (games_index_revisions) sends nothing for an unchanged document, so the sweep (a minute after boot, then every six
 * hours) is cheap and catches anything a write missed.
 */

interface SearchFeed {
  sync(t: Tx, type: string, row: unknown): Promise<unknown>
  remove(t: Tx, type: string, id: string): Promise<unknown>
  sweep(): Promise<Record<string, { seen: number; sent: number; removed: number; failed: number }>>
}
interface SearchFeedModule {
  createSearchFeed(options: Record<string, unknown>): SearchFeed
}

const START_DELAY_MS = 60_000
const INTERVAL_MS = 6 * 3_600_000

interface Row {
  id: string
  owner_name: string
  title: string
  summary: string
  status: string
  published_at: number | string | null
  updated_at: number | string
}

/** One world → what its /worlds/<id> page says. */
export function describeWorld(row: Row) {
  const summary = row.summary || `A creator world by ${row.owner_name} on OpenVibe.Games.`
  return {
    listed: row.status === 'published',
    title: row.title,
    summary,
    body: [
      row.title,
      row.summary,
      `Made by ${row.owner_name}.`,
      'A creator world on OpenVibe.Games: join it from your browser, no download.',
    ]
      .filter(Boolean)
      .join('\n'),
    facets: { kind: 'creator_world', owner: row.owner_name },
    authorship: { mode: 'human' },
    publishedAt:
      row.published_at === null ? null : new Date(Number(row.published_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  }
}

export interface WorldSearchIndex {
  /** Index (or tombstone) a world in the transaction that changed it. */
  sync(t: Tx, world: CreatorWorld): Promise<void>
  /** Tombstone a world in the transaction that deletes it. */
  remove(t: Tx, id: string): Promise<void>
  sweep(): Promise<void>
  start(): void
  stop(): void
}

export function createWorldSearchIndex(opts: {
  db: Db
  outbox: { enqueue(t: Tx, event: unknown, opts?: unknown): Promise<unknown>; kick?(): unknown }
  baseUrl: string
  log: {
    info(msg: string, f?: Record<string, unknown>): void
    warn(msg: string, f?: Record<string, unknown>): void
  }
  require?: NodeRequire
}): WorldSearchIndex {
  const req = opts.require ?? createRequire(import.meta.url)
  const { createSearchFeed } = req('openvibe-publishing/search-feed') as SearchFeedModule
  const columns = sql`id, owner_name, title, summary, status, published_at, updated_at`
  const feed = createSearchFeed({
    owner: 'games',
    db: opts.db,
    outbox: opts.outbox,
    baseUrl: opts.baseUrl,
    log: { log: (m: string) => opts.log.info(m), warn: (m: string) => opts.log.warn(m) },
    types: {
      world: {
        page: (row: Row) => `/worlds/${row.id}`,
        document: describeWorld,
        rows: (after: string, limit: number) =>
          opts.db.many<Row>(
            sql`SELECT ${columns} FROM creator_worlds WHERE id > ${after} ORDER BY id LIMIT ${limit}`,
          ),
        exists: async (ids: string[]) =>
          ids.length
            ? (
                await opts.db.many<{ id: string }>(
                  sql`SELECT id FROM creator_worlds WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})`,
                )
              ).map((r) => r.id)
            : [],
      },
    },
  })
  const timers: ReturnType<typeof setTimeout>[] = []
  const toRow = (w: CreatorWorld): Row => ({
    id: w.id,
    owner_name: w.ownerName,
    title: w.title,
    summary: w.summary,
    status: w.status,
    published_at: w.publishedAt,
    updated_at: w.updatedAt,
  })
  const sweep = async (): Promise<void> => {
    const res = await feed.sweep()
    const w = res.world
    if (w && (w.sent || w.removed || w.failed))
      opts.log.info('search sweep', {
        sent: w.sent,
        removed: w.removed,
        failed: w.failed,
        seen: w.seen,
      })
    void opts.outbox.kick?.()
  }
  const quietly = (): void => {
    sweep().catch((err: unknown) => opts.log.warn('search sweep failed', { error: String(err) }))
  }
  return {
    sync: async (t, world) => {
      await feed.sync(t, 'world', toRow(world))
    },
    remove: async (t, id) => {
      await feed.remove(t, 'world', id)
    },
    sweep,
    start: () => {
      if (timers.length) return
      const first = setTimeout(quietly, START_DELAY_MS)
      const every = setInterval(quietly, INTERVAL_MS)
      first.unref()
      every.unref()
      timers.push(first, every)
    },
    stop: () => {
      for (const t of timers.splice(0)) {
        clearTimeout(t)
        clearInterval(t)
      }
    },
  }
}
