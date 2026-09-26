import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createEventsClient,
  createOutbox,
  type Outbox,
  type SqliteDatabase,
} from 'openvibe-sdk/events'
import { compileMapFileV2, createContent, parseMapFile, setMapOverride } from '@openvibe/content'
import { openSqliteStore } from '@openvibe/persistence/sqlite'
import { createHeadlessHavokWorld } from '@openvibe/physics/havok'
import { createConsoleLogger } from '@openvibe/shared'
import { loadConfig } from './config.js'
import { GameServer } from './game/gameServer.js'
import { GameWorld } from './game/gameWorld.js'
import { loadHavok } from './havokLoader.js'
import { attachEditorWs } from './net/editorWs.js'
import {
  closeSockets,
  DEADLINE_MS,
  DRAIN_MS,
  httpDrainer,
  SOCKETS_MS,
  within,
} from './net/gracefulStop.js'
import { createHttpServer } from './net/httpServer.js'
import { resolveNetworkUser } from './net/networkAuth.js'
import { attachWebSocket } from './net/wsTransport.js'
import { ServerMetrics } from './observability/metrics.js'
import { createReadiness } from './observability/readiness.js'
import { buildRelease, releaseHandler } from './observability/release.js'
import { ModRegistry } from './mods/registry.js'
import { handleModsRequest } from './mods/routes.js'
import { ModRuntime } from './mods/runtime.js'
import { accountForNetworkUser, isGuestToken } from './platform/accounts.js'
import { ProgressSummaryWriter } from './platform/progressSummary.js'
import {
  EVENT_SOURCE,
  GameEventRecorder,
  NO_EVENTS,
  outboxSink,
  type EventSink,
} from './platform/gameEvents.js'
import { MediaMirror } from './platform/mediaMirror.js'
import { createPlatformClient } from './platform/serviceClient.js'
import {
  createRevocationEvents,
  ensureRevocationSubscription,
} from './platform/revocationEvents.js'
import { createStaffAuthorizer } from './platform/staffAuth.js'

/**
 * Dedicated authoritative server entry point.
 * Boot order: config -> content validation (fail fast) -> physics ->
 * persistence -> world restore -> network -> fixed-tick loop.
 */
async function main(): Promise<void> {
  const log = createConsoleLogger(
    { app: 'openvibe-server' },
    process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  )
  const config = loadConfig(process.env)
  log.info('starting', { port: config.port, db: config.dbPath })

  // Content validates at construction — invalid definitions kill the boot.
  const content = createContent()
  // Edited map (from /editor): heightfield + extra statics replace the
  // procedural terrain for EVERYTHING (physics, spawns, clients fetch the
  // same file over /map.json).
  if (existsSync(config.mapPath)) {
    try {
      // v1 artifacts still load — parseMapFile migrates them — but the
      // RUNTIME representation is always v2 compiled straight through.
      const parsed = parseMapFile(JSON.parse(readFileSync(config.mapPath, 'utf8')))
      if (parsed.ok) {
        // The map's statics live in the override, NOT merged into
        // content.world.statics: that merge was permanent, so the map layer
        // could never be replaced and a live save could not move or delete
        // anything it had already added.
        setMapOverride(compileMapFileV2(parsed.map))
        log.info('edited map loaded', {
          statics: parsed.map.statics.length,
          terrains: parsed.map.terrains.length,
          migrated: parsed.migrated,
        })
      } else {
        log.warn('edited map invalid — ignoring', { issues: parsed.issues.slice(0, 5).join('; ') })
      }
    } catch (err) {
      log.warn('edited map unreadable — using procedural terrain', { error: String(err) })
    }
  }
  log.info('content loaded', {
    items: content.allItems().length,
    recipes: content.allRecipes().length,
    world: content.world.id,
  })

  const havok = await loadHavok()
  const physics = createHeadlessHavokWorld(havok)

  mkdirSync(dirname(config.dbPath), { recursive: true })
  const store = openSqliteStore(config.dbPath)

  const metrics = new ServerMetrics()
  const world = new GameWorld(content, physics, log.child({ system: 'world' }))
  world.seedOrRestore(store)

  // ── Platform integration (roadmap Wave 12) ─────────────────────────
  // Every service call carries the `games` principal's client-credentials
  // token; with no client secret configured none of this talks to anything.
  const platform = createPlatformClient(config.platform)
  const platformLog = log.child({ system: 'platform' })
  let outbox: Outbox | null = null
  let sink: EventSink = NO_EVENTS
  if (platform && config.platform.eventsUrl) {
    let lastError: string | null = null
    // better-sqlite3's Transaction<F> is a callable F; the SDK types it as plain F.
    outbox = createOutbox(store.db as unknown as SqliteDatabase, {
      events: createEventsClient(platform.client, { source: EVENT_SOURCE }),
      intervalMs: 2000,
      onError: (err) => {
        const message = String((err as Error | undefined)?.message ?? err)
        if (message !== lastError)
          platformLog.warn('event publish failed (will retry)', { error: message })
        lastError = message
      },
    })
    outbox.ensureSchema()
    sink = outboxSink(outbox)
    outbox.start()
    platformLog.info('events on', { url: config.platform.eventsUrl, pending: outbox.pending() })
  }
  const recorder = sink.enabled
    ? new GameEventRecorder(sink, content.world.id, config.platform.worldSavedEventMinutes * 60_000)
    : undefined
  const mods = new ModRegistry(store, content, sink)
  const modRuntime = new ModRuntime(mods, store, content, log.child({ system: 'mods' }), {
    reconcileEveryTicks: config.tickRate,
  })
  const mirror =
    platform && config.platform.mediaUrl
      ? new MediaMirror({
          client: platform.client,
          store,
          namespace: config.platform.mediaNamespace,
          assetsDir: join(dirname(config.mapPath), 'map-assets'),
          log: platformLog.child({ system: 'media-mirror' }),
        })
      : null
  if (mirror) {
    void mirror.backfill().then((queued) => {
      platformLog.info('media mirror on', { url: config.platform.mediaUrl ?? '', queued })
      mirror.start()
    })
  }
  const authorizeStaff = createStaffAuthorizer({
    networkAuthUrl: config.networkAuthUrl,
    networkUrl: config.platform.networkUrl,
    editorKey: config.editorKey,
  })
  const pruneTimer = setInterval(() => outbox?.prune(), 6 * 3600 * 1000)
  pruneTimer.unref()

  // games.progress.summary on Network (WS-B task 9): needs the games principal.
  const progressSummary = platform
    ? new ProgressSummaryWriter(platform.client, platformLog.child({ system: 'progress-summary' }))
    : null
  const game = new GameServer(config, world, store, metrics, log.child({ system: 'game' }), {
    ...(recorder ? { events: recorder } : {}),
    mods: modRuntime,
    ...(progressSummary ? { progressSummary } : {}),
  })

  // Sign-out everywhere (network.user.token_valid_after): POST /internal/events closes the person's
  // older game sessions; the subscription is created at boot when a secret is set (WS-B task 4).
  const revocations = createRevocationEvents({
    db: store.db,
    secrets: config.platform.eventsSecrets,
    onRevoked: (subject, validAfterMs) => game.revokeSubject(subject, validAfterMs),
    log: platformLog,
  })
  if (
    platform &&
    config.platform.eventsUrl &&
    config.platform.eventsSecrets[0] &&
    config.platform.eventsEndpoint
  ) {
    const subscribe = (attempt: number): void => {
      ensureRevocationSubscription({
        eventsUrl: config.platform.eventsUrl as string,
        endpoint: config.platform.eventsEndpoint as string,
        secret: config.platform.eventsSecrets[0] as string,
        tokens: platform.tokens,
        log: platformLog,
      }).catch((err: unknown) => {
        platformLog.warn('events subscription not ready (will retry)', {
          error: String((err as Error)?.message ?? err),
          attempt,
        })
        if (attempt < 5) setTimeout(() => subscribe(attempt + 1), 60_000 * attempt).unref()
      })
    }
    subscribe(1)
  }

  // GET /release.json (D43): the deployed commit and package versions, as every OpenVibe service serves it.
  const serveRelease = releaseHandler(buildRelease(process.cwd()))

  // GET /api/ready: world.db answers and the simulation ticks (/healthz stays liveness only).
  const schemaVersion = store.db.prepare('SELECT value FROM meta WHERE key = ?')
  const readiness = createReadiness({
    pingDb: () => schemaVersion.get('schema_version') !== undefined,
    metrics,
    online: () => game.onlineCount(),
  })

  const http = createHttpServer(
    config.staticDir,
    metrics,
    log.child({ system: 'http' }),
    config.mapPath,
    {
      key: config.editorKey,
      networkAuthUrl: config.networkAuthUrl,
    },
    // LIVE map apply. Receives the validated v2 DOCUMENT, not a JSON string
    // of a fabricated v1 wire — the save pipeline has already parsed,
    // migrated and validated it, so there is nothing to re-parse here.
    (next, revision) => {
      try {
        setMapOverride(compileMapFileV2(next))
        world.reconcileMapTerrain()
        world.reconcileMapStatics()
        world.reconcileMapZones()
        world.reconcileMapNodes()
        world.reconcileMapProps()
        game.broadcastMapReload()
        editors.broadcastSaved(revision)
        log.info('map applied live', { terrains: next.terrains.length, revision })
      } catch (err) {
        log.warn('live map apply failed', { error: String(err) })
      }
    },
    async (token, auth) => {
      // Signed-in accounts list by their openvibe.network identity; guests by
      // their browser token.
      let account = token
      if (auth) {
        const user = await resolveNetworkUser(config.networkAuthUrl, auth)
        if (!user) return []
        const resolved = accountForNetworkUser(store, user, Date.now())
        account = resolved.key
        // Guest conversion (WS-B task 8): this browser's guest character shows up in the account's
        // list (and moves there) the moment it signs in, before any slot is picked.
        if (resolved.subjectId && isGuestToken(token))
          store.identity.adoptGuestCharacter(token, resolved.subjectId, Date.now())
      } else if (!isGuestToken(token)) {
        // Never list an account key's characters for a guest query.
        return []
      }
      return store.players
        .listByToken(account)
        .slice(0, 3)
        .map((p) => ({ slot: p.charSlot, name: p.name, appearance: p.appearance }))
    },
    config.oauth,
    {
      handle: (req, res) => {
        if (revocations.handle(req, res)) return true
        if (readiness.handle(req, res)) return true
        if (serveRelease(req, res)) return true
        if ((req.url ?? '').split('?')[0] === '/api/v1/platform' && req.method === 'GET') {
          // Operational status of the platform adapters; never secrets.
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(
            JSON.stringify({
              principal: platform ? platform.clientId : null,
              events: outbox
                ? { enabled: true, pending: outbox.pending(), rejected: outbox.rejected() }
                : { enabled: false },
              media: mirror
                ? {
                    enabled: true,
                    namespace: config.platform.mediaNamespace,
                    ...store.mediaMirrors.counts(),
                  }
                : { enabled: false },
              mods: {
                installed: mods.list().length,
                active: mods.list().filter((m) => mods.isActive(m.mod.id)).length,
              },
            }),
          )
          return true
        }
        return handleModsRequest(req, res, {
          registry: mods,
          authorize: authorizeStaff,
          log: log.child({ system: 'mods-api' }),
        })
      },
      onAssetStored: (asset) => mirror?.enqueue(asset),
    },
  )
  const drainer = httpDrainer(http)
  world.reconcileMapNodes()
  world.reconcileMapProps()
  const gameWss = attachWebSocket(http, game, log.child({ system: 'ws' }))
  const editors = attachEditorWs(
    http,
    { key: config.editorKey, networkAuthUrl: config.networkAuthUrl },
    log.child({ system: 'editor-ws' }),
  )
  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (drainer.stopping()) {
      // Stopping: no new sessions (the client retries after the restart).
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n')
    } else if (path === '/ws') {
      gameWss.handleUpgrade(req, socket, head, (ws) => gameWss.emit('connection', ws, req))
    } else if (path === '/editor-ws') {
      editors.wss.handleUpgrade(req, socket, head, (ws) => editors.wss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })
  http.listen(config.port, config.host, () => {
    log.info('listening', { host: config.host, port: config.port })
  })

  // Fixed-tick loop with drift correction — never tied to timers' jitter.
  const tickMs = 1000 / config.tickRate
  let nextTick = performance.now()
  let running = true
  const loop = (): void => {
    if (!running) return
    const now = performance.now()
    while (now >= nextTick) {
      game.step()
      nextTick += tickMs
      // If we fell far behind (debugger pause, EL stall), resync instead of
      // spiraling through hundreds of catch-up ticks.
      if (now - nextTick > 1000) nextTick = now + tickMs
    }
    setTimeout(loop, Math.max(0, nextTick - performance.now()))
  }
  loop()

  const metricsTimer = setInterval(() => metrics.logSummary(log), config.metricsLogSeconds * 1000)

  // ── Stop (roadmap WS-P lifecycle; manifests/services/games.json → lifecycle.shutdown) ──
  // systemd sends SIGTERM (TimeoutStopSec=30). In order: stop taking connections (HTTP and WebSocket
  // upgrades) while requests in flight carry on; stop the simulation, the metrics and prune timers and
  // the media mirror; tell every player, then close every game and editor socket with 1012 (each game
  // close saves that character and records games.player.left; the clients reconnect on their own);
  // save the world; let requests in flight finish (DRAIN_MS); let the mirror pass and the progress
  // summaries settle; stop the event outbox and await its last send (unsent rows stay in the table
  // for the next start); close world.db; exit 0. Everything within DEADLINE_MS, else exit 1.
  let stopping: Promise<void> | null = null
  const shutdown = (signal: string): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      const t0 = Date.now()
      log.info('shutting down', { signal, deadlineMs: DEADLINE_MS })
      const hard = setTimeout(() => {
        log.error('shutdown deadline passed: exiting 1', { deadlineMs: DEADLINE_MS })
        process.exit(1)
      }, DEADLINE_MS)
      hard.unref()
      const httpDone = drainer.close(DRAIN_MS)
      running = false
      clearInterval(metricsTimer)
      clearInterval(pruneTimer)
      editors.stop()
      const mirrorDone = mirror?.stop()
      game.announceRestart()
      const [players, editorPeers] = await Promise.all([
        closeSockets(gameWss, SOCKETS_MS),
        closeSockets(editors.wss, SOCKETS_MS),
      ])
      game.shutdown()
      const cut = await httpDone
      await within(2000, mirrorDone)
      await within(1000, progressSummary?.settle())
      await within(2000, outbox?.stop())
      store.close()
      physics.dispose()
      log.info('stopped', {
        ms: Date.now() - t0,
        players: players.closed + players.terminated,
        editors: editorPeers.closed + editorPeers.terminated,
        terminated: players.terminated + editorPeers.terminated,
        requestsCut: cut,
        outbox: outbox ? 'stopped' : 'off',
      })
      process.exit(0)
    })().catch((err: unknown) => {
      log.error('shutdown failed: exiting 1', { error: String((err as Error)?.stack ?? err) })
      process.exit(1)
    })
    return stopping
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error('fatal:', err)
  process.exit(1)
})
