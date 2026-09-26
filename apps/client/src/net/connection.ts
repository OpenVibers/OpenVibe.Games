import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type Appearance,
  type ClientMessage,
  type ServerMessage,
} from '@openvibe/protocol'

/** How long the first WebSocket connect may take before the page falls back to waiting for the server. */
export const CONNECT_TIMEOUT_MS = 10_000

/**
 * WebSocket connection to the dedicated server. Message handling is a
 * callback so the network layer stays independent of game/state code.
 */
export class Connection {
  private ws: WebSocket | null = null
  onMessage: ((msg: ServerMessage) => void) | null = null
  onClose: (() => void) | null = null

  async connect(
    url: string,
    token: string,
    name: string,
    appearance: Appearance,
    slot = 0,
    auth?: string,
  ): Promise<void> {
    const ws = new WebSocket(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      // An upgrade sent while the server restarts can wait with no answer (the proxy holds it):
      // give up after CONNECT_TIMEOUT_MS so the page can wait for the server and reload instead.
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* already closing */ }
        reject(new Error('connection timed out'))
      }, CONNECT_TIMEOUT_MS)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')) }
    })
    ws.onmessage = (event) => {
      const msg = decodeServerMessage(String(event.data))
      if (msg) this.onMessage?.(msg)
    }
    ws.onclose = () => this.onClose?.()
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      token,
      slot,
      name,
      appearance,
      ...(auth ? { auth } : {}),
    })
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeClientMessage(msg))
    }
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

/** Persistent anonymous identity (interim auth — see ADR-0004). */
/**
 * Guest identity token: localStorage primary, a long-lived cookie as
 * backup (survives localStorage wipes), and the server additionally maps
 * the token to the client IP — three chances to keep a guest's scrapper.
 */
export function getIdentity(): { token: string; name: string | null } {
  const cookieTok = document.cookie
    .split('; ')
    .find((c) => c.startsWith('hq_token='))
    ?.slice('hq_token='.length)
  let token = localStorage.getItem('openvibe.token') ?? cookieTok ?? null
  if (!token || !/^[a-z0-9]{8,64}$/i.test(token)) {
    token = crypto.randomUUID().replaceAll('-', '').slice(0, 32)
  }
  localStorage.setItem('openvibe.token', token)
  document.cookie = `hq_token=${token}; Path=/; Max-Age=${400 * 86400}; SameSite=Lax`
  return { token, name: localStorage.getItem('openvibe.name') }
}

export function saveName(name: string): void {
  localStorage.setItem('openvibe.name', name)
}

export function gameSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
