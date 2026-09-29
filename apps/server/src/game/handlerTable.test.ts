/**
 * The message handler table (ADR-0007 M1). The split moved 27 dispatch cases out of one switch and
 * into the systems; these tests are what stops that table from rotting:
 *
 *  - a duplicate message type is a startup error, not a silent shadowing;
 *  - every client message the protocol defines has exactly one handler.
 *
 * The GameServer is constructed with stub world/store objects: nothing here ticks or sends, so
 * nothing may dereference them.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContent } from '@openvibe/content'
import type { PersistenceStore } from '@openvibe/persistence'
import { ClientMessageSchema } from '@openvibe/protocol'
import { createConsoleLogger } from '@openvibe/shared'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { ServerMetrics } from '../observability/metrics.js'
import { GameServer } from './gameServer.js'
import type { GameWorld } from './gameWorld.js'
import { buildHandlerTable, type System } from './systems/index.js'

const dir = mkdtempSync(join(tmpdir(), 'openvibe-handlers-'))
const config = loadConfig({ MAP_PATH: join(dir, 'map.json') })
const log = createConsoleLogger({ app: 'test' }, 'error')

/**
 * Every message type the protocol's closed client union defines. The union nests — `physgun` is
 * itself a discriminated union of six actions — so walk `options` recursively and read the `t`
 * literal off each leaf object.
 */
function walkMessageTypes(schema: unknown): string[] {
  const options = (schema as { options?: readonly unknown[] }).options
  if (options) return options.flatMap(walkMessageTypes)
  const shape = (schema as { shape?: Record<string, unknown> }).shape
  const literal = shape?.t as { value?: unknown } | undefined
  return typeof literal?.value === 'string' ? [literal.value] : []
}

/** The distinct message types — the six physgun actions are one type. */
function protocolMessageTypes(schema: unknown): string[] {
  return [...new Set(walkMessageTypes(schema))]
}

describe('the message handler table', () => {
  it('rejects two systems claiming the same message type', () => {
    const first: System = { name: 'first', handlers: { use: () => {} } }
    const second: System = { name: 'second', handlers: { use: () => {} } }
    expect(() => buildHandlerTable([first, second])).toThrow(
      'duplicate message handler for "use" (second)',
    )
  })

  it('accepts systems that each claim distinct types', () => {
    const first: System = { name: 'first', handlers: { use: () => {} } }
    const second: System = { name: 'second', handlers: { attack: () => {} } }
    expect([...buildHandlerTable([first, second]).keys()]).toEqual(['use', 'attack'])
  })

  it('has exactly one handler for every message type the protocol defines', () => {
    // Constructing the real server also proves its own table has no duplicate type.
    const game = new GameServer(
      config,
      { content: createContent() } as unknown as GameWorld,
      {} as PersistenceStore,
      new ServerMetrics(),
      log,
    )
    const handled = game.messageTypes
    const defined = protocolMessageTypes(ClientMessageSchema)
    expect(defined.length).toBeGreaterThan(0)
    for (const type of defined) {
      expect(
        handled.filter((t) => t === type),
        `handlers for "${type}"`,
      ).toHaveLength(1)
    }
    // …and that no handler is left over for a type the protocol does not have.
    expect([...handled].sort()).toEqual([...defined].sort())
  })
})
