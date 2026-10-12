import { createContent } from '@openvibe/content'
import type { GameEntity } from '@openvibe/gameplay'
import { InstanceRegistry, openPgStore, type InstanceLease } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { PROTOCOL_VERSION, defaultAppearance, type ServerMessage } from '@openvibe/protocol'
import { createConsoleLogger, quat, vec3, type EntityId } from '@openvibe/shared'
import { sql } from 'openvibe-sdk/db'
import { expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { ServerMetrics } from '../observability/metrics.js'
import { GameServer, type GameConnection } from './gameServer.js'
import { GameWorld } from './gameWorld.js'
import { InstanceHub, type InstanceRoom } from './instanceHub.js'

const log = createConsoleLogger({ app: 'instance-test' }, 'error')
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('room operation timed out')
}

it('joins, refuses a full target, transfers with inventory and per-room position, and returns', async () => {
  const db = await openTestDb()
  const config = loadConfig({
    GAMES_PLACE_ID: 'm4-test',
    MAX_PLAYERS: '1',
    GAMES_INSTANCES_PER_PLACE: '2',
  })
  const registry = new InstanceRegistry(db, config.placeId)
  const content = createContent()
  const rapier = await loadRapier()
  const rooms: InstanceRoom[] = []
  const makeRoom = async (slot: number, initial: InstanceLease): Promise<InstanceRoom> => {
    let lease = initial
    const store = openPgStore(db, {
      placeId: config.placeId,
      instanceSlot: slot,
      leaseGuard: () => registry.assertHeld(lease, Date.now()),
    })
    await store.ensurePlace()
    const physics = createRapierWorld(rapier)
    const world = new GameWorld(content, physics, log, config.interestCell)
    await world.seedOrRestore(store)
    for (let i = 0; i < 400; i++) {
      const x = ((i % 20) - 10) * 55
      const z = (Math.floor(i / 20) - 10) * 55
      const id = `probe-${i}` as EntityId
      const entity: GameEntity = {
        id,
        kind: 'prop',
        transform: { pos: vec3(x, 0, z), rot: quat() },
        prop: { defId: 'scrap', motion: 'dynamic', lootCount: 1 },
        persistent: false,
        dirty: false,
      }
      world.entities.add(entity)
      world.spatial.insert(id, x, z)
    }
    const game = new GameServer(
      { ...config, instanceSlot: slot },
      world,
      store,
      new ServerMetrics(),
      log,
    )
    await game.load()
    const running = await registry.renew(lease, Date.now(), 15_000, 'running')
    if (!running) throw new Error('lease expired')
    lease = running
    const room = { lease, game, world, dispose: () => physics.dispose() }
    rooms.push(room)
    return room
  }
  await db.exec(sql`INSERT INTO places (id, name) VALUES (${config.placeId}, 'test')`)
  const claimed = await registry.claim(0, 1, 'test-holder', Date.now(), 15_000)
  if (!claimed) throw new Error('claim failed')
  const primary = await makeRoom(0, claimed)
  const hub = new InstanceHub(registry, primary, 2, 1, makeRoom, log)
  const client = (key: string) => {
    const inbox: ServerMessage[] = []
    const conn: GameConnection = {
      identity: { guestKeyHash: key.repeat(64) },
      send: (raw) => inbox.push(JSON.parse(raw) as ServerMessage),
      close: () => hub.onDisconnect(conn),
    }
    const hello = {
      t: 'hello' as const,
      v: PROTOCOL_VERSION,
      contentDigest: content.digest,
      slot: 0,
      name: key,
      appearance: defaultAppearance(),
    }
    return { conn, inbox, hello }
  }
  const a = client('a')
  const b = client('b')
  b.hello.v = PROTOCOL_VERSION - 1
  hub.onMessage(a.conn, a.hello)
  hub.onMessage(b.conn, b.hello)
  await until(
    () => a.inbox.some((m) => m.t === 'welcome') && b.inbox.some((m) => m.t === 'welcome'),
  )
  expect((a.inbox.find((m) => m.t === 'welcome') as { instanceId?: string }).instanceId).toBe(
    'm4-test:0',
  )
  expect((b.inbox.find((m) => m.t === 'welcome') as { instanceId?: string }).instanceId).toBe(
    'm4-test:1',
  )
  expect((b.inbox.find((m) => m.t === 'welcome') as { v?: number }).v).toBe(PROTOCOL_VERSION - 1)
  expect(hub.onlineCount).toBe(2)
  const initialInventory = a.inbox.find((m) => m.t === 'inventory')
  const startBytes = [a, b].map(({ inbox }) =>
    inbox.reduce((sum, msg) => sum + JSON.stringify(msg).length, 0),
  )
  const tickTimes: number[] = []
  for (let tick = 1; tick <= 90; tick++) {
    for (const client of [a, b])
      hub.onMessage(client.conn, {
        t: 'input',
        seq: tick,
        moveX: 0,
        moveZ: tick % 30 < 15 ? 1 : -1,
        yawQ: 0,
        pitchQ: 0,
        intents: 0,
      })
    const start = performance.now()
    hub.step()
    tickTimes.push(performance.now() - start)
  }
  const bytesPerClient =
    [a, b].reduce(
      (sum, client, i) =>
        sum +
        client.inbox.reduce((bytes, msg) => bytes + JSON.stringify(msg).length, 0) -
        startBytes[i]!,
      0,
    ) / 2
  const meanTickMs = tickTimes.reduce((sum, ms) => sum + ms, 0) / tickTimes.length
  // M3 HEAD baseline: 2 clients, 400 props, 90 ticks: 2.08 ms mean, 52,278 bytes/client.
  // The timing margin absorbs CI CPU/WASM noise; bandwidth has a tighter bound.
  expect(meanTickMs).toBeLessThan(2.08 * 3)
  expect(bytesPerClient).toBeLessThanOrEqual(52_278 * 1.05)

  hub.onMessage(a.conn, { t: 'transfer', instanceId: 'm4-test:1' })
  await until(() => a.inbox.some((m) => m.t === 'transfer_result'))
  expect(a.inbox.at(-1)).toMatchObject({
    t: 'transfer_result',
    accepted: false,
    reason: 'instance_full',
  })
  expect(primary.game.onlineCount()).toBe(1)

  for (let i = 1; i <= 12; i++)
    hub.onMessage(a.conn, {
      t: 'input',
      seq: i,
      moveX: 0,
      moveZ: 1,
      yawQ: 0,
      pitchQ: 0,
      intents: 0,
    })
  await pause()
  for (let i = 0; i < 12; i++) hub.step()
  hub.onDisconnect(b.conn)
  await rooms[1]?.game.drain()
  hub.onMessage(a.conn, { t: 'transfer', instanceId: 'm4-test:1' })
  await until(() => a.inbox.some((m) => m.t === 'transfer_result' && m.accepted))
  expect(a.inbox.filter((m) => m.t === 'welcome')).toHaveLength(2)
  expect(a.inbox.filter((m) => m.t === 'inventory').at(-1)).toEqual(initialInventory)
  const firstPosition = await db.maybe<{ pos_x: number; pos_z: number }>(sql`
    SELECT pos_x, pos_z FROM character_instance_positions WHERE instance_id = 'm4-test:0'
  `)
  expect(firstPosition).not.toBeNull()

  hub.onMessage(a.conn, { t: 'transfer', instanceId: 'm4-test:0' })
  await until(() => a.inbox.filter((m) => m.t === 'transfer_result' && m.accepted).length === 2)
  expect(a.inbox.filter((m) => m.t === 'welcome')).toHaveLength(3)
  const restored = await db.maybe<{ pos_x: number; pos_z: number }>(sql`
    SELECT pos_x, pos_z FROM character_instance_positions WHERE instance_id = 'm4-test:0'
  `)
  expect(restored).toEqual(firstPosition)
  hub.onDisconnect(a.conn)
  expect(await hub.shutdown()).toBe(true)
})
