import { createRequire } from 'node:module'
import { emptyMapV2 } from '@openvibe/content'
import { createCreatorWorldStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import type { Tx } from 'openvibe-sdk/db'
import { describe, expect, it } from 'vitest'
import { createWorldSearchIndex, describeWorld } from './searchIndex.js'
import { worldPageHtml } from './worldPage.js'

const req = createRequire(import.meta.url)
const { validate } = req('openvibe-contracts') as {
  validate(id: string, v: unknown): { valid: boolean; errors?: unknown }
}
const KIM = 'usr_01J0000000000000000000000K'
const silent = { info: () => {}, warn: () => {} }

interface Sent {
  event_type: string
  payload: Record<string, unknown>
}

describe('creator worlds in OpenVibe.Search', () => {
  it('describes a world as its page does, and a draft as a tombstone', () => {
    const row = {
      id: 'wk3j9x0a2bq',
      owner_name: 'kim',
      title: 'Moon base',
      summary: '',
      status: 'published',
      published_at: 1_000,
      updated_at: 2_000,
    }
    expect(describeWorld(row)).toMatchObject({
      listed: true,
      title: 'Moon base',
      summary: 'A creator world by kim on OpenVibe.Games.',
      facets: { kind: 'creator_world', owner: 'kim' },
    })
    expect(describeWorld({ ...row, status: 'draft' }).listed).toBe(false)
    expect(describeWorld({ ...row, status: 'hidden' }).listed).toBe(false)
  })

  it('sends a published world, a tombstone when it is unpublished or deleted, and nothing for a draft', async () => {
    const db = await openTestDb()
    const store = createCreatorWorldStore(db)
    const sent: Sent[] = []
    const search = createWorldSearchIndex({
      db,
      outbox: {
        enqueue: async (_t: Tx, event: unknown) => {
          sent.push(event as Sent)
        },
      },
      baseUrl: 'https://openvibe.games',
      log: silent,
    })
    const draft = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'Draft',
      summary: '',
      map: emptyMapV2(),
      now: 1,
    })
    await search.sweep()
    expect(sent).toEqual([])

    const world = await store.create({
      ownerSubject: KIM,
      ownerName: 'kim',
      title: 'Moon base',
      summary: 'Low gravity.',
      map: emptyMapV2(),
      now: 2,
    })
    const published = await store.update(world.id, { status: 'published' }, 3)
    if (!published) throw new Error('no world')
    await db.tx((t) => search.sync(t, published))
    expect(sent.map((e) => e.event_type)).toEqual(['games.index_document.upserted'])
    const doc = sent[0]?.payload ?? {}
    expect(doc).toMatchObject({
      owner: 'games',
      type: 'world',
      id: world.id,
      deleted: false,
      canonical_url: `https://openvibe.games/worlds/${world.id}`,
      title: 'Moon base',
      summary: 'Low gravity.',
    })
    expect(validate('games.index_document.upserted@1', doc)).toMatchObject({ valid: true })

    // Unchanged: the sweep sends nothing new. Unpublished: a tombstone. Deleted afterwards: nothing more.
    await search.sweep()
    expect(sent).toHaveLength(1)
    const unpublished = await store.update(world.id, { status: 'draft' }, 4)
    if (!unpublished) throw new Error('no world')
    await db.tx((t) => search.sync(t, unpublished))
    expect(sent.map((e) => e.event_type)).toEqual([
      'games.index_document.upserted',
      'games.index_document.deleted',
    ])
    expect(validate('games.index_document.deleted@1', sent[1]?.payload)).toMatchObject({
      valid: true,
    })

    // A published world whose row disappears without a sync gets its tombstone from the sweep.
    const again = await store.update(world.id, { status: 'published' }, 5)
    if (!again) throw new Error('no world')
    await db.tx((t) => search.sync(t, again))
    await store.remove(world.id)
    await search.sweep()
    expect(sent.at(-1)?.event_type).toBe('games.index_document.deleted')
    expect(sent.some((e) => e.payload.id === draft.id)).toBe(false)
  })

  it("renders a world's page with its text escaped", () => {
    const shell = req('openvibe-shared/shell') as { page(o: Record<string, unknown>): string }
    const html = worldPageHtml(
      {
        id: 'wk3j9x0a2bq',
        ownerSubject: KIM,
        ownerName: 'kim <b>',
        title: 'Moon <script>',
        summary: 'Low & slow',
        status: 'published',
        revision: 'r',
        plays: 1,
        createdAt: 1,
        updatedAt: 2,
        publishedAt: 2,
        remixedFrom: null,
        remixes: 0,
      },
      'https://openvibe.games',
      shell,
    )
    expect(html).toContain('Moon &lt;script&gt;')
    expect(html).not.toContain('Moon <script>')
    expect(html).toContain('by kim &lt;b&gt;')
    expect(html).toContain('href="/play?world=wk3j9x0a2bq"')
    expect(html).toContain('<link rel="canonical" href="https://openvibe.games/worlds/wk3j9x0a2bq"')
    expect(html).toContain('1 visit')
    expect(html).toContain('href="/worlds?remix=wk3j9x0a2bq"')
    expect(html).not.toContain('Remix of')
    const remix = worldPageHtml(
      {
        id: 'wremix00001',
        ownerSubject: KIM,
        ownerName: 'lee',
        title: 'Moon (remix)',
        summary: '',
        status: 'published',
        revision: 'r',
        plays: 0,
        createdAt: 1,
        updatedAt: 2,
        publishedAt: 2,
        remixedFrom: { id: 'wk3j9x0a2bq', title: 'Moon <script>', owner: 'kim <b>' },
        remixes: 2,
      },
      'https://openvibe.games',
      shell,
    )
    expect(remix).toContain('Remix of <a href="/worlds/wk3j9x0a2bq">Moon &lt;script&gt;</a> by kim &lt;b&gt;')
    expect(remix).toContain('0 visits · 2 remixes')
  })
})
