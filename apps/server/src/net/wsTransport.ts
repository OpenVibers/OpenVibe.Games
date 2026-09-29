import type { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { decodeClientMessage } from '@openvibe/protocol'
import type { Logger } from '@openvibe/shared'
import type { GameConnection, GameServer } from '../game/gameServer.js'
import { type ResolvedTicket, type WsTicketStore } from './wsTicket.js'
import { type GamesActorLimits } from './actorLimits.js'
import { resolveClientAddress } from './clientAddress.js'

/**
 * WebSocket transport binding. Enforces wire-level limits (message size,
 * rate) before anything reaches game code; malformed or abusive traffic
 * drops the connection.
 *
 * The upgrade itself authenticates (ADR-0007 decision 8 / "Deleted"):
 * /ws?ticket=… is validated-and-consumed BEFORE accept, so the session
 * that opens already knows its identity. `hello` carries slot, client
 * version and appearance only.
 */

const MAX_MESSAGE_BYTES = 4096
const MAX_MESSAGES_PER_SECOND = 120

/**
 * Per-upgrade identity note: the WebSocketServer itself does not pass us the
 * `req` we stamped on the underlying socket, so we keep a one-shot map from
 * the socket to its resolved ticket. The entry is removed the moment the
 * connection handler reads it.
 *
 * The "socket" we key on is whatever opaque object the upgrade handler
 * gave us (a Duplex in node's typings). On `connection`, req.socket is
 * the same underlying TCP socket; passing that object back in hits the
 * same WeakMap entry.
 */
const pendingIdentities = new WeakMap<object, ResolvedTicket>()

/** The stream the upgrade handler hands us: a Duplex with write + destroy. */
type UpgradeStream = Duplex

export interface WsTransportOptions {
  /** Resolves-and-consumes the upgrade ticket. */
  tickets: WsTicketStore
  /** Per-address upgrade rate limit; an address past its limit is 429. */
  upgradeLimits: GamesActorLimits
  /** The address a rate limit is keyed on (trusted-proxy aware); socket when absent. */
  clientAddress?: (req: IncomingMessage) => string
  log: Logger
}

/**
 * Validates the ticket for an incoming upgrade, consumes it, and stores the
 * resolved identity against the underlying socket. Returns true when the
 * upgrade may proceed; false writes an HTTP error response itself.
 *
 * Must run BEFORE wss.handleUpgrade, and main.ts calls it from the http
 * upgrade handler.
 */
export async function acceptUpgrade(
  tickets: WsTicketStore,
  upgradeLimits: GamesActorLimits,
  log: Logger,
  req: IncomingMessage,
  socket: UpgradeStream,
  /** Trusted-proxy-aware address resolver; the socket address by default. */
  clientAddress?: (req: IncomingMessage) => string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x')
  const ticket = url.searchParams.get('ticket')
  // Forwarded headers are honoured only through a configured trusted proxy;
  // without one this is the TCP peer, so X-Forwarded-For cannot be spoofed
  // to get a fresh rate-limit bucket.
  const remote = (clientAddress ?? ((r: IncomingMessage) => resolveClientAddress(r, null)))(req)
  // Per-address upgrade flood control FIRST, before a ticket is spent. The
  // limits helper writes its own 429 into the (throwaway) response object
  // when it refuses; we translate that into the raw HTTP 429 the socket
  // needs.
  const fakeRes = {
    writeHead: () => undefined,
    setHeader: () => undefined,
    end() {
      ;(fakeRes as { writableEnded: boolean }).writableEnded = true
    },
    writableEnded: false,
    headersSent: false,
  } as never
  const allowed = await upgradeLimits.upgrade(req, fakeRes, `ip:${remote}`)
  if (!allowed) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    socket.destroy()
    log.warn('ws upgrade refused: rate limit', { remote })
    return false
  }
  if (!ticket) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    socket.destroy()
    log.warn('ws upgrade refused: no ticket', { remote })
    return false
  }
  let resolved: ResolvedTicket | null
  try {
    resolved = await tickets.consume(ticket)
  } catch (err: unknown) {
    // The ticket store (Valkey) is unavailable: fail closed, never accept an
    // unverified upgrade. 503 so the client retries instead of re-authing.
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    )
    socket.destroy()
    log.warn('ws upgrade refused: ticket store error', {
      remote,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
  if (!resolved) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    socket.destroy()
    log.warn('ws upgrade refused: ticket invalid or consumed', { remote })
    return false
  }
  // Stamp the identity on the underlying TCP socket so the connection
  // handler can read it via req.socket.
  pendingIdentities.set(req.socket as object, resolved)
  return true
}

export function attachWebSocket(
  http: Server,
  game: GameServer,
  opts: WsTransportOptions,
): WebSocketServer {
  const { log } = opts
  // noServer: upgrades are routed by path in main (two WSS instances bound
  // to one http server both complete the handshake and corrupt frames).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  void http

  wss.on('connection', (ws: WebSocket, req) => {
    // Real client IP for logs, resolved the same trusted-proxy-aware way as
    // the upgrade rate limit (socket address unless TRUST_PROXY says we sit
    // behind a configured proxy).
    const remote = (opts.clientAddress ?? ((r: IncomingMessage) => resolveClientAddress(r, null)))(
      req,
    )
    let msgCount = 0
    let windowStart = Date.now()

    // Recover the identity the upgrade handler stamped on the socket. This
    // is the one place the WS connection knows who opened it; nothing
    // beyond uses msg.auth.
    const identity = pendingIdentities.get(req.socket as object) ?? null
    pendingIdentities.delete(req.socket as object)

    const conn: GameConnection = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      close: (code, reason) => ws.close(code, reason),
      ...(identity ? { identity: identity.identity } : {}),
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4005, 'text_only')
        return
      }
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        msgCount = 0
      }
      if (++msgCount > MAX_MESSAGES_PER_SECOND) {
        log.warn('rate limit exceeded', { remote })
        ws.close(4006, 'rate_limit')
        return
      }
      const msg = decodeClientMessage(data.toString())
      if (!msg) {
        // A schema-invalid first message is almost always a version-skewed
        // or corrupted hello — tell the client so it can recover instead
        // of freezing on a silent close, and log enough to diagnose.
        let kind = 'unparseable'
        try {
          kind = String((JSON.parse(data.toString()) as { t?: string }).t ?? 'missing-t')
        } catch {
          /* not JSON */
        }
        log.warn('malformed message', { remote, kind, bytes: data.toString().length })
        ws.send(JSON.stringify({ t: 'reject', reason: 'invalid_hello' }))
        ws.close(4007, 'malformed')
        return
      }
      game.onMessage(conn, msg)
    })

    ws.on('close', () => game.onDisconnect(conn))
    ws.on('error', (err) => {
      log.warn('ws error', { remote, error: String(err) })
    })
  })

  return wss
}
