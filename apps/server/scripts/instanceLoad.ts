/** Socketless M4 load probe. Run: pnpm exec tsx apps/server/scripts/instanceLoad.ts [--baseline] [N]. */
import { performance } from 'node:perf_hooks'
import { createContent } from '@openvibe/content'
import { openPgStore } from '@openvibe/persistence'
import { openTestDb } from '@openvibe/persistence/testing'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { PROTOCOL_VERSION, defaultAppearance, type ServerMessage } from '@openvibe/protocol'
import { createConsoleLogger, quat, vec3, type EntityId } from '@openvibe/shared'
import { loadConfig } from '../src/config.js'
import { GameServer, type GameConnection } from '../src/game/gameServer.js'
import { GameWorld } from '../src/game/gameWorld.js'
import { ServerMetrics } from '../src/observability/metrics.js'
import type { GameEntity } from '@openvibe/gameplay'

const baseline = process.argv.includes('--baseline')
const n = Number(process.argv.find((arg) => /^[0-9]+$/.test(arg)) ?? '4')
if (!Number.isInteger(n) || n < 2 || n > 64) throw new Error('N must be 2..64')
const log = createConsoleLogger({ app: 'instance-load' }, 'error')
const db = await openTestDb()
const content = createContent()
const rapier = await loadRapier()
const config = loadConfig({
  GAMES_PLACE_ID: 'load-probe',
  MAX_PLAYERS: String(n),
  GAMES_INSTANCES_PER_PLACE: baseline ? '1' : '2',
})
const props = 400

function populate(world: GameWorld): void {
  for (let i = 0; i < props; i++) {
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
}

async function room(slot: number) {
  const store = openPgStore(db, {
    placeId: config.placeId,
    ...(baseline ? {} : { instanceSlot: slot }),
  })
  await store.ensurePlace()
  const physics = createRapierWorld(rapier)
  const world = new GameWorld(content, physics, log, 16)
  await world.seedOrRestore(store)
  populate(world)
  const game = new GameServer(
    { ...config, instanceSlot: slot },
    world,
    store,
    new ServerMetrics(),
    log,
  )
  await game.load()
  return { game, world, physics }
}

const primary = await room(0)
const inboxes: ServerMessage[][] = []
const conns: GameConnection[] = []
const hellos = []
let router: Pick<GameServer, 'onMessage' | 'onDisconnect'> & { step(): void }
let afterRoom: Awaited<ReturnType<typeof room>> | null = null
if (baseline) {
  router = primary.game
} else {
  // Dynamic import keeps this script runnable against the M3 tree for the baseline.
  const { InstanceHub } = await import('../src/game/instanceHub.js')
  const { InstanceRegistry } =
    await import('../../../packages/persistence/src/pg/instanceRegistry.js')
  const registry = new InstanceRegistry(db, config.placeId)
  const first = await registry.claim(0, n, 'load-primary', Date.now(), 60_000)
  if (!first) throw new Error('claim failed')
  const running = await registry.renew(first, Date.now(), 60_000, 'running')
  if (!running) throw new Error('renew failed')
  const hub = new InstanceHub(
    registry,
    { lease: running, ...primary, dispose: () => primary.physics.dispose() },
    2,
    n,
    async (slot, lease) => {
      afterRoom = await room(slot)
      return { lease, ...afterRoom, dispose: () => afterRoom?.physics.dispose() }
    },
    log,
  )
  router = hub
}

for (let i = 0; i < n; i++) {
  const inbox: ServerMessage[] = []
  const conn: GameConnection = {
    identity: { guestKeyHash: i.toString(16).padStart(64, '0') },
    send: (raw) => {
      inbox.push(JSON.parse(raw) as ServerMessage)
    },
    close: () => router.onDisconnect(conn),
  }
  inboxes.push(inbox)
  conns.push(conn)
  const hello = {
    t: 'hello' as const,
    v: PROTOCOL_VERSION,
    contentDigest: content.digest,
    slot: 0,
    name: `probe-${i}`,
    appearance: defaultAppearance(),
  }
  hellos.push(hello)
  router.onMessage(conn, hello)
}
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('load probe timed out')
}
await until(() => inboxes.every((inbox) => inbox.some((m) => m.t === 'welcome')))

const bytesBefore = inboxes.map((inbox) =>
  inbox.reduce((sum, msg) => sum + JSON.stringify(msg).length, 0),
)
const tickMs: number[] = []
for (let tick = 1; tick <= 90; tick++) {
  for (let i = 0; i < n; i++)
    router.onMessage(conns[i]!, {
      t: 'input',
      seq: tick,
      moveX: 0,
      moveZ: tick % 30 < 15 ? 1 : -1,
      yawQ: 0,
      pitchQ: 0,
      intents: 0,
    })
  await Promise.resolve()
  const start = performance.now()
  router.step()
  tickMs.push(performance.now() - start)
}
const bytesAfter = inboxes.map((inbox) =>
  inbox.reduce((sum, msg) => sum + JSON.stringify(msg).length, 0),
)
const bytesPerClient = bytesAfter.reduce((sum, bytes, i) => sum + bytes - bytesBefore[i]!, 0) / n
const sorted = [...tickMs].sort((a, b) => a - b)
let transferred = false
if (!baseline) {
  router.onMessage(conns[0]!, { t: 'transfer', instanceId: 'load-probe:1' })
  await until(() => inboxes[0]!.some((m) => m.t === 'transfer_result' && m.accepted))
  router.onMessage(conns[0]!, { t: 'transfer', instanceId: 'load-probe:0' })
  await until(() => inboxes[0]!.filter((m) => m.t === 'transfer_result' && m.accepted).length === 2)
  transferred = true
}
for (const conn of conns) router.onDisconnect(conn)
await primary.game.drain()
await afterRoom?.game.drain()
primary.physics.dispose()
afterRoom?.physics.dispose()
console.log(
  JSON.stringify(
    {
      mode: baseline ? 'M3 baseline' : 'M4',
      clients: n,
      entitiesPerRoom: props,
      ticks: tickMs.length,
      meanTickMs: tickMs.reduce((a, b) => a + b, 0) / tickMs.length,
      p95TickMs: sorted[Math.floor(sorted.length * 0.95)],
      bytesPerClient,
      transferred,
    },
    null,
    2,
  ),
)
