import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { accountKey } from './accountKey.js'

describe('accountKey', () => {
  it('passes a canonical subject through unchanged', () => {
    expect(accountKey('usr_01J0000000000000000000000A')).toBe('usr_01J0000000000000000000000A')
    expect(accountKey('gst_01J0000000000000000000000A')).toBe('gst_01J0000000000000000000000A')
  })

  it('hashes a guest token, never storing it', () => {
    const token = 'guestbrowsertoken0123456789abcdef'
    const key = accountKey(token)
    expect(key).toBe(`guest:${createHash('sha256').update(token).digest('hex')}`)
    expect(key).not.toContain(token)
  })

  it('is idempotent: an existing account key passes through', () => {
    const hashed = accountKey('guestbrowsertoken0123456789abcdef')
    expect(accountKey(hashed)).toBe(hashed)
  })
})
