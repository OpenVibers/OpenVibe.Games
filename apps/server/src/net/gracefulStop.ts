import type { Server, ServerResponse } from 'node:http'
import type { WebSocketServer } from 'ws'

/**
 * Graceful stop (roadmap WS-P lifecycle; openvibe-contracts manifests/services/games.json →
 * lifecycle.shutdown). main.ts runs the order; these are the network halves of it.
 *
 * The unit's TimeoutStopSec is 30: the whole stop is bounded by DEADLINE_MS (the manifest's
 * deadlineSeconds), well inside it. Requests in flight get DRAIN_MS; sockets that do not answer the
 * close handshake within SOCKETS_MS are terminated.
 */
export const DEADLINE_MS = 10_000
export const DRAIN_MS = 5_000
export const SOCKETS_MS = 3_000

/** WebSocket close code for "service restart" (RFC 6455 registry): the clients reconnect on their own. */
export const CLOSE_RESTART = 1012

export interface HttpDrainer {
  /**
   * Stop taking connections, close idle keep-alive ones, answer every request in flight with
   * Connection: close. Resolves 0 once every connection has ended, or after `ms` with how many
   * requests were still open (their connections are then cut).
   */
  close(ms: number): Promise<number>
  stopping(): boolean
}

/** Tracks responses in flight on `server`. Attach before the server takes requests. */
export function httpDrainer(server: Server): HttpDrainer {
  const inflight = new Set<ServerResponse>()
  let closing = false
  server.prependListener('request', (_req, res: ServerResponse) => {
    if (closing && !res.headersSent) res.setHeader('connection', 'close')
    inflight.add(res)
    res.on('close', () => inflight.delete(res))
  })
  function close(ms: number): Promise<number> {
    closing = true
    return new Promise((resolve) => {
      let done = false
      const finish = (cut: number): void => {
        if (done) return
        done = true
        clearInterval(sweep)
        clearTimeout(timer)
        resolve(cut)
      }
      server.close(() => finish(0))
      for (const res of inflight) if (!res.headersSent) res.setHeader('connection', 'close')
      // A connection whose response just finished goes idle: close it now, not after keepAliveTimeout.
      const idle = (): void => server.closeIdleConnections()
      idle()
      const sweep = setInterval(idle, 50)
      const timer = setTimeout(() => {
        const cut = inflight.size
        server.closeAllConnections()
        finish(cut)
      }, ms)
    })
  }
  return { close, stopping: () => closing }
}

/**
 * Close every client of `wss` with 1012 (service restart) and `reason`; a client that has not
 * finished the close handshake after `ms` is terminated. Resolves once every one has closed (its
 * 'close' handlers have run).
 */
export function closeSockets(
  wss: WebSocketServer,
  ms: number,
  reason = 'server_restart',
): Promise<{ closed: number; terminated: number }> {
  const clients = [...wss.clients]
  if (clients.length === 0) return Promise.resolve({ closed: 0, terminated: 0 })
  return new Promise((resolve) => {
    let left = clients.length
    let terminated = 0
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(cut)
      clearTimeout(giveUp)
      resolve({ closed: clients.length - terminated, terminated })
    }
    const cut = setTimeout(() => {
      for (const ws of clients) {
        if (ws.readyState !== ws.CLOSED) {
          terminated++
          ws.terminate()
        }
      }
    }, ms)
    // terminate() emits 'close' on the next turns; never wait on it forever.
    const giveUp = setTimeout(finish, ms + 1000)
    for (const ws of clients) {
      ws.once('close', () => {
        if (--left === 0) finish()
      })
      ws.close(CLOSE_RESTART, reason)
    }
  })
}

/** Await `p`, but no longer than `ms`. */
export function within<T>(ms: number, p: Promise<T> | undefined | null): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined)
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => {
      const t = setTimeout(() => r(undefined), ms)
      t.unref()
    }),
  ])
}
