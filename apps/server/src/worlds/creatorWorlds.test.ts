import {
  createContent,
  creatorWorldPack,
  emptyMapV2,
  SCRAPLANDIA_PACK,
  type ContentRegistry,
} from '@openvibe/content'
import {
  InstanceRegistry,
  createCreatorWorldStore,
  openPgStore,
  type CreatorWorld,
  type InstanceLease,
} from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { PROTOCOL_VERSION, defaultAppearance, type ServerMessage } from '@openvibe/protocol'
import { createConsoleLogger } from '@openvibe/shared'
import { sql } from 'openvibe-sdk/db'
import { expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { GameServer, type GameConnection } from '../game/gameServer.js'
import { GameWorld } from '../game/gameWorld.js'
import { InstanceHub } from '../game/instanceHub.js'
import { PlaceRouter } from '../game/placeRouter.js'
import { ServerMetrics } from '../observability/metrics.js'
import { createWorldHubStarter } from './startWorldHub.js'
import { CreatorWorldHost, mayJoin } from './worldHost.js'

const log = createConsoleLogger({ app: 'creator-worlds-test' }, 'error')
const KIM = 'usr_01J0000000000000000000000K'
const LEE = 'usr_01J0000000000000000000000L'

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

it('decides who joins a world that is not published', () => {
  const world = { ownerSubject: KIM, status: 'draft' } as CreatorWorld
  const as = (identity: NonNullable<GameConnection['identity']>): GameConnection => ({
    identity,
    send: () => {},
    close: () => {},
  })
  const kim = as({ subject: KIM, rank: null, authIat: null })
  const lee = as({ subject: LEE, rank: null, authIat: null })
  const admin = as({ subject: LEE, rank: 'admin', authIat: null })
  const guest = as({ guestKeyHash: 'a'.repeat(64) })
  expect([kim, lee, admin, guest].map((c) => mayJoin(world, c))).toEqual([true, false, true, false])
  const hidden = { ...world, status: 'hidden' } as CreatorWorld
  expect([kim, admin].map((c) => mayJoin(hidden, c))).toEqual([false, true])
  const published = { ...world, status: 'published' } as CreatorWorld
  expect(mayJoin(published, guest)).toBe(true)
})

it('starts a published creator world on the first join, sandboxes characters, refuses beyond the cap, stops when idle', async () => {
  const db = await openTestDb()
  const rapier = await loadRapier()
  const config = loadConfig({ GAMES_PLACE_ID: 'scraplandia' })
  // The built-in default place the router always hosts.
  const registry = new InstanceRegistry(db, 'scraplandia')
  await openPgStore(db, { placeId: 'scraplandia' }).ensurePlace()
  const claimed = await registry.claim(0, 4, 'holder', Date.now(), 30_000)
  if (!claimed) throw new Error('claim failed')
  let lease: InstanceLease = claimed
  const store = openPgStore(db, {
    placeId: 'scraplandia',
    instanceSlot: 0,
    leaseGuard: () => registry.assertHeld(lease, Date.now()),
  })
  const physics = createRapierWorld(rapier)
  const world = new GameWorld(
    createContent([], SCRAPLANDIA_PACK),
    physics,
    log,
    config.interestCell,
  )
  await world.seedOrRestore(store)
  const game = new GameServer(
    { ...config, placeId: 'scraplandia' },
    world,
    store,
    new ServerMetrics(),
    log,
  )
  await game.load()
  lease = (await registry.renew(lease, Date.now(), 30_000, 'running')) ?? lease
  const hub = new InstanceHub(
    registry,
    { lease, game, world, dispose: () => physics.dispose() },
    1,
    4,
    async () => {
      throw new Error('unexpected room creation')
    },
    log,
  )

  const worlds = createCreatorWorldStore(db)
  const contents = new Map<string, ContentRegistry>()
  const contentFor = (id: string): ContentRegistry => {
    const built = contents.get(id) ?? createContent([], creatorWorldPack(id))
    contents.set(id, built)
    return built
  }
  const map = { ...emptyMapV2(), spawn: [3, 1, 3] as [number, number, number] }
  const open = await worlds.create({
    ownerSubject: KIM,
    ownerName: 'kim',
    title: 'Open',
    summary: '',
    map,
    now: 1,
  })
  await worlds.update(open.id, { status: 'published' }, 2)
  const draft = await worlds.create({
    ownerSubject: KIM,
    ownerName: 'kim',
    title: 'Draft',
    summary: '',
    map,
    now: 3,
  })
  const second = await worlds.create({
    ownerSubject: LEE,
    ownerName: 'lee',
    title: 'Second',
    summary: '',
    map,
    now: 4,
  })
  await worlds.update(second.id, { status: 'published' }, 5)

  let now = 1_000_000
  const host = new CreatorWorldHost({
    store: worlds,
    start: createWorldHubStarter({
      db,
      rapier,
      config,
      metrics: new ServerMetrics(),
      log,
      contentFor,
    }),
    log,
    maxRunning: 1,
    idleMs: 60_000,
    now: () => now,
  })
  const router = new PlaceRouter(new Map([['scraplandia', hub]]), 'scraplandia', host)
  const join = (place: string, key: string, digest: string) => {
    const inbox: ServerMessage[] = []
    const closes: string[] = []
    const conn: GameConnection = {
      identity: { guestKeyHash: key.repeat(64) },
      send: (raw) => inbox.push(JSON.parse(raw) as ServerMessage),
      close: (_code, reason) => {
        closes.push(reason)
        router.onDisconnect(conn)
      },
    }
    router.onMessage(conn, {
      t: 'hello',
      v: PROTOCOL_VERSION,
      place,
      contentDigest: digest,
      slot: 0,
      name: key,
      appearance: defaultAppearance(),
    })
    return { conn, inbox, closes }
  }
  try {
    const guest = join(`world:${open.id}`, 'a', contentFor(open.id).digest)
    await until(() => guest.inbox.some((m) => m.t === 'welcome') || guest.closes.length > 0)
    expect(guest.closes).toEqual([])
    // A one-room place sends no room fields; the welcome carries the world's own def set.
    expect(guest.inbox.find((m) => m.t === 'welcome')).toMatchObject({
      contentDigest: contentFor(open.id).digest,
    })
    expect([...host.online()]).toEqual([[open.id, 1]])
    expect(router.activeRooms.map((r) => r.world.content.world.id)).toContain(`creator_${open.id}`)
    expect((await worlds.get(open.id))?.plays).toBe(1)

    // A draft is its owner's: a guest is refused. The cap of one running world refuses the second world.
    const refused = join(`world:${draft.id}`, 'b', contentFor(draft.id).digest)
    const busy = join(`world:${second.id}`, 'c', contentFor(second.id).digest)
    await until(() => refused.closes.length > 0 && busy.closes.length > 0)
    expect(refused.closes).toEqual(['world_unavailable'])
    expect(busy.closes).toEqual(['world_unavailable'])

    // Leaving saves nothing about the character; the world stops once it has been empty long enough.
    guest.conn.close(1000, 'bye')
    await Promise.all(router.activeRooms.map((room) => room.game.drain(5000)))
    expect(await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM characters`)).toEqual({
      n: 0,
    })
    await router.serialize(() => host.sweep())
    expect(host.online().size).toBe(1)
    now += 61_000
    await router.serialize(() => host.sweep())
    expect(host.online().size).toBe(0)
    const instance = await db.one<{ state: string }>(
      sql`SELECT state FROM game_instances WHERE place_id = ${`world:${open.id}`}`,
    )
    expect(instance.state).toBe('stopped')

    // With the slot free the second world starts; unpublishing it closes it.
    const lee = join(`world:${second.id}`, 'd', contentFor(second.id).digest)
    await until(() => lee.inbox.some((m) => m.t === 'welcome'))
    const unpublished = await worlds.update(second.id, { status: 'draft' }, 6)
    await router.serialize(() => host.changed(unpublished, second.id))
    expect(host.online().size).toBe(0)
  } finally {
    await router.shutdown()
  }
})
