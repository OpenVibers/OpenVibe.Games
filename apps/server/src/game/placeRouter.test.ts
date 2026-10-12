import { createContent, SCRAPLANDIA_PACK } from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import { InstanceRegistry, openPgStore, type InstanceLease } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { PROTOCOL_VERSION, defaultAppearance, type ServerMessage } from '@openvibe/protocol'
import { createConsoleLogger } from '@openvibe/shared'
import { expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { ServerMetrics } from '../observability/metrics.js'
import { GameServer, type GameConnection } from './gameServer.js'
import { GameWorld } from './gameWorld.js'
import { InstanceHub } from './instanceHub.js'
import { PlaceRouter } from './placeRouter.js'

const log = createConsoleLogger({ app: 'place-router-test' }, 'error')

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('join timed out')
}

it('one Games process hosts both places and routes hello to place-specific rooms and gameplay', async () => {
  const db = await openTestDb()
  const rapier = await loadRapier()
  const config = loadConfig({ GAMES_PLACE_ID: 'scraplandia', GAMES_INSTANCES_PER_PLACE: '2' })
  const contents = new Map([
    ['scraplandia', createContent([], SCRAPLANDIA_PACK)],
    ['salvage-rush', createContent([], SALVAGE_RUSH_PACK)],
  ])
  const hubs = new Map<string, InstanceHub>()
  try {
    for (const [placeId, content] of contents) {
      const registry = new InstanceRegistry(db, placeId)
      const bootstrapStore = openPgStore(db, { placeId, instanceSlot: 0 })
      await bootstrapStore.ensurePlace()
      const claimed = await registry.claim(0, 4, `holder-${placeId}`, Date.now(), 30_000)
      if (!claimed) throw new Error('claim failed')
      let lease: InstanceLease = claimed
      const store = openPgStore(db, {
        placeId,
        instanceSlot: 0,
        leaseGuard: () => registry.assertHeld(lease, Date.now()),
      })
      await store.ensurePlace()
      const physics = createRapierWorld(rapier)
      const world = new GameWorld(content, physics, log, config.interestCell)
      await world.seedOrRestore(store)
      const game = new GameServer({ ...config, placeId }, world, store, new ServerMetrics(), log)
      await game.load()
      const running = await registry.renew(lease, Date.now(), 30_000, 'running')
      if (!running) throw new Error('renew failed')
      lease = running
      hubs.set(
        placeId,
        new InstanceHub(
          registry,
          { lease, game, world, dispose: () => physics.dispose() },
          2,
          4,
          async () => {
            throw new Error('unexpected room creation')
          },
          log,
        ),
      )
    }
    const router = new PlaceRouter(hubs, config.placeId)
    const join = (place: string | undefined, key: string) => {
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
        ...(place ? { place } : {}),
        contentDigest: contents.get(router.resolve(place))?.digest,
        slot: 0,
        name: key,
        appearance: defaultAppearance(),
      })
      return { conn, inbox, closes }
    }
    const scrap = join(undefined, 'a')
    const rush = join('salvage-rush', 'b')
    const fallback = join('unknown-place', 'c')
    await until(() =>
      [scrap, rush, fallback].every(({ inbox }) => inbox.some((m) => m.t === 'welcome')),
    )
    expect(scrap.inbox.find((m) => m.t === 'welcome')).toMatchObject({
      instanceId: 'scraplandia:0',
    })
    expect(rush.inbox.find((m) => m.t === 'welcome')).toMatchObject({
      instanceId: 'salvage-rush:0',
    })
    expect(fallback.inbox.find((m) => m.t === 'welcome')).toMatchObject({
      instanceId: 'scraplandia:0',
    })
    expect(rush.inbox.some((m) => m.t === 'salvage_round')).toBe(true)
    expect(scrap.inbox.some((m) => m.t === 'salvage_round')).toBe(false)
    expect(fallback.inbox.some((m) => m.t === 'salvage_round')).toBe(false)
    router.onMessage(scrap.conn, { t: 'transfer', instanceId: 'salvage-rush:0' })
    await until(() => scrap.inbox.some((m) => m.t === 'transfer_result'))
    expect(scrap.inbox.find((m) => m.t === 'transfer_result')).toMatchObject({
      accepted: false,
      reason: 'unknown_instance',
    })
    expect(router.onlineCount).toBe(3)
    expect(router.activeRooms.map((room) => room.lease.id).sort()).toEqual([
      'salvage-rush:0',
      'scraplandia:0',
    ])
    expect(router.activeRooms.map((room) => room.world.content.world.id).sort()).toEqual([
      'openvibeville_v2',
      'salvage_rush_arena',
    ])
    const moved = join('salvage-rush', 'a')
    await until(() => moved.inbox.some((m) => m.t === 'welcome'))
    expect(scrap.closes).toContain('session_superseded')
    expect(router.onlineCount).toBe(3)
    await router.shutdown()
  } finally {
    await db.close()
  }
})
