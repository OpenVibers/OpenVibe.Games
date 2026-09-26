import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { CLOSE_RESTART, DEADLINE_MS } from './net/gracefulStop.js'

/**
 * Graceful stop (roadmap WS-P lifecycle), on the real server process as systemd runs it: SIGTERM
 * while a player socket, an editor socket and an HTTP request are open. The sockets are closed with
 * 1012 (service restart), new connections are refused, the request in flight is answered, the event
 * outbox is stopped, and the process exits 0 within the manifest's deadline.
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

async function refused(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })
    return false
  } catch {
    return true
  }
}

function openSocket(
  url: string,
): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
    )
    ws.on('open', () => resolve({ ws, closed }))
    ws.on('error', reject)
  })
}

const dir = mkdtempSync(join(tmpdir(), 'ov-games-stop-'))
let child: ChildProcess | null = null

afterAll(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

describe('SIGTERM', () => {
  it('drains HTTP, closes sockets with 1012, stops the outbox and exits 0 in time', async () => {
    const port = await freePort()
    let out = ''
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH: join(dir, 'world.db'),
        MAP_PATH: join(dir, 'map.json'),
        STATIC_DIR: '',
        GUEST_IP_BINDING: 'off',
        // The platform side on, pointed at nothing: the outbox exists and has to be stopped.
        OV_OAUTH_CLIENT_SECRET: 'test-secret-not-real',
        OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
        EVENTS_URL: 'http://127.0.0.1:9',
        MEDIA_URL: '',
        GAMES_EVENTS_SECRET: 'x'.repeat(40),
        GAMES_EVENTS_ENDPOINT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    const exited = new Promise<number | null>((r) => child?.on('exit', (code) => r(code)))
    for (let i = 0; !out.includes('"listening"'); i++) {
      if (child.exitCode !== null || i > 300) throw new Error(`server did not start:\n${out}`)
      await sleep(100)
    }
    expect(out).toContain('"events on"')

    const player = await openSocket(`ws://127.0.0.1:${port}/ws`)
    const editor = await openSocket(`ws://127.0.0.1:${port}/editor-ws`)

    // A request in flight: POST /internal/events reads its whole body before it answers.
    const body = Buffer.from(JSON.stringify({ probe: 'graceful-stop', pad: 'x'.repeat(64) }))
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/internal/events',
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    })
    const answered = new Promise<{ status: number; headers: IncomingHttpHeaders; at: number }>(
      (resolve, reject) => {
        req.on('response', (res) => {
          res.resume()
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, at: Date.now() }),
          )
        })
        req.on('error', reject)
      },
    )
    req.write(body.subarray(0, 10))
    await sleep(200)

    const t0 = Date.now()
    child.kill('SIGTERM')
    const [p, e] = await Promise.all([player.closed, editor.closed])
    expect(p).toEqual({ code: CLOSE_RESTART, reason: 'server_restart' })
    expect(e).toEqual({ code: CLOSE_RESTART, reason: 'server_restart' })
    await sleep(200)
    expect(await refused(port)).toBe(true)

    req.end(body.subarray(10))
    const r = await answered
    expect(r.at).toBeGreaterThan(t0)
    expect(r.status).toBe(401) // unsigned: answered, not cut
    expect(r.headers.connection).toBe('close')

    const code = await exited
    const ms = Date.now() - t0
    expect(code, out.slice(-3000)).toBe(0)
    expect(ms).toBeLessThan(DEADLINE_MS)
    expect(out).toContain('world saved on shutdown')
    const stopped = out
      .split('\n')
      .filter((l) => l.includes('"msg":"stopped"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)[0]
    expect(stopped).toMatchObject({
      outbox: 'stopped',
      players: 1,
      editors: 1,
      terminated: 0,
      requestsCut: 0,
    })
    console.log(
      `games: SIGTERM → exit 0 in ${ms} ms (${String(stopped?.ms)} ms inside the process)`,
    )
  }, 60_000)
})
