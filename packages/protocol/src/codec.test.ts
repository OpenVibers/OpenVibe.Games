import { describe, expect, it } from 'vitest'
import { decodeClientMessage, encodeClientMessage } from './codec.js'
import type { ClientMessage } from './messages/client.js'
import { defaultAppearance } from './appearance.js'

describe('protocol codec', () => {
  it('roundtrips every client message kind', () => {
    const messages: ClientMessage[] = [
      // hello carries no identity field: authentication happens at the
      // WebSocket upgrade (ADR-0007 decision 8).
      { t: 'hello', v: 1, slot: 0, name: 'Tester', appearance: defaultAppearance() },
      { t: 'input', seq: 42, moveX: 1, moveZ: -0.5, yawQ: 12345, pitchQ: -4096, intents: 5 },
      { t: 'use', target: 'abc123' },
      { t: 'craft', recipe: 'craft_wooden_crate' },
      { t: 'drop', slot: 3, count: 5 },
      { t: 'inv_move', from: 0, to: 5, count: 3 },
      { t: 'hotbar', slot: 2 },
      { t: 'physgun', a: 'grab' },
      { t: 'physgun', a: 'rotate', dyaw: 0.1, dpitch: -0.1, snap: true },
      { t: 'physgun', a: 'grid', on: true },
    ]
    for (const msg of messages) {
      expect(decodeClientMessage(encodeClientMessage(msg))).toEqual(msg)
    }
  })

  it('rejects malformed payloads', () => {
    expect(decodeClientMessage('not json')).toBeNull()
    expect(decodeClientMessage('{"t":"nope"}')).toBeNull()
    expect(decodeClientMessage('{"t":"input","seq":-1}')).toBeNull()
    // NaN/Infinity smuggling
    expect(
      decodeClientMessage(
        '{"t":"input","seq":1,"moveX":1e999,"moveZ":0,"yawQ":0,"pitchQ":0,"intents":0}',
      ),
    ).toBeNull()
    // out-of-range movement axes (speedhack attempt)
    expect(
      decodeClientMessage(
        '{"t":"input","seq":1,"moveX":5,"moveZ":0,"yawQ":0,"pitchQ":0,"intents":0}',
      ),
    ).toBeNull()
  })

  it('refuses unknown intent bits and out-of-range quantised angles', () => {
    const decodeInput = (fields: string) =>
      decodeClientMessage(`{"t":"input","seq":1,"moveX":0,"moveZ":0,${fields}}`)
    const known = '"yawQ":0,"pitchQ":0,"intents":0'
    // A bit outside intentMask is refused (64 = the first bit past the list).
    expect(decodeInput('"yawQ":0,"pitchQ":0,"intents":64')).toBeNull()
    // Angles outside the int16 / ±90° range are refused.
    expect(decodeInput('"yawQ":32768,"pitchQ":0,"intents":0')).toBeNull()
    expect(decodeInput('"yawQ":0,"pitchQ":16385,"intents":0')).toBeNull()
    // A full known mask and the extreme in-range values are fine.
    expect(decodeInput('"yawQ":-32768,"pitchQ":16384,"intents":63')).not.toBeNull()
    expect(decodeInput(known)).not.toBeNull()
  })

  it('ignores an identity field in hello (the upgrade is the only authn gate)', () => {
    const decoded = decodeClientMessage(
      JSON.stringify({
        t: 'hello',
        v: 1,
        token: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
        slot: 0,
        name: 'Tester',
        appearance: defaultAppearance(),
      }),
    )
    expect(decoded).not.toBeNull()
    // The smuggled account key never becomes part of the message.
    expect(decoded).not.toHaveProperty('token')
  })

  it('rejects oversized strings', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'use', target: 'x'.repeat(100) }))).toBeNull()
  })
})
