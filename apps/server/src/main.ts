import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { createEventsClient, createPgOutbox, type PgOutbox } from 'openvibe-sdk/events'
import { createValkey } from 'openvibe-sdk/valkey'
import {
  CREATOR_WORLD_ID,
  compileMapFileV2,
  createContent,
  creatorWorldPack,
  parseMapFile,
  SCRAPLANDIA_PACK,
  setMapOverride,
  type ContentRegistry,
} from '@openvibe/content'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import {
  InstanceRegistry,
  createCreatorWorldStore,
  openPgStore,
  type InstanceLease,
} from '@openvibe/persistence'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { createConsoleLogger } from '@openvibe/shared'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { telemetry } from 'openvibe-sdk/service'
import { createPgTelemetrySink, startTelemetryRetention } from 'openvibe-sdk/telemetry'
import { GameServer } from './game/gameServer.js'
import { GameWorld } from './game/gameWorld.js'
import { InstanceHub } from './game/instanceHub.js'
import { PlaceRouter } from './game/placeRouter.js'
import { attachEditorWs } from './net/editorWs.js'
import {
  closeSockets,
  DEADLINE_MS,
  DRAIN_MS,
  httpDrainer,
  SOCKETS_MS,
  within,
} from './net/gracefulStop.js'
import { createGamesIndexNow } from './net/indexnow.js'
import { createHttpServer } from './net/httpServer.js'
import { resolveNetworkUser } from './net/networkAuth.js'
import { acceptUpgrade, attachWebSocket } from './net/wsTransport.js'
import { resolveClientAddress } from './net/clientAddress.js'
import { ServerMetrics } from './observability/metrics.js'
import { createReadiness } from './observability/readiness.js'
import { buildRelease, releaseHandler } from './observability/release.js'
import { sharedAssetsHandler } from './net/sharedAssets.js'
import { loadDefinitionPacks, scriptGrant } from './mods/contentPack.js'
import { ModError, ModRegistry, type ModView } from './mods/registry.js'
import { createNetworkModGrants } from './mods/networkGrants.js'
import { createGamesActorLimits } from './net/actorLimits.js'
import { handleModsRequest } from './mods/routes.js'
import { ModRuntime } from './mods/runtime.js'
import { ScriptModHost } from './mods/script/host.js'
import { PgScriptStorage } from './mods/script/storage.js'
import { ScriptModSchema, type ScriptCapability } from '@openvibe/content'
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
import { InventoryRewards } from './platform/inventoryRewards.js'
import { PlaySync } from './platform/playSync.js'
import {
  createRevocationEvents,
  ensureRevocationSubscription,
} from './platform/revocationEvents.js'
import { createStaffAuthorizer } from './platform/staffAuth.js'
import { createWsTicketStore } from './net/wsTicket.js'
import { GameProgressWriter } from './game/progression.js'
import type { RoundResult } from './game/salvageRush.js'
import { handleGameRead } from './net/gameRoutes.js'
import { createPlayBoards } from './platform/playBoards.js'
import { createCasualRoutes } from './casual/routes.js'
import { pruneCasualActions } from './casual/store.js'
import { CASUAL_GAMES, validatePack } from '@openvibe/casual'
import { CreatorWorldHost } from './worlds/worldHost.js'
import { createWorldHubStarter } from './worlds/startWorldHub.js'
import { createWorldRoutes } from './worlds/worldRoutes.js'

/**
 * Dedicated authoritative server entry point.
 * Boot order: config -> database + migrations -> persistence -> content validation with enabled
 * packs (fail fast) -> physics -> world restore -> network -> fixed-tick loop.
 */
async function main(): Promise<void> {
  const log = createConsoleLogger(
    { app: 'openvibe-server' },
    process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  )
  const config = loadConfig(process.env)
  log.info('starting', { port: config.port, place: config.placeId })

  // PostgreSQL (or embedded PGlite in development), migrated before anything writes. It opens
  // before content because enabled mod packs add definitions to the content registry.
  const db = await openDb(config.db, log)
  // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template (net/telemetryRoute.ts),
  // method and status class each minute, stored in telemetry_samples; rows older than 14 days go daily.
  // (openvibe-sdk 0.46's service and telemetry typings disagree on whether a sample's `service` is optional.)
  const telemetrySink = createPgTelemetrySink({ db, log: console })
  telemetry.init({ service: 'games', sink: (samples) => telemetrySink(samples as Parameters<typeof telemetrySink>[0]), intervalMs: 60_000 })
  const telemetryRetention = startTelemetryRetention({ db, log: console, olderThanDays: 14 })
  const registry = new InstanceRegistry(db, config.placeId)
  let primaryLease: InstanceLease
  const store = openPgStore(db, {
    placeId: config.placeId,
    instanceSlot: 0,
    leaseGuard: () => registry.assertHeld(primaryLease, Date.now()),
  })
  await store.ensurePlace()
  const claimed = await registry.claim(
    0,
    config.maxPlayers,
    crypto.randomUUID(),
    Date.now(),
    60_000,
  )
  if (!claimed) throw new Error('primary instance slot is already leased')
  primaryLease = claimed

  // Content validates at construction — invalid definitions kill the boot. Packs are the enabled
  // installs granted games.def.define; one that no longer builds is skipped and logged.
  const packs = await loadDefinitionPacks(store.mods, (modId, reason) =>
    log.warn('mod definitions skipped', { mod: modId, reason }),
  )
  const builtInPack = config.placeId === 'salvage-rush' ? SALVAGE_RUSH_PACK : SCRAPLANDIA_PACK
  const content = createContent(packs, builtInPack)
  let inventoryRewards: InventoryRewards | null = null
  const settleRewards = (subject: string): void => {
    void inventoryRewards
      ?.settleSubject(subject)
      .catch((error: unknown) =>
        log.warn('inventory reward lookup failed', { error: String(error) }),
      )
  }
  const progressWriter = new GameProgressWriter(
    db,
    (error) => log.warn('game progression write failed', { error: String(error) }),
    settleRewards,
  )
  const builtInModIds = new Set(
    (SCRAPLANDIA_PACK.mods ?? []).map((raw) => ScriptModSchema.parse(raw).id),
  )
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
        setMapOverride(compileMapFileV2(parsed.map), content.world.id)
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
    packs: packs.length,
  })

  const rapier = await loadRapier()
  const physics = createRapierWorld(rapier)

  const metrics = new ServerMetrics()
  const world = new GameWorld(content, physics, log.child({ system: 'world' }), config.interestCell)
  await world.seedOrRestore(store)

  // ── Platform integration (roadmap Wave 12) ─────────────────────────
  // Every service call carries the `games` principal's client-credentials
  // token; with no client secret configured none of this talks to anything.
  const platform = createPlatformClient(config.platform)
  inventoryRewards = new InventoryRewards({
    db,
    url: config.platform.inventoryUrl,
    enabled: config.platform.items && !!platform,
    tokens: platform?.tokens ?? null,
    warn: (message) => log.warn(message),
  })
  inventoryRewards.start()
  // OpenVibe.Play (ADR-0007 decision 10): both titles' scores, unlocks and guest adoptions, posted from the local tables.
  const playSync = new PlaySync({
    db,
    url: platform ? config.platform.playUrl : null,
    tokens: platform?.tokens ?? null,
    warn: (message) => log.warn(message),
  })
  playSync.start()
  // The in-game boards are Play's (public reads, no token).
  const playBoards = createPlayBoards({ url: config.platform.playUrl })
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
  const pruneTimer = setInterval(
    () => {
      void outbox?.prune()
      void pruneCasualActions(db, Date.now()).catch((err: unknown) =>
        log.warn('casual action prune failed', { error: String(err) }),
      )
    },
    6 * 3600 * 1000,
  )
  pruneTimer.unref()
  // The casual games' packs (plan T22) are validated like the 3D packs: a bad pack never serves.
  for (const pack of Object.values(CASUAL_GAMES)) {
    const problems = validatePack(pack)
    if (problems.length)
      throw new Error(`casual pack ${pack.id}: ${problems.slice(0, 5).join('; ')}`)
  }

  // games.progress.summary on Network (WS-B task 9): needs the games principal.
  const progressSummary = platform
    ? new ProgressSummaryWriter(platform.client, platformLog.child({ system: 'progress-summary' }))
    : null
  // games-quickjs@1 script mods run only where the place enables them; the engine (WASM) is not
  // even loaded otherwise. They stay in the def set, so the handshake digest is the same either way.
  const scriptLog = log.child({ system: 'script-mods' })
  const scriptHosts = new Map<string, ScriptModHost>()
  const createScriptHost = async (
    slot: number,
    placeId = config.placeId,
    roomContent = content,
    roomStore = store,
  ): Promise<ScriptModHost | undefined> => {
    if (!config.scriptMods) return undefined
    const { createQuickJsSandboxFactory } = await import('./mods/script/quickjs.js')
    // Built-in pack code is reviewed with the place; installed packs use only the approved subset.
    const grants: Record<string, string[]> = Object.fromEntries(
      roomContent
        .allMods()
        .filter((mod) => mod.granted === undefined)
        .map((mod) => [mod.id, mod.capabilities ?? ['players.read', 'world.emit']]),
    )
    for (const view of mods.list()) {
      if (view.mod.status !== 'enabled' || !view.granted.has('games.script.run')) continue
      for (const script of view.pack.mods ?? []) {
        if (script && typeof script === 'object' && 'id' in script && typeof script.id === 'string')
          grants[script.id] = [...view.granted]
            .filter((cap) => cap.startsWith('games.'))
            .map((cap) => cap.slice(6))
      }
    }
    const host = new ScriptModHost(
      roomContent.allMods(),
      createQuickJsSandboxFactory(),
      scriptLog.child({ placeId, slot }),
      undefined,
      {
        placeSeed: slot === 0 ? placeId : `${placeId}:${slot}`,
        grants: grants as Record<string, ScriptCapability[]>,
        storage: new PgScriptStorage(roomStore.mods, placeId, scriptLog),
      },
    )
    scriptHosts.set(`${placeId}:${slot}`, host)
    return host
  }
  const scripts = await createScriptHost(0)
  if (!config.scriptMods && content.allMods().length > 0) {
    scriptLog.info('script mods off for this place', { mods: content.allMods().length })
  }
  const game = new GameServer(
    { ...config, instanceSlot: 0 },
    world,
    store,
    metrics,
    log.child({ system: 'game' }),
    {
      ...(recorder ? { events: recorder } : {}),
      mods: modRuntime,
      ...(scripts ? { scripts } : {}),
      ...(progressSummary ? { progressSummary } : {}),
      guestAdopted: settleRewards,
      ...(config.placeId === 'scraplandia'
        ? {
            playerJoined: (key: string) => progressWriter.submitJoined(key),
            haulExtracted: (key: string, extractionId: string, name: string, score: number) =>
              progressWriter.submitHaul(extractionId, key, name, score),
          }
        : {}),
      ...(config.placeId === 'salvage-rush'
        ? {
            roundFinished: (roundId: string, results: RoundResult[]) => {
              progressWriter.submit(`0:${roundId}`, results)
            },
          }
        : {}),
    },
  )
  // Async boot: env, markets and the NPC population load before the tick loop starts.
  await game.load()
  await scripts?.start()
  const runningLease = await registry.renew(primaryLease, Date.now(), 15_000, 'running')
  if (!runningLease) throw new Error('primary instance lease expired during boot')
  primaryLease = runningLease
  const hub = new InstanceHub(
    registry,
    {
      lease: primaryLease,
      game,
      world,
      dispose: async () => {
        await scripts?.flushWrites()
        scripts?.dispose()
        scriptHosts.delete(`${config.placeId}:0`)
        physics.dispose()
      },
    },
    config.instancesPerPlace,
    config.maxPlayers,
    async (slot, lease) => {
      const roomLease = lease
      const roomStore = openPgStore(db, {
        placeId: config.placeId,
        instanceSlot: slot,
        leaseGuard: () => registry.assertHeld(roomLease, Date.now()),
      })
      await roomStore.ensurePlace()
      const roomPhysics = createRapierWorld(rapier)
      const roomWorld = new GameWorld(
        content,
        roomPhysics,
        log.child({ system: 'world', slot }),
        config.interestCell,
      )
      await roomWorld.seedOrRestore(roomStore)
      roomWorld.reconcileMapNodes()
      roomWorld.reconcileMapProps()
      const roomScripts = await createScriptHost(slot)
      const roomGame = new GameServer(
        { ...config, instanceSlot: slot },
        roomWorld,
        roomStore,
        metrics,
        log.child({ system: 'game', slot }),
        {
          ...(recorder ? { events: recorder } : {}),
          mods: new ModRuntime(mods, content, log.child({ system: 'mods', slot }), {
            reconcileEveryTicks: config.tickRate,
          }),
          ...(roomScripts ? { scripts: roomScripts } : {}),
          ...(progressSummary ? { progressSummary } : {}),
          guestAdopted: settleRewards,
          ...(config.placeId === 'scraplandia'
            ? {
                playerJoined: (key: string) => progressWriter.submitJoined(key),
                haulExtracted: (key: string, extractionId: string, name: string, score: number) =>
                  progressWriter.submitHaul(extractionId, key, name, score),
              }
            : {}),
          ...(config.placeId === 'salvage-rush'
            ? {
                roundFinished: (roundId: string, results: RoundResult[]) => {
                  progressWriter.submit(`${slot}:${roundId}`, results)
                },
              }
            : {}),
        },
      )
      await roomGame.load()
      await roomScripts?.start()
      return {
        lease: roomLease,
        game: roomGame,
        world: roomWorld,
        dispose: async () => {
          await roomScripts?.flushWrites()
          roomScripts?.dispose()
          scriptHosts.delete(`${config.placeId}:${slot}`)
          roomPhysics.dispose()
        },
      }
    },
    log.child({ system: 'instances' }),
  )
  const secondaryPlace = config.placeId === 'salvage-rush' ? 'scraplandia' : 'salvage-rush'
  const secondaryContent = createContent(
    packs,
    secondaryPlace === 'salvage-rush' ? SALVAGE_RUSH_PACK : SCRAPLANDIA_PACK,
  )
  const secondaryRegistry = new InstanceRegistry(db, secondaryPlace)
  let secondaryPrimaryLease: InstanceLease
  const secondaryStore = openPgStore(db, {
    placeId: secondaryPlace,
    instanceSlot: 0,
    leaseGuard: () => secondaryRegistry.assertHeld(secondaryPrimaryLease, Date.now()),
  })
  await secondaryStore.ensurePlace()
  const secondaryClaim = await secondaryRegistry.claim(
    0,
    config.maxPlayers,
    crypto.randomUUID(),
    Date.now(),
    60_000,
  )
  if (!secondaryClaim) throw new Error(`${secondaryPlace} primary instance slot is already leased`)
  secondaryPrimaryLease = secondaryClaim
  const secondaryRecorder = sink.enabled
    ? new GameEventRecorder(
        sink,
        secondaryContent.world.id,
        config.platform.worldSavedEventMinutes * 60_000,
      )
    : undefined
  const createSecondaryRoom = async (slot: number, lease: InstanceLease) => {
    const roomStore =
      slot === 0
        ? secondaryStore
        : openPgStore(db, {
            placeId: secondaryPlace,
            instanceSlot: slot,
            leaseGuard: () => secondaryRegistry.assertHeld(lease, Date.now()),
          })
    await roomStore.ensurePlace()
    const roomPhysics = createRapierWorld(rapier)
    const roomWorld = new GameWorld(
      secondaryContent,
      roomPhysics,
      log.child({ system: 'world', place: secondaryPlace, slot }),
      config.interestCell,
    )
    await roomWorld.seedOrRestore(roomStore)
    roomWorld.reconcileMapNodes()
    roomWorld.reconcileMapProps()
    const roomScripts = await createScriptHost(slot, secondaryPlace, secondaryContent, roomStore)
    const roomGame = new GameServer(
      { ...config, placeId: secondaryPlace, instanceSlot: slot },
      roomWorld,
      roomStore,
      metrics,
      log.child({ system: 'game', place: secondaryPlace, slot }),
      {
        ...(secondaryRecorder ? { events: secondaryRecorder } : {}),
        mods: new ModRuntime(
          mods,
          secondaryContent,
          log.child({ system: 'mods', place: secondaryPlace, slot }),
          {
            reconcileEveryTicks: config.tickRate,
          },
        ),
        ...(roomScripts ? { scripts: roomScripts } : {}),
        ...(progressSummary ? { progressSummary } : {}),
        guestAdopted: settleRewards,
        ...(secondaryPlace === 'scraplandia'
          ? {
              playerJoined: (key: string) => progressWriter.submitJoined(key),
              haulExtracted: (key: string, extractionId: string, name: string, score: number) =>
                progressWriter.submitHaul(extractionId, key, name, score),
            }
          : {
              roundFinished: (roundId: string, results: RoundResult[]) =>
                progressWriter.submit(`${slot}:${roundId}`, results),
            }),
      },
    )
    await roomGame.load()
    await roomScripts?.start()
    return {
      lease,
      game: roomGame,
      world: roomWorld,
      dispose: async () => {
        await roomScripts?.flushWrites()
        roomScripts?.dispose()
        scriptHosts.delete(`${secondaryPlace}:${slot}`)
        roomPhysics.dispose()
      },
    }
  }
  const secondaryPrimary = await createSecondaryRoom(0, secondaryPrimaryLease)
  const secondaryRunning = await secondaryRegistry.renew(
    secondaryPrimaryLease,
    Date.now(),
    15_000,
    'running',
  )
  if (!secondaryRunning) throw new Error(`${secondaryPlace} primary lease expired during boot`)
  secondaryPrimary.lease = secondaryRunning
  secondaryPrimaryLease = secondaryRunning
  const secondaryHub = new InstanceHub(
    secondaryRegistry,
    secondaryPrimary,
    config.instancesPerPlace,
    config.maxPlayers,
    createSecondaryRoom,
    log.child({ system: 'instances', place: secondaryPlace }),
  )
  const hubs = new Map([
    [config.placeId, hub],
    [secondaryPlace, secondaryHub],
  ])
  // ── Creator worlds (worlds/): players' own places, started on the first join, stopped when empty ──
  // A creator world is the place `world:<id>` with the plain creator pack and its map as the override. Its room is
  // sandboxed: no NPCs, no world events, no rewards, no events, and characters are never saved there.
  const creatorWorlds = createCreatorWorldStore(db)
  const creatorContent = new Map<string, ContentRegistry>()
  const contentForWorld = (worldId: string): ContentRegistry => {
    let built = creatorContent.get(worldId)
    if (!built) {
      if (creatorContent.size >= 256) creatorContent.clear()
      built = createContent([], creatorWorldPack(worldId))
      creatorContent.set(worldId, built)
    }
    return built
  }
  const startWorldHub = createWorldHubStarter({
    db,
    rapier,
    config,
    metrics,
    log,
    contentFor: contentForWorld,
  })
  const worldHost = new CreatorWorldHost({
    store: creatorWorlds,
    start: startWorldHub,
    log: log.child({ system: 'creator-worlds' }),
    maxRunning: config.creatorWorldsMax,
    idleMs: config.creatorWorldIdleSeconds * 1000,
  })
  const router = new PlaceRouter(hubs, config.placeId, worldHost)
  // The idle sweep runs in the admission chain, so a world never stops under a join that is starting it.
  const worldSweepTimer = setInterval(() => {
    void router
      .serialize(() => worldHost.sweep())
      .catch((err: unknown) => log.warn('creator world sweep failed', { error: String(err) }))
  }, 30_000)
  worldSweepTimer.unref()
  const contentByPlace = new Map([
    [config.placeId, content],
    [secondaryPlace, secondaryContent],
  ])
  const heartbeatTimer = setInterval(() => void router.heartbeat(), 5_000)
  heartbeatTimer.unref()

  const syncScriptView = async (view: ModView): Promise<void> => {
    if (view.mod.runtime !== 'games-quickjs@1') return
    for (const raw of view.pack.mods ?? []) {
      const script = ScriptModSchema.parse(raw)
      const active = view.mod.status === 'enabled' && view.granted.has('games.script.run')
      for (const host of scriptHosts.values()) host.remove(script.id)
      if (!active) {
        for (const registryContent of contentByPlace.values())
          registryContent.removeScriptMod(script.id)
        continue
      }
      const granted = (script.capabilities ?? (['players.read', 'world.emit'] as const)).filter(
        (cap) => view.granted.has(scriptGrant(cap)),
      )
      const pinned = { ...script, granted }
      for (const registryContent of contentByPlace.values()) {
        if (registryContent.allMods().some((mod) => mod.id === script.id))
          registryContent.replaceScriptMod(pinned)
        else registryContent.addScriptMod(pinned)
      }
      for (const host of scriptHosts.values()) {
        const result = await host.add(pinned, granted)
        if (!result.ok)
          log.warn('script failed to start after grant change', {
            mod: script.id,
            error: result.error,
          })
      }
    }
    for (const room of router.activeRooms)
      room.game.announce(
        'Script mod definitions changed. New connections must use the updated content set.',
      )
  }

  const accountData = platform
    ? createAccountData({
        db,
        identity: store.identity,
        send: networkSender({ networkUrl: config.platform.networkUrl, tokens: platform.tokens }),
        closeSessions: async (subjects) => {
          let closed = 0
          for (const s of subjects)
            for (const room of router.activeRooms)
              closed += room.game.revokeSubject(s, Number.MAX_SAFE_INTEGER)
          // Let the closing sockets' character saves land before the rows are erased.
          if (closed) {
            await new Promise((r) => setTimeout(r, 2000))
            await Promise.all(router.activeRooms.map((room) => room.game.drain()))
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
    onRevoked: (subject, validAfterMs) =>
      router.activeRooms.reduce(
        (count, room) => count + room.game.revokeSubject(subject, validAfterMs),
        0,
      ),
    // Account merge (ADR-029): the folded-in account's characters join the survivor's free slots.
    onMerged: async (from, into, mergeId) => {
      const result = await store.identity.mergeSubject(from, into, mergeId, Date.now())
      settleRewards(into)
      return result
    },
    // Account export and deletion (ADR-033): the part goes to Network; a deleted account's sessions close (each
    // close saves its character) before its characters are erased.
    ...(accountData ? { onAccountEvent: (event) => accountData.apply(event as AccountEvent) } : {}),
    // Mod principals (ADR-013): an install's grants follow its principal in Network (a change staff made there).
    onModGrants: async (p) => {
      const view = await mods.applyNetwork(p)
      if (view) await syncScriptView(view)
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
    online: () => router.onlineCount,
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
  // Creator worlds' JSON API (worlds/worldRoutes.ts). State changes run in the router's admission chain.
  const serveWorlds = createWorldRoutes({
    store: creatorWorlds,
    host: {
      online: () => worldHost.online(),
      applyMap: (id, map) => {
        void router.serialize(async () => worldHost.applyMap(id, map))
      },
      changed: (world, id) => router.serialize(() => worldHost.changed(world, id)),
      remove: (id) =>
        router.serialize(async () => {
          await worldHost.changed(null, id)
          await creatorWorlds.remove(id)
        }),
    },
    resolveUser: (token) =>
      config.networkAuthUrl
        ? resolveNetworkUser(config.networkAuthUrl, token)
        : Promise.resolve(null),
    limits: actorLimits,
    address: clientAddress,
    log: log.child({ system: 'worlds' }),
    perPerson: config.creatorWorldsPerPerson,
  })
  // The casual games' JSON API (plan T22).
  const serveCasual = createCasualRoutes({
    db,
    networkAuthUrl: config.networkAuthUrl,
    limits: actorLimits,
    address: clientAddress,
    log: log.child({ system: 'casual' }),
  })
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
        setMapOverride(compileMapFileV2(next), content.world.id)
        for (const room of hub.activeRooms) {
          room.world.reconcileMapTerrain()
          room.world.reconcileMapStatics()
          room.world.reconcileMapZones()
          room.world.reconcileMapNodes()
          room.world.reconcileMapProps()
          room.game.broadcastMapReload()
        }
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
        if (req.method === 'GET' && req.url?.split('?')[0] === '/api/v1/content') {
          const requestedWorld = new URL(req.url ?? '/', 'http://games.local').searchParams.get(
            'world',
          )
          if (requestedWorld !== null) {
            // A creator world: the plain creator pack and no installed packs (the client builds the same set).
            if (!CREATOR_WORLD_ID.test(requestedWorld)) {
              res.writeHead(404, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
              })
              res.end('{"error":"world_not_found"}')
              return true
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(
              JSON.stringify({
                digest: contentForWorld(requestedWorld).digest,
                game: 'creator',
                world: requestedWorld,
                packs: [],
              }),
            )
            return true
          }
          const requested = new URL(req.url ?? '/', 'http://games.local').searchParams.get('game')
          const placeId = router.resolve(requested ?? undefined)
          const selectedContent = contentByPlace.get(placeId)
          if (!selectedContent) throw new Error('place content missing')
          const staticPacks = packs.map(({ mods: _mods, ...pack }) => pack)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(
            JSON.stringify({
              digest: selectedContent.digest,
              game: placeId,
              packs: [
                ...staticPacks,
                {
                  mods: selectedContent.allMods().filter((mod) => !builtInModIds.has(mod.id)),
                },
              ],
            }),
          )
          return true
        }
        if (serveCasual(req, res)) return true
        if (serveWorlds(req, res)) return true
        if (
          handleGameRead(req, res, {
            db,
            boards: playBoards,
            networkAuthUrl: config.networkAuthUrl,
            limits: actorLimits,
            address: (request) => resolveClientAddress(request, config.trustProxy),
          })
        )
          return true
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
                  scripts: { enabled: scripts !== undefined, mods: scripts?.status() ?? [] },
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
          onInstalled: syncScriptView,
          onChanged: syncScriptView,
          reload: async (id, request, actor) => {
            const prior = mods.get(id)
            if (!prior) throw new ModError('mod.not_found', `no mod ${id}`, 404)
            const checked = await mods.checkInstall(request, id)
            if (
              checked.manifest.runtime !== 'games-quickjs@1' ||
              checked.pack.mods?.length !== 1 ||
              prior.pack.mods?.length !== 1
            )
              throw new ModError('mod.pack_invalid', 'reload requires one script mod', 422)
            const script = ScriptModSchema.parse(checked.pack.mods[0])
            const old = ScriptModSchema.parse(prior.pack.mods[0])
            if (script.id !== old.id)
              throw new ModError('mod.pack_invalid', 'script id cannot change on reload', 422)
            if (!content.allMods().some((mod) => mod.id === script.id) || !scripts?.has(script.id))
              throw new ModError(
                'mod.reload_unavailable',
                'script is not running on this instance',
                409,
              )
            const grants = (
              script.capabilities ?? (['players.read', 'world.emit'] as const)
            ).filter((cap) => prior.granted.has(scriptGrant(cap)))
            const pinned = { ...script, granted: grants }
            const prepared: { commit(): void; cancel(): void }[] = []
            for (const host of scriptHosts.values()) {
              const candidate = await host.prepareReload(pinned, grants)
              if (!candidate.ok) {
                for (const priorCandidate of prepared) priorCandidate.cancel()
                throw new ModError('mod.reload_failed', candidate.error, 422)
              }
              prepared.push(candidate)
            }
            try {
              const view = await mods.replace(id, request, actor)
              for (const registryContent of contentByPlace.values())
                registryContent.replaceScriptMod(pinned)
              for (const candidate of prepared) candidate.commit()
              for (const room of router.activeRooms)
                room.game.announce(
                  `Script mod ${script.id} reloaded. New connections must use the updated content set.`,
                )
              return view
            } catch (error) {
              for (const candidate of prepared) candidate.cancel()
              throw error
            }
          },
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
    createGamesIndexNow(
      config.oauth?.selfUrl ?? 'https://openvibe.games',
      config.indexnowKey,
      log.child({ system: 'indexnow' }),
    ),
    config.placeId,
  )
  const drainer = httpDrainer(http)
  world.reconcileMapNodes()
  world.reconcileMapProps()
  const gameWss = attachWebSocket(http, router, {
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
      router.step()
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
      clearInterval(heartbeatTimer)
      clearInterval(worldSweepTimer)
      clearInterval(pruneTimer)
      editors.stop()
      const mirrorDone = mirror?.stop()
      for (const room of router.activeRooms) room.game.announceRestart()
      const [players, editorPeers] = await Promise.all([
        closeSockets(gameWss, SOCKETS_MS),
        closeSockets(editors.wss, SOCKETS_MS),
      ])
      // Mark every session dirty and queue the final checkpoint, then let the whole write-behind queue
      // (that checkpoint plus every disconnect save queued before it) drain.
      const drained = await router.shutdown()
      for (const host of scriptHosts.values()) {
        await host.flushWrites()
        host.dispose()
      }
      const cut = await httpDone
      await within(2000, mirrorDone)
      await within(1000, progressSummary?.settle())
      await within(2000, outbox?.stop())
      await mods.flushWrites()
      await progressWriter.stop()
      inventoryRewards?.stop()
      playSync.stop()
      await within(1000, (async () => { await telemetryRetention.stop(); await telemetry.stop() })())   // request telemetry flushes first
      await store.close()
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
