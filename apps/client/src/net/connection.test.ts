import { describe, expect, it } from 'vitest'
import { createContent } from '@openvibe/content'
import type { ServerWelcome } from '@openvibe/protocol'
import { defaultAppearance, PROTOCOL_VERSION } from '@openvibe/protocol'
import { helloForContent, welcomeContentMismatch } from './connection.js'

describe('client content handshake', () => {
  const digest = createContent().digest
  const welcome = { t: 'welcome', contentDigest: digest } as ServerWelcome

  it('accepts the matching loaded definition set', () => {
    expect(welcomeContentMismatch(welcome, digest)).toBeNull()
  })

  it('sends the local definition digest and protocol version in hello', () => {
    expect(helloForContent('Player', defaultAppearance(), 0, digest)).toMatchObject({
      t: 'hello', v: PROTOCOL_VERSION, contentDigest: digest,
    })
  })

  it('turns a mismatched welcome into a typed reject before state applies', () => {
    expect(welcomeContentMismatch({ ...welcome, contentDigest: 'v2-00000000' }, digest)).toEqual({
      t: 'reject', reason: 'content_mismatch',
      clientDigest: digest, serverDigest: 'v2-00000000',
    })
  })
})
