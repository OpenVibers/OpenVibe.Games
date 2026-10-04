import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type Appearance,
  type ClientHello,
  type ClientMessage,
  type ServerMessage,
  type ServerWelcome,
} from '@openvibe/protocol'

/** A stale server welcome must never start prediction with different definitions. */
export function welcomeContentMismatch(
  msg: ServerWelcome,
  clientDigest: string,
): ServerMessage | null {
  return msg.contentDigest === clientDigest
    ? null
    : { t: 'reject', reason: 'content_mismatch', clientDigest, serverDigest: msg.contentDigest }
}

/** Build the versioned hello from the same content registry used for rendering. */
export function helloForContent(
  name: string,
  appearance: Appearance,
  slot: number,
  contentDigest: string,
): ClientHello {
  return { t: 'hello', v: PROTOCOL_VERSION, contentDigest, slot, name, appearance }
}

/** How long the first WebSocket connect may take before the page falls back to waiting for the server. */
export const CONNECT_TIMEOUT_MS = 10_000

/** A single-use, 30 s WebSocket ticket. */
export interface WsTicket {
  ticket: string
  expiresAt: number
}

/**
 * One call to the games server's POST /api/ws-ticket. The server resolves
 * identity from the bearer token (a Network access token, the same ovg_sso
 * cookie the rest of the page sends) OR from the raw guest token and returns
 * a ticket bound to that identity. The browser then opens /ws?ticket=… and
 * the upgrade handler validates-and-consumes before accepting the socket.
 *
 * The raw guest token travels in the X-Guest-Token HEADER, never the query
 * string: it is a long-lived credential and must not land in proxy or access
 * logs, the Referer header or browser history. (The ticket itself is fine in
 * /ws?ticket= — it is single-use and lasts 30 s.)
 *
 * Identity is NEVER taken from `hello`; the upgrade is the only authn gate.
 */
export async function fetchWsTicket(args: {
  guestToken?: string
  networkToken?: string
  signal?: AbortSignal
}): Promise<WsTicket> {
  // A signed-in caller presents the bearer; the guest token header is the
  // identity for a guest and the character-adoption hint for a signed-in one.
  const headers: Record<string, string> = {}
  if (args.networkToken) headers.authorization = `Bearer ${args.networkToken}`
  if (args.guestToken) headers['x-guest-token'] = args.guestToken
  const resp = await fetch('/api/ws-ticket', {
    method: 'POST',
    headers,
    signal: args.signal ?? null,
  })
  if (!resp.ok) {
    throw new Error(`ws-ticket failed: ${resp.status}`)
  }
  return (await resp.json()) as WsTicket
}

/**
 * WebSocket connection to the dedicated server. Message handling is a
 * callback so the network layer stays independent of game/state code.
 *
 * The socket is preceded by a successful /api/ws-ticket call: the server
 * has already resolved and bound the identity, so `hello` only carries
 * non-identity fields (slot, client version, appearance).
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
    contentDigest: string,
    slot = 0,
    /** Network access token; ignored if absent (the identity is the ticket). */
    networkToken?: string,
  ): Promise<void> {
    const ticket = await fetchWsTicket({
      ...(networkToken ? { networkToken } : {}),
      guestToken: token,
    })
    const sep = url.includes('?') ? '&' : '?'
    const ws = new WebSocket(`${url}${sep}ticket=${encodeURIComponent(ticket.ticket)}`)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      // An upgrade sent while the server restarts can wait with no answer (the proxy holds it):
      // give up after CONNECT_TIMEOUT_MS so the page can wait for the server and reload instead.
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        reject(new Error('connection timed out'))
      }, CONNECT_TIMEOUT_MS)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('connection failed'))
      }
    })
    ws.onmessage = (event) => {
      const msg = decodeServerMessage(String(event.data))
      if (!msg) return
      if (msg.t === 'welcome') {
        const mismatch = welcomeContentMismatch(msg, contentDigest)
        if (mismatch) {
          this.onMessage?.(mismatch)
          ws.close()
          return
        }
      }
      this.onMessage?.(msg)
    }
    ws.onclose = () => this.onClose?.()
    // Identity was resolved at the upgrade; hello carries no identity field.
    this.send(helloForContent(name, appearance, slot, contentDigest))
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
 * Guest identity token: localStorage primary, a long-lived cookie as backup
 * (survives localStorage wipes).
 */
export function getIdentity(): { token: string; name: string | null } {
  const cookieTok = document.cookie
    .split('; ')
    .find((c) => c.startsWith('openvibe.token='))
    ?.slice('openvibe.token='.length)
  let token = localStorage.getItem('openvibe.token') ?? cookieTok ?? null
  if (!token || !/^[a-z0-9]{8,64}$/i.test(token)) {
    token = crypto.randomUUID().replaceAll('-', '').slice(0, 32)
  }
  localStorage.setItem('openvibe.token', token)
  document.cookie = `openvibe.token=${token}; Path=/; Max-Age=${400 * 86400}; SameSite=Lax`
  return { token, name: localStorage.getItem('openvibe.name') }
}

export function saveName(name: string): void {
  localStorage.setItem('openvibe.name', name)
}

export function gameSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
