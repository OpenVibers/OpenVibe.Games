import { describe, expect, it } from 'vitest'
import { isGuestToken } from './accounts.js'

const SUBJECT = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0'

describe('guest tokens (hostile input)', () => {
  it('accepts what the client mints', () => {
    expect(isGuestToken('a1B2c3D4')).toBe(true)
    expect(isGuestToken('0123456789abcdef0123456789abcdef')).toBe(true)
    // Older clients and the slice test use `_`/`-`; still fine.
    expect(isGuestToken('token_aaaaaaaaaaaa')).toBe(true)
    expect(isGuestToken('guest-1234-abcd')).toBe(true)
  })

  it('refuses anything shaped like an account key or out of range', () => {
    for (const bad of [
      SUBJECT,
      'gst_01JABCDEFGHJKMNPQRSTVWXYZ0',
      'short',
      'x'.repeat(65),
      'has space1',
      'usr_whatever123',
      'GST_01JABCDEFGHJKMNPQRSTVWXYZ0',
      '',
      null,
      42,
    ]) {
      expect(isGuestToken(bad), String(bad)).toBe(false)
    }
  })
})
