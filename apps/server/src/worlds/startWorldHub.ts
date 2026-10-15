import type { ContentRegistry } from '@openvibe/content'
import { InstanceRegistry, openPgStore, type InstanceLease } from '@openvibe/persistence'
import { createRapierWorld, type RapierModule } from '@openvibe/physics/rapier'
import type { Logger } from '@openvibe/shared'
import type { Db } from 'openvibe-sdk/db'
import type { ServerConfig } from '../config.js'
import { GameServer } from '../game/gameServer.js'
import { GameWorld } from '../game/gameWorld.js'
import { InstanceHub } from '../game/instanceHub.js'
import type { ServerMetrics } from '../observability/metrics.js'
import { sandboxStore } from './sandboxStore.js'
import type { StartWorldHub } from './worldHost.js'

export interface WorldHubDeps {
  db: Db
  rapier: RapierModule
  config: ServerConfig
  metrics: ServerMetrics
  log: Logger
  /** The creator pack's def set for a world (the one /api/v1/content?world= reports). */
  contentFor: (worldId: string) => ContentRegistry
}

/**
 * Starts one creator world as a single-room hub: its place row, a lease on slot 0, then a sandboxed room (the
 * world's rows are kept, characters are not; no NPCs, world events, rewards or events). The caller has already set
 * the world's map override. Null when the slot is held elsewhere or the room fails to start.
 */
export function createWorldHubStarter(deps: WorldHubDeps): StartWorldHub {
  const { db, rapier, config, metrics, log } = deps
  return async (world, placeId) => {
    const worldContent = deps.contentFor(world.id)
    const worldRegistry = new InstanceRegistry(db, placeId)
    const worldLog = log.child({ system: 'world', place: placeId })
    const createWorldRoom = async (slot: number, lease: InstanceLease) => {
      const roomStore = sandboxStore(
        openPgStore(db, {
          placeId,
          instanceSlot: slot,
          leaseGuard: () => worldRegistry.assertHeld(lease, Date.now()),
        }),
      )
      await roomStore.ensurePlace(world.title)
      const roomPhysics = createRapierWorld(rapier)
      const roomWorld = new GameWorld(worldContent, roomPhysics, worldLog, config.interestCell)
      await roomWorld.seedOrRestore(roomStore)
      roomWorld.reconcileMapNodes()
      roomWorld.reconcileMapProps()
      const roomGame = new GameServer(
        {
          ...config,
          placeId,
          instanceSlot: slot,
          maxPlayers: config.creatorWorldPlayers,
          sandbox: true,
        },
        roomWorld,
        roomStore,
        metrics,
        log.child({ system: 'game', place: placeId }),
        {},
      )
      await roomGame.load()
      return {
        lease,
        game: roomGame,
        world: roomWorld,
        dispose: async () => {
          roomPhysics.dispose()
        },
      }
    }
    // The places row first: game_instances references it.
    await openPgStore(db, { placeId }).ensurePlace(world.title)
    const claim = await worldRegistry.claim(
      0,
      config.creatorWorldPlayers,
      crypto.randomUUID(),
      Date.now(),
      60_000,
    )
    if (!claim) return null
    let room: Awaited<ReturnType<typeof createWorldRoom>>
    try {
      room = await createWorldRoom(0, claim)
    } catch (err) {
      worldLog.warn('creator world failed to start', { error: String(err) })
      await worldRegistry.stop(claim).catch(() => undefined)
      return null
    }
    const running = await worldRegistry.renew(claim, Date.now(), 15_000, 'running')
    if (!running) {
      await room.dispose()
      return null
    }
    room.lease = running
    return new InstanceHub(
      worldRegistry,
      room,
      1,
      config.creatorWorldPlayers,
      createWorldRoom,
      log.child({ system: 'instances', place: placeId }),
    )
  }
}
