/**
 * games.moderation.action (ADR-022): staff taking down or putting back a mod
 * someone else published goes to Network's moderation audit log, from the
 * outbox in the same transaction; the publisher acting on their own mod does
 * not.
 */
import { createRequire } from 'node:module'
import { createContent } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import { createClient } from 'openvibe-sdk/core'
import { sql } from 'openvibe-sdk/db'
import { createEventsClient, createPgOutbox } from 'openvibe-sdk/events'
import { describe, expect, it } from 'vitest'
import { EVENT_SOURCE, outboxSink } from '../platform/gameEvents.js'
import { CAP_PLACE_PROP } from './contentPack.js'
import { ModRegistry, type ModActor } from './registry.js'
import { MOD_ID, sampleManifest } from './testFixtures.js'

interface Contracts {
  validate(ref: string, value: unknown): { valid: boolean; errors: unknown[] }
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as Contracts

const PUBLISHER = sampleManifest().publisher.id
const STAFF_SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ9'
const STAFF: ModActor = { audit: STAFF_SUBJECT, subject: { type: 'user', id: STAFF_SUBJECT } }
const OWNER: ModActor = { audit: PUBLISHER, subject: { type: 'user', id: PUBLISHER } }
const PACK = {
  props: [{ key: 'bench', item: 'workbench', pos: [10, 0, 10] as [number, number, number] }],
}

interface Envelope {
  event_type: string
  source: string
  visibility: string
  actor: unknown
  subject: unknown
  payload: {
    action: string
    target: unknown
    actor_subject: string | null
    reason: string | null
    details: Record<string, unknown>
  }
}

async function setup() {
  const store = await openTestStore()
  const client = createClient({
    baseUrls: { events: 'http://127.0.0.1:9' },
    autoDiscover: false,
    retries: 0,
    getToken: async () => {
      throw new Error('no relay in this test')
    },
  })
  const outbox = createPgOutbox(store.db, {
    events: createEventsClient(client, { source: EVENT_SOURCE }),
  })
  await outbox.ensureSchema()
  const registry = new ModRegistry(store, createContent(), outboxSink(outbox, store.db))
  await registry.install(
    { manifest: sampleManifest(), pack: PACK, approve: [CAP_PLACE_PROP], enable: true },
    STAFF,
  )
  const moderation = async (): Promise<Envelope[]> =>
    (
      await store.db.many<{ envelope: Envelope }>(
        sql`SELECT envelope FROM event_outbox ORDER BY id`,
      )
    )
      .map((r) => r.envelope)
      .filter((e) => e.event_type === 'games.moderation.action')
  return { registry, outbox, moderation }
}

function expectValid(e: Envelope) {
  expect(contracts.validate('events.event-envelope@1', e).errors).toEqual([])
  expect(contracts.validate('games.moderation.action@1', e.payload).errors).toEqual([])
  expect(e.source).toBe('games')
  expect(e.visibility).toBe('internal')
  expect(e.actor).toEqual({ type: 'user', id: STAFF_SUBJECT })
  expect(e.subject).toEqual({ type: 'moderation_action', id: `mod:${MOD_ID}` })
  expect(e.payload.actor_subject).toBe(STAFF_SUBJECT)
  expect(e.payload.target).toEqual({ type: 'mod', id: MOD_ID, owner_subject: PUBLISHER })
}

describe('games.moderation.action', () => {
  it("staff revoking someone else's mod enqueues exactly one valid event", async () => {
    const { registry, outbox, moderation } = await setup()
    await registry.revoke(MOD_ID, STAFF, 'griefing props')
    const ev = await moderation()
    expect(ev).toHaveLength(1)
    expectValid(ev[0]!)
    expect(ev[0]!.payload.action).toBe('mod.revoked')
    expect(ev[0]!.payload.reason).toBe('griefing props')
    expect(ev[0]!.payload.details).toEqual({
      previous: 'enabled',
      revoked_grants: [CAP_PLACE_PROP],
    })
    await registry.revoke(MOD_ID, STAFF, 'again')
    expect(await moderation()).toHaveLength(1)
    void outbox.stop()
  })

  it('a disable, and the enable that puts it back, are one event each; installing is none', async () => {
    const { registry, outbox, moderation } = await setup()
    expect(await moderation()).toHaveLength(0)
    await registry.disable(MOD_ID, STAFF)
    expect((await moderation()).map((e) => e.payload.action)).toEqual(['mod.disabled'])
    await registry.enable(MOD_ID, STAFF)
    const ev = await moderation()
    expect(ev.map((e) => e.payload.action)).toEqual(['mod.disabled', 'mod.enabled'])
    for (const e of ev) expectValid(e)
    void outbox.stop()
  })

  it('the publisher acting on their own mod enqueues none', async () => {
    const { registry, outbox, moderation } = await setup()
    await registry.disable(MOD_ID, OWNER)
    await registry.enable(MOD_ID, OWNER)
    await registry.revoke(MOD_ID, OWNER, 'withdrawn by its author')
    expect(await moderation()).toHaveLength(0)
    void outbox.stop()
  })
})
