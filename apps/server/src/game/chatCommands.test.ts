import { describe, expect, it } from 'vitest'
import {
  CHAT_RATE_CAPACITY,
  ChatRateLimiter,
  canonicalChatCommand,
  cleanChatText,
  formatChatTime,
  parseChatCommand,
} from './chatCommands.js'

describe('chat command parser', () => {
  it('treats ordinary text as chat', () => {
    expect(parseChatCommand('hello there')).toEqual({ command: null, args: [], silent: false })
    expect(parseChatCommand('   ')).toEqual({ command: null, args: [], silent: false })
    expect(parseChatCommand('what?')).toEqual({ command: null, args: [], silent: false })
  })

  it('parses Source triggers, lower-cases the command and keeps its arguments', () => {
    expect(parseChatCommand('!r')).toEqual({ command: 'r', args: [], silent: false })
    expect(parseChatCommand('/r')).toEqual({ command: 'r', args: [], silent: true })
    expect(parseChatCommand('  !TOP  ')).toEqual({ command: 'top', args: [], silent: false })
    expect(parseChatCommand('!stage 2')).toEqual({
      command: 'stage',
      args: ['2'],
      silent: false,
    })
    expect(parseChatCommand('/stage   3  extra')).toEqual({
      command: 'stage',
      args: ['3', 'extra'],
      silent: true,
    })
  })

  it('caps the argument list and handles a bare trigger', () => {
    expect(parseChatCommand('!stage 1 2 3 4 5 6 7 8 9 10').args).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ])
    expect(parseChatCommand('!')).toEqual({ command: '', args: [], silent: false })
    expect(parseChatCommand('/')).toEqual({ command: '', args: [], silent: true })
  })

  it('maps Source aliases to one canonical command', () => {
    expect(canonicalChatCommand('r')).toBe('r')
    expect(canonicalChatCommand('restart')).toBe('r')
    expect(canonicalChatCommand('stages')).toBe('stage')
    expect(canonicalChatCommand('bonus')).toBe('b')
    expect(canonicalChatCommand('p')).toBe('practice')
    expect(canonicalChatCommand('h')).toBe('help')
    expect(canonicalChatCommand('nope')).toBeNull()
  })
})

describe('chat text and time formatting', () => {
  it('strips control characters, trims and clamps to the wire limit', () => {
    expect(cleanChatText('  hi\u0000there\u001b[31m  ')).toBe('hi there [31m')
    expect(cleanChatText('x'.repeat(500))).toHaveLength(240)
    expect(cleanChatText(' \n\t ')).toBe('')
  })

  it('prints the surf timer format', () => {
    expect(formatChatTime(0)).toBe('0:00.000')
    expect(formatChatTime(12_345)).toBe('0:12.345')
    expect(formatChatTime(61_005)).toBe('1:01.005')
  })
})

describe('chat rate limit', () => {
  it('allows a five-line burst and refills at two per second', () => {
    let now = 1_000
    const limiter = new ChatRateLimiter(CHAT_RATE_CAPACITY, 2, () => now)
    for (let i = 0; i < CHAT_RATE_CAPACITY; i++) expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    // 500 ms buys one token back, not five.
    now += 500
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    // A different player has their own bucket.
    expect(limiter.allow('b')).toBe(true)
  })

  it('forgets a player on leave', () => {
    const now = 0
    const limiter = new ChatRateLimiter(1, 1, () => now)
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    limiter.forget('a')
    expect(limiter.allow('a')).toBe(true)
  })
})
