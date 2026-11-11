import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { CreatorWorld } from '@openvibe/persistence'
import { CARD_TTL_S, cardFrom, createMenuCardHandler, plain } from './menuCard.js'

const contracts = createRequire(import.meta.url)('openvibe-contracts') as { validate: (id: string, value: unknown) => { valid: boolean; errors?: unknown } }

const NOW = Date.parse('2026-11-07T08:00:00Z')

const world = (id: string, over: Partial<CreatorWorld> = {}): CreatorWorld => ({
  id,
  ownerSubject: `usr_${id}`,
  ownerName: 'Builder',
  title: `World ${id}`,
  summary: 'A floating island',
  status: 'published',
  revision: 'r1',
  plays: 3,
  createdAt: NOW,
  updatedAt: NOW,
  publishedAt: NOW,
  remixedFrom: null,
  remixes: 0,
  view: '3d',
  ...over,
})

/** A ServerResponse that records the head and body and resolves when the handler ends it. */
function fakeRes() {
  const headers: Record<string, string | number | string[] | undefined> = {}
  let status = 0
  let body = ''
  let done!: () => void
  const ended = new Promise<void>((resolve) => {
    done = resolve
  })
  const res = {
    writeHead(code: number, h: Record<string, string | number | string[]> = {}) {
      status = code
      Object.assign(headers, h)
      return this
    },
    end(chunk?: string) {
      body = chunk ?? ''
      done()
      return this
    },
  } as unknown as ServerResponse
  return { res, ended, headers, status: () => status, body: () => body }
}

const req = (url: string, method = 'GET') => ({ url, method }) as IncomingMessage

const storeReturning = (rows: CreatorWorld[]) => {
  let calls = 0
  return {
    calls: () => calls,
    listPublished: async (limit: number, offset: number) => {
      calls++
      expect(limit).toBe(6)
      expect(offset).toBe(0)
      return rows
    },
  }
}

describe('the menu network card (frame.menu-card@1)', () => {
  it('is the newest published worlds, newest first, linking each to its page', () => {
    const card = cardFrom([world('a'), world('b', { title: 'Moon <b>base</b>' })], NOW)
    expect(card).toMatchObject({
      id: 'new-worlds',
      site: 'games',
      title: 'New worlds',
      kind: 'rows',
      updated_at: '2026-11-07T08:00:00.000Z',
      ttl_s: CARD_TTL_S,
    })
    expect(card.more).toEqual({ label: 'All worlds', url: 'https://openvibe.games/worlds' })
    expect(card.items).toEqual([
      { title: 'World a', meta: 'by Builder · just now', url: 'https://openvibe.games/worlds/a' },
      { title: 'Moon base', meta: 'by Builder · just now', url: 'https://openvibe.games/worlds/b' },
    ])
    expect(card.title.length).toBeLessThanOrEqual(60)
    for (const item of card.items) {
      expect(item.title.length).toBeLessThanOrEqual(80)
      expect(item.meta?.length ?? 0).toBeLessThanOrEqual(120)
      expect(item.url.startsWith('https://openvibe.games/')).toBe(true)
    }
    // The menu's contract now allows an item image, but a creator world has no cover of its own: no picture is
    // invented here (a placeholder is never sent), and the file still validates against the new schema.
    expect(card.items.every((item) => !('image' in item))).toBe(true)
    expect(contracts.validate('frame.menu-cards@1', [card]).valid).toBe(true)
  })

  it('says when each world was published, in the same short shape as the other cards', () => {
    expect(cardFrom([world('a', { publishedAt: NOW - 2 * 86_400_000 })], NOW).items[0]!.meta).toBe('by Builder · 2d ago')
    expect(cardFrom([world('a', { publishedAt: NOW - 3 * 3_600_000 })], NOW).items[0]!.meta).toBe('by Builder · 3h ago')
    // An old row with no published stamp still says when it was made rather than nothing.
    expect(cardFrom([world('a', { publishedAt: null, createdAt: NOW - 5 * 86_400_000 })], NOW).items[0]!.meta).toBe('by Builder · 5d ago')
  })

  it('sends at most six, and never a draft or a hidden world', () => {
    const many = Array.from({ length: 8 }, (_, i) => world(`w${i}`))
    expect(cardFrom(many, NOW).items).toHaveLength(6)
    expect(cardFrom([world('draft', { status: 'draft' })], NOW).items).toEqual([])
    expect(cardFrom([world('hidden', { status: 'hidden' })], NOW).items).toEqual([])
    expect(cardFrom([], NOW).items).toEqual([])
  })

  it('strips markup and control characters from the words', () => {
    expect(plain('<i>Moon</i>\n\t base ', 80)).toBe('Moon base')
    expect(plain('x'.repeat(200), 80)).toHaveLength(80)
    expect(
      cardFrom([world('a', { title: '<script>alert(1)</script>Moon' })], NOW).items[0]!.title,
    ).toBe('alert(1) Moon')
  })

  it('answers GET /.well-known/openvibe-menu.json with CORS * and a cache, and nothing else', async () => {
    const store = storeReturning([world('a')])
    const handler = createMenuCardHandler({ store, now: () => NOW })
    expect(handler(req('/other'), fakeRes().res)).toBe(false)

    const first = fakeRes()
    expect(handler(req('/.well-known/openvibe-menu.json'), first.res)).toBe(true)
    await first.ended
    expect(first.status()).toBe(200)
    expect(first.headers['access-control-allow-origin']).toBe('*')
    expect(first.headers['content-type']).toContain('application/json')
    expect(first.headers['cache-control']).toBe('public, max-age=60')
    const parsed = JSON.parse(first.body())
    expect(Array.isArray(parsed) && parsed.length).toBe(1)
    expect(parsed[0].site).toBe('games')

    const second = fakeRes()
    expect(handler(req('/.well-known/openvibe-menu.json'), second.res)).toBe(true)
    await second.ended
    expect(store.calls(), 'the second request is served from the cache').toBe(1)
  })

  it('answers [] when the store fails and no good card is cached, and keeps the last good one after', async () => {
    let fail = false
    let calls = 0
    const store = {
      listPublished: async () => {
        calls++
        if (fail) throw new Error('db down')
        return [world('a')]
      },
    }
    const handler = createMenuCardHandler({ store, now: () => NOW })
    const bad = fakeRes()
    fail = true
    handler(req('/.well-known/openvibe-menu.json'), bad.res)
    await bad.ended
    expect(bad.status()).toBe(200)
    expect(JSON.parse(bad.body())).toEqual([])
    expect(bad.headers['cache-control']).toBe('no-store')

    fail = false
    const good = fakeRes()
    handler(req('/.well-known/openvibe-menu.json'), good.res)
    await good.ended
    expect(good.status()).toBe(200)
    fail = true
    const kept = fakeRes()
    handler(req('/.well-known/openvibe-menu.json'), kept.res)
    await kept.ended
    expect(kept.status()).toBe(200)
    expect(JSON.parse(kept.body())[0].items[0].title).toBe('World a')
    expect(calls).toBe(2)
  })
})
