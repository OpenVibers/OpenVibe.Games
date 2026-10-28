import { CHAT_MAX_LENGTH, type ServerMessage } from '@openvibe/protocol'
import type { Connection } from '../net/connection.js'
import type { ClientState } from '../state/clientState.js'
import './chat.css'

type ChatLine = Extract<ServerMessage, { t: 'say' }>
type ChatMode = 'say' | 'say_team'

const MAX_LINES = 100

/**
 * Source-style chat: lower-left scrollback plus a one-line input opened with
 * Y (say) or U (team). The server is authoritative for delivery and rate
 * limits; this class only renders plain text and sends the typed line.
 *
 * Every piece of remote text goes through `textContent`. Never innerHTML:
 * names and chat messages are untrusted.
 */
export class Chat {
  readonly root: HTMLElement
  private readonly lines: HTMLOListElement
  private readonly form: HTMLFormElement
  private readonly input: HTMLInputElement
  private readonly channelLabel: HTMLSpanElement
  private mode: ChatMode = 'say'
  private isOpen = false

  /** The HUD's existing capture switch: typing must not move the player. */
  onCaptureChange: ((captured: boolean) => void) | null = null

  constructor(
    parent: HTMLElement,
    private readonly connection: Connection,
    private readonly state: ClientState,
  ) {
    this.root = document.createElement('section')
    this.root.className = 'chat'
    this.root.setAttribute('aria-label', 'Chat')

    this.lines = document.createElement('ol')
    this.lines.className = 'chat-lines'
    this.lines.setAttribute('role', 'log')
    this.lines.setAttribute('aria-live', 'polite')
    this.lines.setAttribute('aria-relevant', 'additions')

    this.form = document.createElement('form')
    this.form.className = 'chat-form'
    this.form.hidden = true
    this.channelLabel = document.createElement('span')
    this.channelLabel.className = 'chat-channel'
    this.channelLabel.textContent = 'Say'
    this.input = document.createElement('input')
    this.input.className = 'chat-input'
    this.input.type = 'text'
    this.input.maxLength = CHAT_MAX_LENGTH
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.setAttribute('aria-label', 'Chat message')
    this.input.placeholder = 'Message…'
    this.form.append(this.channelLabel, this.input)

    this.root.append(this.lines, this.form)
    parent.append(this.root)

    this.form.addEventListener('submit', (event) => {
      event.preventDefault()
      this.submit()
    })
    this.input.addEventListener('keydown', (event) => {
      // The game's global key handlers ignore inputs already; stop here too so
      // Enter/Escape never reach a game action.
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        this.close()
      }
    })

    state.events.on('chat', (line) => this.addLine(line))
  }

  /** Open the input for a channel. Ignored until the server has welcomed us. */
  open(mode: ChatMode): void {
    if (!this.state.myEntityId) return
    this.mode = mode
    this.channelLabel.textContent = mode === 'say' ? 'Say' : 'Team'
    if (this.isOpen) return
    this.isOpen = true
    this.form.hidden = false
    this.root.classList.add('is-open')
    this.onCaptureChange?.(true)
    this.input.focus()
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.form.hidden = true
    this.root.classList.remove('is-open')
    this.input.blur()
    this.onCaptureChange?.(false)
  }

  /** Append one server line (conversation or command reply). */
  addLine(line: ChatLine): void {
    const item = document.createElement('li')
    item.className = `chat-line chat-${line.channel}`
    if (line.from) {
      const from = document.createElement('span')
      from.className = 'chat-from'
      from.textContent = line.channel === 'say_team' ? `(TEAM) ${line.from}:` : `${line.from}:`
      item.append(from)
    }
    const text = document.createElement('span')
    text.className = 'chat-text'
    text.textContent = line.text
    item.append(text)

    this.lines.append(item)
    while (this.lines.childElementCount > MAX_LINES) this.lines.firstElementChild?.remove()
    this.lines.scrollTop = this.lines.scrollHeight
  }

  private submit(): void {
    const text = this.input.value.trim()
    this.input.value = ''
    if (!text) {
      this.close()
      return
    }
    // The state guard is belt-and-braces: the server drops anything before
    // `welcome` anyway.
    if (this.state.myEntityId) {
      this.connection.send(this.mode === 'say' ? { t: 'say', text } : { t: 'say_team', text })
    }
    this.close()
  }
}
