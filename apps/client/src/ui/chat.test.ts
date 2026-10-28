// @vitest-environment jsdom
import type { ClientMessage } from '@openvibe/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Connection } from '../net/connection.js'
import { Chat } from './chat.js'
import { ClientState } from '../state/clientState.js'

describe('chat UI', () => {
  let root: HTMLDivElement
  let state: ClientState
  let sent: ClientMessage[]
  let chat: Chat

  beforeEach(() => {
    document.body.replaceChildren()
    root = document.createElement('div')
    document.body.append(root)
    state = new ClientState()
    sent = []
    const connection = {
      send: (msg: ClientMessage) => sent.push(msg),
    } as unknown as Connection
    chat = new Chat(root, connection, state)
  })

  it('does not open before welcome, and sends a say once welcomed', () => {
    const form = root.querySelector('.chat-form') as HTMLFormElement
    const input = root.querySelector('.chat-input') as HTMLInputElement
    let captured: boolean | null = null
    chat.onCaptureChange = (on) => {
      captured = on
    }

    chat.open('say')
    expect(form.hidden).toBe(true)

    state.myEntityId = 'entity-1'
    chat.open('say')
    expect(form.hidden).toBe(false)
    expect(captured).toBe(true)

    input.value = '!top'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(sent).toEqual([{ t: 'say', text: '!top' }])
    expect(form.hidden).toBe(true)
    expect(captured).toBe(false)
  })

  it('sends say_team from the U channel', () => {
    state.myEntityId = 'entity-1'
    chat.open('say_team')
    const form = root.querySelector('.chat-form') as HTMLFormElement
    const input = root.querySelector('.chat-input') as HTMLInputElement
    input.value = 'on my way'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(sent).toEqual([{ t: 'say_team', text: 'on my way' }])
  })

  it('renders untrusted names and text as text, never as markup', () => {
    chat.addLine({
      t: 'say',
      channel: 'say',
      from: '<b>Player</b>',
      fromId: 'e1',
      text: '<img src=x onerror="alert(1)">',
    })
    chat.addLine({
      t: 'say',
      channel: 'system',
      text: '<script>alert(2)</script>',
    })

    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('b')).toBeNull()
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('.chat-from')?.textContent).toBe('<b>Player</b>:')
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(root.textContent).toContain('<script>alert(2)</script>')
    // innerHTML escapes the angle brackets; it never becomes a live element.
    expect(root.querySelector('.chat-lines')?.innerHTML).not.toContain('<img')
  })

  it('keeps the scrollback bounded', () => {
    for (let i = 0; i < 105; i++) {
      chat.addLine({ t: 'say', channel: 'system', text: `line ${i}` })
    }
    expect(root.querySelectorAll('.chat-line')).toHaveLength(100)
    expect(root.querySelector('.chat-line')?.textContent).toBe('line 5')
    expect(root.textContent).toContain('line 104')
  })
})
