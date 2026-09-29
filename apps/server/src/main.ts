import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { createEventsClient, createPgOutbox, type PgOutbox } from 'openvibe-sdk/events'
import { createValkey } from 'openvibe-sdk/valkey'
import { compileMapFileV2, createContent, parseMapFile, setMapOverride } from '@openvibe/content'
import { openPgStore } from '@openvibe/persistence'
import { createHeadlessHavokWorld } from '@openvibe/physics/havok'
import { createConsoleLogger } from '@openvibe/shared'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
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
import { acceptUpgrade, attachWebSocket } from './net/wsTransport.js'
import { resolveClientAddress } from './net/clientAddress.js'
import { ServerMetrics } from './observability/metrics.js'
import { createReadiness } from './observability/readiness.js'
import { buildRelease, releaseHandler } from './observability/release.js'
import { sharedAssetsHandler } from './net/sharedAssets.js'
import { ModRegistry } from './mods/registry.js'
import { createNetworkModGrants } from './mods/networkGrants.js'
import { createGamesActorLimits } from './net/actorLimits.js'
import { handleModsRequest } from './mods/routes.js'
import { ModRuntime } from './mods/runtime.js'
import { isGuestToken } from './platform/accounts.js'
import { ProgressSummaryWriter } from './platform/progressSummary.js'
import {
  EVENT_SOURCE,
  GameEventRecorder,
  NO_EVENTS,
  outboxSink,
  type EventSink,
} from './platform/gameEvents.js'
import { createAccountData, networkSender, type AccountEvent } from './platform/accountData.js'
import { MediaMirror } from './platform/mediaMirror.js'
import { createPlatformClient } from './platform/serviceClient.js'
import {
  createRevocationEvents,
  ensureRevocationSubscription,
} from './platform/revocationEvents.js'
import { createStaffAuthorizer } from './platform/staffAuth.js'
import { createWsTicketStore } from './net/wsTicket.js'

/**
 * Dedicated authoritative server entry point.
 * Boot order: config -> content validation (fail fast) -> physics -> database + migrations ->
 * persistence -> world restore -> network -> fixed-tick loop.
 */
async function main(): Promise<void> {
  const log = createConsoleLogger(
    { app: 'openvibe-server' },
    process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  )
  const config = loadConfig(process.env)
  log.info('starting', { port: config.port, place: config.placeId })

  // Content validates at construction — invalid definitions kill the boot.
  const content = createContent()
  // Edited map (from /editor): heightfield + extra statics replace the
  // procedural terrain for EVERYTHING (physics, spawns, clients fetch the
  // same file over /map.json).
  if (existsSync(config.mapPath)) {
    try {
      // The document is v2; the RUNTIME representation is v2 compiled straight
      // through.
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

  // PostgreSQL (or embedded PGlite in development), migrated before anything writes.
  const db = await openDb(config.db, log)
  const store = openPgStore(db, { placeId: config.placeId })
  await store.ensurePlace()

  const metrics = new ServerMetrics()
  const world = new GameWorld(content, physics, log.child({ system: 'world' }))
  await world.seedOrRestore(store)

  // ── Platform integration (roadmap Wave 12) ─────────────────────────
  // Every service call carries the `games` principal's client-credentials
  // token; with no client secret configured none of this talks to anything.
  const platform = createPlatformClient(config.platform)
  const platformLog = log.child({ system: 'platform' })
  const valkey = createValkey({ url: config.db.valkeyUrl ?? '', prefix: config.db.valkeyPrefix })
  let outbox: PgOutbox | null = null
  let sink: EventSink = NO_EVENTS
  if (platform && config.platform.eventsUrl) {
    let lastError: string | null = null
    outbox = createPgOutbox(db, {
      events: createEventsClient(platform.client, { source: EVENT_SOURCE }),
      intervalMs: 2000,
      onError: (err) => {
        const message = String((err as Error | undefined)?.message ?? err)
        if (message !== lastError)
          platformLog.warn('event publish failed (will retry)', { error: message })
        lastError = message
      },
    })
    sink = outboxSink(outbox, db)
    outbox.start()
    platformLog.info('events on', {
      url: config.platform.eventsUrl,
      pending: await outbox.pending(),
    })
  }
  const recorder = sink.enabled
    ? new GameEventRecorder(sink, content.world.id, config.platform.worldSavedEventMinutes * 60_000)
    : undefined
  const mods = new ModRegistry(store, content, sink, Date.now, log.child({ system: 'mods' }))
  await mods.load()
  const modRuntime = new ModRuntime(mods, content, log.child({ system: 'mods' }), {
    reconcileEveryTicks: config.tickRate,
  })
  // Mod principals live in Network (ADR-013, WS-M task 3): the API asks it first; at boot every install's copy
  // catches up with its principal (a change staff made while this server was down).
  const modGrants = platform
    ? createNetworkModGrants({ networkUrl: config.platform.networkUrl, tokens: platform.tokens })
    : null
  if (modGrants) {
    try {
      const principals = await modGrants.list()
      for (const p of principals) await mods.applyNetwork(p)
      const known = new Set(principals.map((p) => p.mod_id))
      const unregistered = mods
        .list()
        .filter((v) => !known.has(v.mod.id) && v.mod.status !== 'revoked')
        .map((v) => v.mod.id)
      if (unregistered.length)
        log.warn('mod installs without a Network principal', { mods: unregistered.join(',') })
    } catch (err) {
      log.warn('mod principals not read at boot', {
        error: String((err as Error)?.message ?? err),
      })
    }
  }
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
    log: platformLog.child({ system: 'staff-auth' }),
  })
  const pruneTimer = setInterval(() => void outbox?.prune(), 6 * 3600 * 1000)
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
  // Async boot: env, markets and the NPC population load before the tick loop starts.
  await game.load()

  const accountData = platform
    ? createAccountData({
        db,
        identity: store.identity,
        send: networkSender({ networkUrl: config.platform.networkUrl, tokens: platform.tokens }),
        closeSessions: async (subjects) => {
          let closed = 0
          for (const s of subjects) closed += game.revokeSubject(s, Number.MAX_SAFE_INTEGER)
          // Let the closing sockets' character saves land before the rows are erased.
          if (closed) {
            await new Promise((r) => setTimeout(r, 2000))
            await game.drain()
          }
        },
        log: platformLog.child({ system: 'account-data' }),
      })
    : null

  // Sign-out everywhere (network.user.token_valid_after): POST /internal/events closes the person's
  // older game sessions; the subscription is created at boot when a secret is set (WS-B task 4).
  const revocations = createRevocationEvents({
    db,
    secrets: config.platform.eventsSecrets,
    onRevoked: (subject, validAfterMs) => game.revokeSubject(subject, validAfterMs),
    // Account merge (ADR-029): the folded-in account's characters join the survivor's free slots.
    onMerged: (from, into, mergeId) => store.identity.mergeSubject(from, into, mergeId, Date.now()),
    // Account export and deletion (ADR-033): the part goes to Network; a deleted account's sessions close (each
    // close saves its character) before its characters are erased.
    ...(accountData ? { onAccountEvent: (event) => accountData.apply(event as AccountEvent) } : {}),
    // Mod principals (ADR-013): an install's grants follow its principal in Network (a change staff made there).
    onModGrants: async (p) => {
      const view = await mods.applyNetwork(p)
      return view ? `mod:${view.mod.status}` : 'ignored:unknown_mod'
    },
    log: platformLog,
  })
  await revocations.store.load()
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
  // GET /shared/*: this server's own pinned OpenVibe Frame files (D42), not openvibe.network's.
  const serveShared = sharedAssetsHandler()

  // GET /api/ready: the database answers (db.ready()) and the simulation ticks (/healthz stays liveness only).
  const readiness = createReadiness({
    pingDb: () => db.ready(),
    metrics,
    online: () => game.onlineCount(),
  })

  // Per-actor limits on editor saves, uploads and the mods API (roadmap WS-R task 4). With VALKEY_URL the
  // counters are shared across instances; otherwise they live in this process.
  const actorLimits = createGamesActorLimits({
    onLimited: (name, actor) => log.warn('rate limited', { limit: name, actor }),
    valkey,
  })
  const ticketStore = createWsTicketStore({ valkey })
  // One trusted-proxy-aware address resolution for the upgrade limit, the
  // ticket limit and logs (config.TRUST_PROXY; the socket address otherwise).
  const clientAddress = (req: IncomingMessage): string =>
    resolveClientAddress(req, config.trustProxy)
  const http = createHttpServer(
    config.staticDir,
    metrics,
    log.child({ system: 'http' }),
    config.mapPath,
    {
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
        if (!user?.subjectId) return []
        account = user.subjectId
        // Guest conversion (WS-B task 8): this browser's guest character shows up in the account's
        // list (and moves there) the moment it signs in, before any slot is picked.
        if (isGuestToken(token))
          await store.identity.adoptGuestCharacter(token, user.subjectId, Date.now())
      } else if (!isGuestToken(token)) {
        // Never list an account key's characters for a guest query.
        return []
      }
      return (await store.players.listByToken(account))
        .slice(0, 3)
        .map((p) => ({ slot: p.charSlot, name: p.name, appearance: p.appearance }))
    },
    config.oauth,
    {
      handle: (req, res) => {
        if (revocations.handle(req, res)) return true
        if (readiness.handle(req, res)) return true
        if (serveRelease(req, res)) return true
        if (serveShared(req, res)) return true
        if ((req.url ?? '').split('?')[0] === '/api/v1/platform' && req.method === 'GET') {
          // Operational status of the platform adapters; never secrets. The DB reads are async; the
          // response is written when they resolve. A database error answers 503 rather than leaving the
          // request hanging or rejecting unhandled.
          void (async () => {
            const mediaCounts = mirror ? await store.mediaMirrors.counts() : null
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(
              JSON.stringify({
                principal: platform ? platform.clientId : null,
                events: outbox
                  ? {
                      enabled: true,
                      pending: await outbox.pending(),
                      rejected: await outbox.rejected(),
                    }
                  : { enabled: false },
                media: mediaCounts
                  ? {
                      enabled: true,
                      namespace: config.platform.mediaNamespace,
                      ...mediaCounts,
                    }
                  : { enabled: false },
                mods: {
                  installed: mods.list().length,
                  active: mods.list().filter((m) => mods.isActive(m.mod.id)).length,
                },
              }),
            )
          })().catch((err: unknown) => {
            log.warn('platform status failed', {
              error: String((err as Error | undefined)?.message ?? err),
            })
            if (res.writableEnded) return
            res.writeHead(503, {
              'content-type': 'application/problem+json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(
              JSON.stringify({
                title: 'service_unavailable',
                status: 503,
                detail: 'platform status unavailable',
              }),
            )
          })
          return true
        }
        return handleModsRequest(req, res, {
          registry: mods,
          authorize: authorizeStaff,
          ...(modGrants ? { grants: modGrants } : {}),
          limits: actorLimits,
          log: log.child({ system: 'mods-api' }),
        })
      },
      onAssetStored: (asset) => mirror?.enqueue(asset),
      limits: actorLimits,
      clientAddress,
    },
    ticketStore,
  )
  const drainer = httpDrainer(http)
  world.reconcileMapNodes()
  world.reconcileMapProps()
  const gameWss = attachWebSocket(http, game, {
    tickets: ticketStore,
    upgradeLimits: actorLimits,
    clientAddress,
    log: log.child({ system: 'ws' }),
  })
  const editors = attachEditorWs(
    http,
    { networkAuthUrl: config.networkAuthUrl },
    log.child({ system: 'editor-ws' }),
  )
  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (drainer.stopping()) {
      // Stopping: no new sessions (the client retries after the restart).
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n')
    } else if (path === '/ws') {
      // Authenticate at the upgrade: validate-and-consume the ticket before
      // ws.handleUpgrade runs (ADR-0007 netcode + decision 8).
      void acceptUpgrade(
        ticketStore,
        actorLimits,
        log.child({ system: 'ws-upgrade' }),
        req,
        socket,
        clientAddress,
      )
        .then((ok) => {
          if (!ok) return
          gameWss.handleUpgrade(req, socket, head, (ws) => gameWss.emit('connection', ws, req))
        })
        .catch((err: unknown) => {
          // A failure here must never become an unhandled rejection: refuse
          // the upgrade and let the client retry.
          log.warn('ws upgrade failed', { error: err instanceof Error ? err.message : String(err) })
          socket.destroy()
        })
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
  // close saves that character and records games.player.left); a final checkpoint with every session
  // dirty; await the write-behind drain (the checkpoint and every queued save); let requests in flight
  // finish (DRAIN_MS); let the mirror pass and the progress summaries settle; stop the event outbox and
  // await its last send (unsent rows stay for the next start); close the database; exit 0. Everything
  // within DEADLINE_MS, else exit 1.
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
      // Mark every session dirty and queue the final checkpoint, then let the whole write-behind queue
      // (that checkpoint plus every disconnect save queued before it) drain.
      game.shutdown()
      const drained = await game.drain()
      const cut = await httpDone
      await within(2000, mirrorDone)
      await within(1000, progressSummary?.settle())
      await within(2000, outbox?.stop())
      await mods.flushWrites()
      await store.close()
      physics.dispose()
      await valkey?.close()
      log.info('stopped', {
        ms: Date.now() - t0,
        players: players.closed + players.terminated,
        editors: editorPeers.closed + editorPeers.terminated,
        terminated: players.terminated + editorPeers.terminated,
        requestsCut: cut,
        outbox: outbox ? 'stopped' : 'off',
        drained,
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
