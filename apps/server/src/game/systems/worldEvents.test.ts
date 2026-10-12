import { createContent } from '@openvibe/content'
import { Inventory, SkillSet } from '@openvibe/gameplay'
import { defaultAppearance, type ServerMessage } from '@openvibe/protocol'
import { newEntityId, newPlayerId } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { createSession, type PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import { WorldEventSystem } from './worldEvents.js'

const content = createContent()

function makeSession(token: string, withLoot = true): PlayerSession {
  const inventory = new Inventory(6, 2, content)
  if (withLoot) {
    inventory.addStack({ defId: 'salvage_core', count: 2 }) // 40 points
    inventory.addStack({ defId: 'pepper_tonic', count: 3 }) // 90 points
    inventory.addStack({ defId: 'wood_plank', count: 5 }) // non-valuable
  }
  return createSession({
    playerId: newPlayerId(),
    entityId: newEntityId(),
    token,
    subjectId: null,
    name: 'Scrapper',
    spawn: { x: 0, y: 1.2, z: 4 },
    yaw: 0,
    inventory,
    skills: new SkillSet(content),
    friends: new Set(),
    appearance: defaultAppearance(),
    content,
    send: () => {},
    closeConnection: () => {},
  })
}

function makeSystem(
  session: PlayerSession,
  onHaul: (key: string, extractionId: string, name: string, score: number) => void,
): { system: WorldEventSystem; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ctx = {
    world: { content },
    config: { eventIntervalScale: 1, tickRate: 30 },
    sessions: {
      getByEntity: () => session,
      values: () => [],
    },
    net: {
      send: (_s: PlayerSession, msg: ServerMessage) => {
        sent.push(msg)
      },
      sendInventory: () => {},
      broadcastAll: () => {},
      broadcastSpawn: () => {},
      broadcastDespawn: () => {},
    },
    log: {
      child: () => ({ info: () => {} }),
      info: () => {},
    },
    integrations: { haulExtracted: onHaul },
  } as unknown as ServerContext
  return { system: new WorldEventSystem(ctx), sent }
}

describe('extraction scoring', () => {
  it('scores a haul from the extraction path and recalls the player', () => {
    const session = makeSession('guest-token-1')
    session.move.pos.x = 60
    session.move.pos.z = 40
    let haul: { key: string; extractionId: string; name: string; score: number } | null = null
    const { system, sent } = makeSystem(session, (key, extractionId, name, score) => {
      haul = { key, extractionId, name, score }
    })
    system.extractPlayer(session.entityId, 'evt-1')
    expect(haul).toEqual({
      key: 'guest-token-1',
      extractionId: 'evt-1',
      name: 'Scrapper',
      score: 130,
    })
    expect(session.move.pos.x).toBe(0)
    expect(session.move.pos.y).toBe(1.2)
    expect(session.move.pos.z).toBe(4)
    expect(sent.find((m) => m.t === 'announce')).toMatchObject({
      t: 'announce',
      text: '🚁 Extracted! 2 stacks secured · 130 haul points.',
    })
  })

  it('does not record a zero-value extraction', () => {
    const session = makeSession('guest-token-2', false)
    let called = false
    const { system, sent } = makeSystem(session, () => {
      called = true
    })
    system.extractPlayer(session.entityId, 'evt-2')
    expect(called).toBe(false)
    expect(sent.find((m) => m.t === 'announce')).toMatchObject({
      t: 'announce',
      text: '🚁 Extracted safely back to Scrap City.',
    })
  })
})
