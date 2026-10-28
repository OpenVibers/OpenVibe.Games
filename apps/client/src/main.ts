import {
  CREATOR_WORLD_ID,
  createContent,
  creatorPlaceId,
  creatorWorldPack,
  setMapOverride,
  type MapLight,
  compileMapFileV2,
  emptyMapV2,
  type MapFileV2,
  parseMapFile,
  surfMap,
  surfMapOfPlace,
  surfPack,
  worldSpawn,
  type MapTextureEntry,
  type SurfMapInfo,
} from '@openvibe/content'
import { MapLightLayer, mapDiff, staticWork, terrainWork } from './render/mapRuntimeLayers.js'
import { createRapierWorld, loadRapier } from '@openvibe/physics/rapier'
import { FixedTimestep } from '@openvibe/shared'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { defaultAppearance, type Appearance } from '@openvibe/protocol'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Scene } from '@babylonjs/core/scene.js'
import { WATER_LEVEL, getMapOverride, terrainHeight } from '@openvibe/content'
import {
  DEFAULT_MOVEMENT,
  decodeSurfTrack,
  movementParamsFor,
  movementStyleFor,
} from '@openvibe/gameplay'
import { Sfx, footstepSurface, materialForVisual } from './audio/sfx.js'
import { HitChips } from './render/hitChips.js'
import { InteractionController } from './game/interactionController.js'
import { LocalPlayer } from './game/localPlayer.js'
import { InputTracker } from './input/inputTracker.js'
import { KeyboardInputSource, SwitchableInputSource } from './input/inputSource.js'
import { TopDownInputSource } from './input/topDownInputSource.js'
import { TopDownMarkers } from './render/topDownMarkers.js'
import { TouchControls } from './input/touchControls.js'
import { TouchInputSource, TouchPad } from './input/touchInputSource.js'
import { Connection, gameSocketUrl, getIdentity, saveName } from './net/connection.js'
import { BeamRenderer, type BeamState } from './render/beams.js'
import { EntityView } from './render/entityView.js'
import { Environment } from './render/environment.js'
import { FirstPersonBody } from './render/firstPersonBody.js'
import {
  buildStaticWorld,
  createEngine,
  createScene,
  buildTerrainPatches,
  rebuildTerrainPatchVisuals,
  rebuildMapStaticVisuals,
  registerMapAssets,
  rebuildTerrainVisual,
} from './render/sceneSetup.js'
import {
  applyEngineQuality,
  applySceneQuality,
  qualityForTier,
  readDeviceSignals,
  resolveQualityTier,
  resolveStartupQuality,
} from './render/quality.js'
import { Viewmodel } from './render/viewmodel.js'
import { ClientState } from './state/clientState.js'
import { characterSelect, type CharacterInfo } from './ui/characterSelect.js'
import { customizeScreen } from './ui/customizeScreen.js'
import { Hud } from './ui/hud.js'
import { IconFactory } from './ui/iconFactory.js'
import { registerPhysgunModule } from './weapons/physgunModule.js'
import { registerRiggingModule } from './weapons/riggingModule.js'
import { ConstraintLineRenderer } from './render/constraintLines.js'
import { PlacementGhost } from './game/placementGhost.js'
import { WeaponSettings, weaponModuleFor } from './weapons/registry.js'
import { FirstSteps, towardOf } from './ui/firstSteps.js'
import { Waypoint, pickTarget, type NodeSighting } from './ui/waypoint.js'

/**
 * Client bootstrap: engine/scene -> character customization (live preview)
 * -> connect -> fixed-timestep prediction + interpolated render loop with
 * first-person body, viewmodel and physgun beams.
 */
async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const uiRoot = document.getElementById('ui') as HTMLElement

  const identity = getIdentity()
  const params = new URLSearchParams(location.search)
  const requestedGame = params.get('game')
  // A creator world (/worlds): its own place, the plain creator pack and the world's map.
  const requestedWorld = params.get('world')
  const worldId = requestedWorld && CREATOR_WORLD_ID.test(requestedWorld) ? requestedWorld : null
  // OpenVibe.Surf Ride: /surf/<id> is canonical, and ?map=<id> / ?game=<id>
  // are accepted aliases. A map's place id is the map id (`surf_lagoon`).
  const requestedMap = params.get('map')
  const surfPath = /^\/surf\/([^/]+)\/?$/.exec(location.pathname)?.[1]
  const surfInfo: SurfMapInfo | null =
    (surfPath && surfPath !== 'embed' ? surfMap(surfPath) : null) ??
    (requestedMap ? surfMap(requestedMap) : null) ??
    (requestedGame ? surfMap(requestedGame) : null) ??
    null
  // The old hyphenated forms are aliases only: put the canonical form in the
  // address bar before any fetch. The server sends the same 301.
  if (surfInfo) {
    if (surfPath && surfPath !== 'embed' && surfPath !== surfInfo.id) {
      history.replaceState(null, '', `/surf/${surfInfo.id}${location.search}${location.hash}`)
    } else if (requestedGame && surfMap(requestedGame) && !surfPath) {
      const rest = new URLSearchParams(params)
      rest.delete('game')
      rest.delete('map')
      history.replaceState(
        null,
        '',
        `/surf/${surfInfo.id}${rest.size ? `?${rest.toString()}` : ''}${location.hash}`,
      )
    } else if (requestedMap && requestedMap !== surfInfo.id) {
      params.set('map', surfInfo.id)
      const query = params.toString()
      history.replaceState(
        null,
        '',
        `${location.pathname}${query ? `?${query}` : ''}${location.hash}`,
      )
    }
  }
  const selectedPlace = worldId
    ? creatorPlaceId(worldId)
    : surfInfo
      ? surfInfo.placeId
      : requestedGame === 'salvage-rush' || requestedGame === 'scraplandia'
        ? requestedGame
        : undefined
  const placeQuery = worldId ? `?world=${worldId}` : selectedPlace ? `?game=${selectedPlace}` : ''
  // A draft world's map answers only its owner, so the map read carries the Network token when there is one.
  const mapRequest = (): Promise<Response> => {
    if (!worldId) return fetch(`/map.json${placeQuery}`)
    const token = localStorage.getItem('ovg_sso')
    return fetch(`/api/worlds/${worldId}/map`, {
      cache: 'no-store',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    })
  }
  // How a creator world is seen (migration 0017): 'top' looks straight down on the player, a 2D view of the same world.
  const ssoToken = localStorage.getItem('ovg_sso')
  const worldView: Promise<'3d' | 'top'> = worldId
    ? fetch(`/api/worlds/${worldId}`, {
        cache: 'no-store',
        ...(ssoToken ? { headers: { authorization: `Bearer ${ssoToken}` } } : {}),
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ view?: string }>) : {}))
        .then((w: { view?: string }) => (w.view === 'top' ? 'top' : '3d'))
        .catch(() => '3d' as const)
    : Promise.resolve('3d')
  // Fetch the active definition set before constructing game systems or sending hello.
  // A fresh client can join after a staff script install or reload changed the digest.
  let content = createContent()
  try {
    const response = await fetch(`/api/v1/content${placeQuery}`, { cache: 'no-store' })
    if (response.ok) {
      const data = (await response.json()) as {
        digest?: string
        game?: string
        packs?: Parameters<typeof createContent>[0]
      }
      if (Array.isArray(data.packs)) {
        const contentSurf = data.game ? surfMapOfPlace(data.game) : null
        const builtIn =
          contentSurf
            ? surfPack(contentSurf.id)
            : data.game === 'salvage-rush'
              ? (await import('@openvibe/content/salvage-rush')).SALVAGE_RUSH_PACK
              : data.game === 'creator' && worldId
                ? creatorWorldPack(worldId)
                : undefined
        const active = createContent(data.packs, builtIn)
        if (active.digest === data.digest) content = active
      }
    }
  } catch {
    // The hello digest still refuses a mismatched join if content is unavailable.
  }
  if (requestedGame === 'salvage-rush' && content.world.id !== 'salvage_rush_arena') {
    uiRoot.textContent = 'Salvage Rush content is unavailable. Please retry shortly.'
    return
  }
  if (surfInfo && content.world.id !== surfInfo.id) {
    uiRoot.textContent = 'Surf content is unavailable. Please retry shortly.'
    return
  }
  // Edited map (must match the server's copy for prediction parity).
  // The map as the runtime currently has it, so a reload can diff against
  // it rather than rebuilding every category.
  let liveMap: MapFileV2 = emptyMapV2()
  let mapLightsBoot: MapLight[] | undefined
  try {
    // /map.json is the v2 document, parsed and validated on the way in.
    const parsed = parseMapFile(await (await mapRequest()).json())
    if (parsed.ok) {
      registerMapAssets({
        textures: parsed.map.textures as MapTextureEntry[],
        models: parsed.map.models,
      })
      // The map's statics stay in the override; merging them into
      // content.world.statics made the map layer permanent and unreplaceable.
      setMapOverride(compileMapFileV2(parsed.map))
      liveMap = parsed.map
      mapLightsBoot = parsed.map.lights
    }
  } catch {
    // no edited map — procedural terrain
  }
  const engine = await createEngine(canvas)
  const scene = createScene(engine)
  buildStaticWorld(scene, content)
  buildTerrainPatches(scene, content)
  // One owner for map lights, keyed by document id.
  const mapLights = new MapLightLayer(scene)
  mapLights.reconcile(mapLightsBoot ?? [])

  // Rapier loads while the player customizes their character (dynamic import,
  // so physics is never part of the initial JavaScript).
  const rapierPromise = loadRapier()

  const environment = new Environment(scene, engine)
  environment.setAntialias(resolveStartupQuality().antialias)

  // Render immediately so the customization preview is live.
  let gameLoop: (() => void) | null = null
  let last = performance.now()
  let envLast = performance.now()
  engine.runRenderLoop(() => {
    gameLoop?.()
    if (scene.activeCamera) {
      const now = performance.now()
      environment.update(Math.min((now - envLast) / 1000, 0.25), scene.activeCamera.globalPosition)
      envLast = now
      scene.render()
    }
  })
  window.addEventListener('resize', () => engine.resize())
  // Ctrl+W while crouching would close the tab; the browser won't let us
  // block the shortcut itself, but it will show a leave confirmation.
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault()
  })

  // MMO-style character select: pick an existing scrapper or claim a slot.
  // OpenVibe SSO: a session token can arrive via ?ov_token= (redirect
  // back from OpenVibe) and is remembered; guests play without one.
  const ssoParam = new URLSearchParams(location.search).get('ov_token')
  if (ssoParam) {
    localStorage.setItem('ovg_sso', ssoParam)
    history.replaceState(null, '', location.pathname)
  }
  const ssoCookie = document.cookie
    .split('; ')
    .find((c) => c.startsWith('ovg_sso='))
    ?.slice('ovg_sso='.length)
  const sso =
    localStorage.getItem('ovg_sso') ?? (ssoCookie ? decodeURIComponent(ssoCookie) : undefined)
  let characters: CharacterInfo[] = []
  try {
    const q = `token=${encodeURIComponent(identity.token)}${sso ? `&auth=${encodeURIComponent(sso)}` : ''}`
    characters = (await (await fetch(`/api/characters?${q}`)).json()) as CharacterInfo[]
  } catch {
    characters = []
  }
  // A surf map (OpenVibe.Surf's Ride) goes straight onto the ramp: your first character if you have one, else a surfer
  // with the default look under your saved name. Character select and the customize screen belong to the islands.
  const firstOwn = [...characters].sort((a, b) => a.slot - b.slot)[0] ?? null
  const choice = surfInfo
    ? { slot: firstOwn ? firstOwn.slot : 0, existing: firstOwn }
    : await characterSelect(uiRoot, characters, Boolean(sso))
  let name: string
  let appearance: Appearance
  let releaseCamera: () => void
  if (choice.existing?.appearance) {
    name = choice.existing.name
    appearance = { ...choice.existing.appearance, height: 1, build: 1 }
    releaseCamera = () => {}
  } else if (surfInfo) {
    name = identity.name ?? 'Surfer'
    appearance = defaultAppearance()
    releaseCamera = () => {}
  } else {
    const created = await customizeScreen(scene, content, uiRoot, identity.name, !sso)
    name = created.name
    appearance = created.appearance
    releaseCamera = created.releaseCamera
  }
  const slot = choice.slot
  saveName(name)
  // The player is heading into the world: the page folds the OpenVibe Frame
  // away so the canvas gets the whole viewport (see public/frame.js).
  window.dispatchEvent(new CustomEvent('ovg:playing'))

  const rapier = await rapierPromise
  const physics = createRapierWorld(rapier)
  const { buildStaticPhysics, rebuildTerrainPhysics } = await import('./game/staticPhysics.js')
  buildStaticPhysics(physics, content)

  const state = new ClientState()
  const connection = new Connection()
  const input = new InputTracker(canvas)
  // A surf map starts on a pad above its first ramp: look a little down, so the pad's edge (the drop) is in front.
  if (surfInfo) input.pitch = -0.2
  const view = new EntityView(scene, physics, content, state)
  const icons = new IconFactory(scene, content)
  const weaponSettings = new WeaponSettings()
  registerPhysgunModule()
  registerRiggingModule()
  const hud = new Hud(uiRoot, state, content, connection, icons, weaponSettings, {
    guest: identity.token,
    ...(sso ? { bearer: sso } : {}),
  })
  // Source's chat keys: Y talks to the room, U to the team. Capture-phase so
  // the game never reads them as movement/tool keys; the HUD owns the input
  // and its capture handoff.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (input.uiCapture) return
      if (e.code !== 'KeyY' && e.code !== 'KeyU') return
      e.preventDefault()
      e.stopImmediatePropagation()
      hud.chat.open(e.code === 'KeyY' ? 'say' : 'say_team')
    },
    true,
  )
  // Scraplandia's first-steps checklist (not in Salvage Rush or a creator world, whose worlds are something else).
  let updateWaypoint: (() => void) | null = null
  let firstStepsRef: FirstSteps | null = null
  if (!worldId && content.world.id === 'scrap_island') {
    const firstSteps = new FirstSteps(uiRoot, () => ({
      count: (item) => state.countOf(item),
      level: (skill) => state.skillLevel(skill),
    }))
    state.events.on('inventory', () => firstSteps.update())
    state.events.on('skills', () => firstSteps.update())
    state.events.on('announce', (text) => firstSteps.onAnnounce(String(text)))
    firstStepsRef = firstSteps
    // The waypoint toward the current step's target (refreshed from the frame loop).
    const waypoint = new Waypoint(uiRoot)
    updateWaypoint = () => {
      const step = firstSteps.current()
      const from = { x: player.move.pos.x, z: player.move.pos.z }
      if (!step) return waypoint.update(from, player.viewYaw, null)
      if (step.id === 'haul') {
        const bird = firstSteps.birdAt
        return waypoint.update(
          from,
          player.viewYaw,
          bird ? { label: 'Recovery bird', x: bird[0], z: bird[1] } : null,
        )
      }
      const toward = towardOf(step, firstSteps.view())
      if (!toward) return waypoint.update(from, player.viewYaw, null)
      // Gathering: point at whichever pile gives what is still missing.
      const hasWood = state.countOf('wood_log') > 0 || state.countOf('wood_plank') > 0
      const hasStone = state.countOf('stone') > 0
      const prefer = step.id === 'gather' ? (hasStone ? ['branch_pile'] : hasWood ? ['loose_stones'] : []) : []
      const sightings: NodeSighting[] = []
      // Props the step names (the campfire, the workbench, the trading post) count as sightings too.
      const props = new Set(toward.props ?? [])
      for (const e of state.entities.values()) {
        if (!e.def) continue
        if (e.kind === 'resource') {
          sightings.push({
            def: e.def,
            name: content.nodeType(e.def)?.name ?? e.def,
            x: e.pos[0],
            z: e.pos[2],
            remaining: e.remaining ?? 1,
          })
        } else if (e.kind === 'prop' && props.has(e.def)) {
          sightings.push({ def: e.def, name: content.item(e.def)?.name ?? e.def, x: e.pos[0], z: e.pos[2], remaining: 1 })
        }
      }
      const zones = getMapOverride(content.world)?.zones ?? []
      const wanted = { nodes: [...(toward.nodes ?? []), ...props], ...(toward.zone ? { zone: toward.zone } : {}), prefer }
      waypoint.update(from, player.viewYaw, pickTarget(from, wanted, sightings, zones))
    }
  }
  const roundUi =
    content.world.id === 'salvage_rush_arena'
      ? await import('./ui/salvageRushHud.js').then(
          ({ SalvageRushHud }) => new SalvageRushHud(uiRoot, scene),
        )
      : null
  const surfUi = surfInfo
    ? await import('./ui/surfHud.js').then(({ SurfHud }) => new SurfHud(uiRoot))
    : null
  hud.onQualityChange = (override) => {
    const quality = qualityForTier(resolveQualityTier(override, readDeviceSignals()))
    applyEngineQuality(engine, quality)
    applySceneQuality(scene, quality)
    environment.setAntialias(quality.antialias)
  }

  // Touch on a coarse pointer, keyboard otherwise; a device with both
  // switches to whichever was used last, carrying the view angle across.
  const keyboardSource = new KeyboardInputSource(input)
  const touchPad = new TouchPad()
  const touchSource = new TouchInputSource(touchPad)
  const touchControls = new TouchControls(uiRoot, canvas, touchPad)
  const surfTrainer = surfInfo
    ? await import('./ui/surfTrainer.js').then(
        ({ SurfTrainer }) =>
          new SurfTrainer(uiRoot, canvas, touchPad, () => {
            surfUi?.hideFinish()
            connection.send({ t: 'surf_restart' })
          }),
      )
    : null
  if (surfInfo) void import('./ui/surfTrainer.css')
  const switchable = new SwitchableInputSource(keyboardSource)
  // From above, WASD (or the stick) moves along the screen and the mouse aims; see topDownInputSource.ts.
  const topDown = (await worldView) === 'top'
  const pointerOffset = { x: 0, y: 0, known: false }
  if (topDown)
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return
      const rect = canvas.getBoundingClientRect()
      pointerOffset.x = e.clientX - (rect.left + rect.width / 2)
      pointerOffset.y = e.clientY - (rect.top + rect.height / 2)
      pointerOffset.known = true
    })
  const inputSource = topDown
    ? new TopDownInputSource(switchable, () => (pointerOffset.known ? pointerOffset : null))
    : switchable
  const useTouch = (touch: boolean): void => {
    const next = touch ? touchSource : keyboardSource
    if (switchable.current === next) return
    if (touch) {
      touchPad.yaw = input.yaw
      touchPad.pitch = input.pitch
      input.exitLock()
    } else {
      input.yaw = touchPad.yaw
      input.pitch = touchPad.pitch
    }
    switchable.current = next
    if (touch) pointerOffset.known = false
    touchControls.setActive(touch && !surfInfo)
    surfTrainer?.setActive(touch && !!surfInfo)
  }
  useTouch(matchMedia('(pointer: coarse)').matches)
  // Capture phase: the switch happens before the press is handled.
  document.addEventListener('pointerdown', (e) => useTouch(e.pointerType === 'touch'), true)
  document.addEventListener(
    'keydown',
    (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (!input.uiCapture && !typing) useTouch(false)
    },
    true,
  )

  const world = content.world
  const placeSpawn = worldSpawn(world)
  const player = new LocalPlayer(
    scene,
    physics,
    inputSource,
    connection,
    state,
    {
      x: placeSpawn.pos[0],
      y: placeSpawn.pos[1],
      z: placeSpawn.pos[2],
    },
    movementParamsFor(movementStyleFor(content.world)),
  )
  scene.activeCamera = player.camera
  releaseCamera()
  environment.attachCamera(player.camera)
  const interact = new InteractionController(
    physics,
    player,
    view,
    state,
    content,
    connection,
    input,
    weaponSettings,
  )
  // Debug handles for the automated visual/E2E harness.
  ;(window as unknown as Record<string, unknown>).__openvibe = {
    input,
    interact,
    state,
    connection,
    player,
    icons,
  }
  const fpBody = new FirstPersonBody(scene, content, appearance, player, state)
  const viewmodel = new Viewmodel(scene, content, player.camera, appearance)
  if (topDown) {
    // About 20 m of the world from the top of the screen to the bottom: the player, what is in reach, and the way on.
    player.setTopDown(20)
    input.pointerLock = false
    fpBody.setThirdPerson(true)
    viewmodel.setEnabled(false)
    environment.hazeFog = false
    hud.setCrosshair(false)
  }
  // A surf run is the ramps and the clock: no hands or held tool, and no survival bars or hotbar (surfHud.css hides
  // those under .ovg-surf).
  if (surfInfo) {
    viewmodel.setEnabled(false)
    uiRoot.classList.add('ovg-surf')
  }
  // From above, a ring under each player (yours blue) shows who is where and which way each one faces.
  const markers = topDown ? new TopDownMarkers(scene, state, view, player) : null
  const beams = new BeamRenderer(scene)
  const constraintLines = new ConstraintLineRenderer(scene, state, view)
  const ghost = new PlacementGhost(scene, physics, content)
  const surfGhost = surfInfo
    ? await import('./game/surfGhost.js').then(({ SurfGhost }) => new SurfGhost(scene))
    : null
  const surfGhostHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {}
    if (sso) headers.authorization = `Bearer ${sso}`
    else headers['x-guest-token'] = identity.token
    return headers
  }
  const loadSurfGhost = async (of: 'pb' | 'wr'): Promise<boolean> => {
    if (!surfInfo || !surfGhost) return false
    try {
      const response = await fetch(
        `/api/surf/maps/${encodeURIComponent(surfInfo.id)}/ghost?of=${of}`,
        { cache: 'no-store', headers: surfGhostHeaders() },
      )
      if (!response.ok) return false
      const bytes = new Uint8Array(await response.arrayBuffer())
      surfGhost.setTrack(decodeSurfTrack(bytes))
      return true
    } catch {
      return false
    }
  }
  if (surfUi && surfGhost) {
    surfUi.onRestart = () => {
      surfUi.hideFinish()
      connection.send({ t: 'surf_restart' })
    }
    surfUi.onWatchWr = () => {
      surfGhost.setVisible(true)
      void loadSurfGhost('wr')
    }
    // Your PB is the default ghost; the WR is the fallback before your first run.
    void loadSurfGhost('pb').then((ok) => (ok ? true : loadSurfGhost('wr')))
  }
  // Ride's keys. Capture-phase: InputTracker would otherwise read R as
  // reload and G as drop, neither of which exists in a surf place.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!surfInfo) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (input.uiCapture) return
      if (e.code !== 'KeyR' && e.code !== 'KeyG') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.code === 'KeyR') {
        surfUi?.hideFinish()
        connection.send({ t: 'surf_restart' })
      } else {
        const on = surfGhost?.toggle() ?? false
        hud.toast(on ? 'Ghost on' : 'Ghost off', false)
      }
    },
    true,
  )
  interact.placementPose = () => (ghost.valid ? ghost.pose : null)
  interact.onPlacementRotate = (delta) => ghost.rotate(delta)

  // Tracer pool: each shot flashes a bright beam for ~90 ms.
  const tracers: { key: string; until: number; beam: BeamState }[] = []
  let tracerSeq = 0
  state.events.on('tracer', ({ from, to, hit }) => {
    tracers.push({
      key: `tracer:${tracerSeq++}`,
      until: performance.now() + 90,
      beam: {
        from: new Vector3(from[0], from[1], from[2]),
        to: new Vector3(to[0], to[1], to[2]),
        latched: true,
      },
    })
    if (hit) hud.flashHitmarker()
  })

  interact.onSwing = () => {
    viewmodel.triggerSwing()
    fpBody.triggerSwing()
  }

  // Sounds. Browsers start audio only after a gesture: the first click or key.
  const sfx = new Sfx()
  const chips = new HitChips(scene)
  const unlockAudio = (): void => sfx.unlock()
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)
  hud.volume = () => sfx.getVolume()
  hud.onVolumeChange = (v) => sfx.setVolume(v)
  interact.onMelee = (target) => {
    sfx.swing()
    if (!target) return
    const material =
      target.kind === 'resource'
        ? materialForVisual(content.nodeType(target.def ?? '')?.visual)
        : target.kind === 'player' || target.kind === 'npc'
          ? 'flesh'
          : target.def && content.item(target.def)?.health
            ? 'wood'
            : null
    // The blow lands mid-swing, after the whoosh starts: its sound, and what flies off.
    if (material)
      setTimeout(() => {
        sfx.hit(material)
        chips.burst(target.point, target.normal, material, player.eye)
      }, 90)
  }
  let packCount = -1
  state.events.on('inventory', () => {
    const count = (state.inventory?.slots ?? []).reduce((n, s) => n + (s.stack?.count ?? 0), 0)
    if (packCount >= 0 && count > packCount) sfx.pickup()
    packCount = count
  })
  state.events.on('levelUp', () => sfx.levelUp())
  state.events.on('fx', ({ kind, id }) => {
    if (id === state.myEntityId && (kind === 'hurt' || kind === 'death')) sfx.hurt()
  })
  let stride = 0
  let lastWaypoint = 0
  let wasGrounded = true
  let fallSpeed = 0

  hud.onUiCaptureChange = (captured) => {
    input.uiCapture = captured
    touchControls.setUiCapture(captured)
    if (captured) input.exitLock()
    // Straight back into the game when the menu closes; touch never locks.
    else if (switchable.current === keyboardSource) input.requestLock()
  }
  input.onAction = (action) => {
    switch (action.kind) {
      case 'toggle_menu':
        hud.toggleMenu()
        return
      case 'hotbar1':
      case 'hotbar2':
      case 'hotbar3':
      case 'hotbar4':
      case 'hotbar5':
      case 'hotbar6': {
        const slot = Number(action.kind.slice(-1)) - 1
        connection.send({ t: 'hotbar', slot })
        // Mirror the server's toggle rules: same slot = holster/unholster.
        if (slot === state.activeHotbar) {
          state.holstered = !state.holstered
        } else {
          state.activeHotbar = slot
          state.holstered = false
        }
        interact.onHotbarChanged()
        hud.renderHotbar()
        sfx.click()
        return
      }
      default:
        interact.handle(action)
    }
  }
  // Touch buttons and look drags route exactly like their mouse/keyboard twins.
  touchPad.onAction = (action) => input.onAction?.(action)
  touchPad.captureLook = () => input.captureLook?.() ?? false
  interact.onShopOpen = (targetId) => hud.openShop(targetId)
  input.onWheel = (delta) => interact.onWheel(delta)

  state.events.on('actionResult', (r) => {
    // A drink the server accepted (eating answers the same action, so only right after this client asked to drink).
    if (r.action === 'consume' && r.ok && Date.now() - interact.lastDrinkAt < 3000) firstStepsRef?.onDrink()
    if (r.action === 'use' && r.ok && interact.lastTargetWasPlayer) {
      interact.lastTargetWasPlayer = false
      hud.flashHitmarker()
    }
  })
  let rejected = false
  connection.onMessage = (msg) => {
    if (msg.t === 'salvage_round') roundUi?.update(msg)
    if (msg.t === 'surf_state') surfUi?.updateState(msg)
    if (msg.t === 'surf_finish') {
      surfUi?.showFinish(msg)
      // The just-finished run may be the new PB: refresh its ghost.
      setTimeout(() => void loadSurfGhost('pb'), 750)
    }
    if (msg.t === 'welcome' && state.myEntityId && msg.instanceId !== state.instanceId) {
      player.onTransfer()
    }
    state.apply(msg)
    if (msg.t === 'transfer_result') {
      hud.toast(
        msg.accepted
          ? `Moved to ${msg.instanceId}`
          : `Transfer refused: ${msg.reason ?? 'unavailable'}`,
        !msg.accepted,
      )
    }
    if (msg.t === 'map_reload') {
      void (async () => {
        try {
          const parsed = parseMapFile(await (await mapRequest()).json())
          if (!parsed.ok) return
          registerMapAssets({
            textures: parsed.map.textures as MapTextureEntry[],
            models: parsed.map.models,
          })
          // ONE diff, handed to each layer. Rebuilding every category
          // wholesale re-uploaded the whole map's geometry to move one box,
          // and rebuilt collision the player was standing on.
          const diff = mapDiff(liveMap, parsed.map)
          const previousHadNoTerrain = liveMap.terrains.length === 0
          liveMap = parsed.map
          setMapOverride(compileMapFileV2(parsed.map))
          ghost.refreshZones()

          const terrain = terrainWork(diff)
          if (terrain.added.length || terrain.removed.length || terrain.collision.length) {
            // Prediction collision reconciles by id internally.
            rebuildTerrainPhysics(physics, content)
          }
          if (previousHadNoTerrain !== (parsed.map.terrains.length === 0)) {
            // The base world's procedural mesh only exists with no map.
            rebuildTerrainVisual(scene, content)
          }
          const terrainVisuals = [...terrain.added, ...terrain.collision, ...terrain.appearanceOnly]
          if (terrainVisuals.length || terrain.removed.length)
            rebuildTerrainPatchVisuals(scene, content, [...terrainVisuals, ...terrain.removed])

          const statics = staticWork(diff)
          const staticVisuals = [
            ...statics.added,
            ...statics.collision,
            ...statics.appearanceOnly,
            ...statics.removed,
          ]
          if (staticVisuals.length) rebuildMapStaticVisuals(scene, staticVisuals)

          mapLights.reconcileFromDiff(diff, parsed.map.lights)
        } catch {
          // keep the old map if the fetch fails
        }
      })()
    }
    if (msg.t === 'time') {
      environment.setDayFraction(msg.frac)
      environment.setWeather(msg.weather)
      sfx.setWeather(msg.weather)
    }
    if (msg.t === 'snap') {
      player.onSnapshot(msg)
      view.onSnapshot(msg, performance.now() / 1000)
    } else if (msg.t === 'reject') {
      rejected = true
      if (msg.reason === 'protocol_mismatch') {
        // A stale cached bundle is talking to a newer server. A reload
        // revalidates the page and pulls the new client. Guard against a
        // reload loop if something still pins the old version.
        const last = Number(localStorage.getItem('openvibe.reload_ts') ?? '0')
        if (Date.now() - last > 60_000) {
          localStorage.setItem('openvibe.reload_ts', String(Date.now()))
          hud.setStatus('game updated — loading the new version…')
          hud.toast('Game updated! Reloading…', false)
          setTimeout(() => location.reload(), 1200)
        } else {
          hud.setStatus('version mismatch — hard-refresh (Ctrl+Shift+R) to update')
        }
      } else if (msg.reason === 'invalid_hello') {
        // Something we sent no longer fits the server's schema (stale
        // saved session/appearance). Shed the stored state and retry once.
        localStorage.removeItem('ovg_sso')
        document.cookie = 'ovg_sso=; Path=/; Max-Age=0'
        localStorage.removeItem('openvibe.appearance')
        const last = Number(localStorage.getItem('openvibe.reload_ts') ?? '0')
        if (Date.now() - last > 60_000) {
          localStorage.setItem('openvibe.reload_ts', String(Date.now()))
          hud.setStatus('session data was out of date — reloading…')
          setTimeout(() => location.reload(), 1200)
        } else {
          hud.setStatus('could not join — try signing in again from the home page')
        }
      } else if (msg.reason === 'guest_one_character') {
        hud.setStatus('this server keeps one character per guest — sign in with OpenVibe to keep more')
      } else if (msg.reason === 'auth_failed' || msg.reason === 'signed_out') {
        localStorage.removeItem('ovg_sso')
        hud.setStatus(
          msg.reason === 'signed_out'
            ? 'You signed out of OpenVibe everywhere — refresh to continue as guest or sign in again'
            : 'OpenVibe sign-in expired — refresh to continue as guest or sign in again',
        )
      } else {
        hud.setStatus(`rejected: ${msg.reason} — refresh the page`)
      }
    }
  }
  // Deploys restart the server: wait until it answers /healthz, then reload (a full clean resync).
  const reloadWhenServerIsBack = (): void => {
    const poll = setInterval(() => {
      fetch('/healthz')
        .then((r) => {
          if (r.ok) {
            clearInterval(poll)
            location.reload()
          }
        })
        .catch(() => {})
    }, 2000)
  }
  connection.onClose = (code) => {
    if (rejected) return
    if (code === 4005) {
      // A creator world that is not open: unpublished, taken down, or every world slot is busy. Reloading would
      // only ask again, so say so and leave the way back.
      rejected = true
      hud.setStatus(
        'This world is not open right now. It may be busy or unpublished: try again in a minute.',
      )
      hud.toast('World not open — see /worlds', true)
      return
    }
    // Come back on our own instead of freezing on a dead socket.
    hud.setStatus('connection lost — reconnecting automatically…')
    hud.toast('Disconnected — reconnecting…', true)
    reloadWhenServerIsBack()
  }

  hud.setStatus('connecting…')
  try {
    await connection.connect(
      gameSocketUrl(),
      identity.token,
      name,
      appearance,
      content.digest,
      slot,
      sso,
      selectedPlace,
    )
  } catch {
    // Refused or timed out (a page opened during a restart): wait for the server, then reload.
    hud.setStatus('could not reach the server — retrying automatically…')
    reloadWhenServerIsBack()
    return
  }

  let wasSubmerged = false

  // Fixed-timestep prediction; interpolated rendering. A room's welcome carries
  // its own rate (30 default, 100 surf), so a transfer/reset rebuilds the
  // accumulator instead of keeping the previous room's step.
  let timestep = new FixedTimestep(1 / state.tickRate)
  state.events.on('welcome', () => {
    if (timestep.dt !== 1 / state.tickRate) timestep = new FixedTimestep(1 / state.tickRate)
  })
  gameLoop = () => {
    const now = performance.now()
    const elapsed = Math.min((now - last) / 1000, 0.25)
    last = now
    if (!connection.open || !state.myEntityId) return

    const steps = timestep.consume(elapsed)
    for (let i = 0; i < steps; i++) {
      player.fixedUpdate()
      interact.flushTick()
    }
    physics.step(0) // query-only world: refresh broadphase, no dynamics
    player.frameUpdate(timestep.alpha, elapsed)
    if (surfUi) {
      surfUi.setSpeed(Math.hypot(player.move.vel.x, player.move.vel.z))
      surfUi.tick(now)
      surfGhost?.update(surfUi.elapsedNow(now))
    }
    view.update(now / 1000)
    markers?.update()

    // First-person presentation: body, viewmodel, beams.
    const selfHolding = [...state.heldBy.values()].includes(state.myEntityId)
    fpBody.update(elapsed, now / 1000, player.renderPos, selfHolding)
    const speed = Math.hypot(player.move.vel.x, player.move.vel.z)
    const look = input.consumeLookDelta()
    viewmodel.setItem(state.activeItemDef())
    viewmodel.update(elapsed, speed, player.move.grounded, look.dx, look.dy)

    // Footsteps on the viewmodel's bob (one step per half bob cycle), a jump, a landing.
    const grounded = player.move.grounded
    if (grounded) {
      if (!wasGrounded && fallSpeed > 3) sfx.land((fallSpeed - 3) / 9)
      stride += speed * elapsed
      if (speed < 0.3) stride = STEP_METRES * 0.7
      if (stride >= STEP_METRES) {
        stride -= STEP_METRES
        const pos = player.move.pos
        sfx.footstep(
          footstepSurface(
            pos.y - DEFAULT_MOVEMENT.capsuleHeight / 2,
            terrainHeight(content.world, pos.x, pos.z),
            WATER_LEVEL,
          ),
          speed > DEFAULT_MOVEMENT.maxGroundSpeed + 0.5,
        )
      }
    } else {
      if (wasGrounded && player.move.vel.y > 1) sfx.jump()
      fallSpeed = Math.max(0, -player.move.vel.y)
    }
    wasGrounded = grounded
    sfx.update(elapsed, environment.daylight)
    if (updateWaypoint && now - lastWaypoint > 150) {
      lastWaypoint = now
      updateWaypoint()
    }
    chips.update(elapsed)

    // Beams (modular: any weapon whose module declares firesBeam gets this
    // muzzle-anchored beam pipeline). Mine fires whenever the trigger is
    // held (dim searching ray → bright latched beam anchored to the exact
    // grab point); other players' render only while they hold props.
    const activeBeams = new Map<string, BeamState>()
    for (const [target, holder] of state.heldBy) {
      if (holder === state.myEntityId) continue
      const to = view.grabPointOf(target, state.heldGrab.get(holder))
      const from = view.avatarFor(holder)?.beamOrigin()
      if (from && to) activeBeams.set(holder, { from, to, latched: true })
    }
    const activeModule = weaponModuleFor(interact.equippedToolKind())
    if (activeModule?.firesBeam && interact.physgunActive) {
      const heldTarget = [...state.heldBy.entries()].find(
        ([, holder]) => holder === state.myEntityId,
      )?.[0]
      const heldPos = heldTarget
        ? view.grabPointOf(heldTarget, state.heldGrab.get(state.myEntityId))
        : null
      player.viewDir(_viewFwd)
      _viewFwdV.set(_viewFwd.x, _viewFwd.y, _viewFwd.z)
      if (heldPos) {
        activeBeams.set(state.myEntityId, {
          from: topDown ? fpBody.beamOrigin() : viewmodel.beamOrigin(),
          to: heldPos,
          tangent: _viewFwdV,
          latched: true,
        })
      } else {
        interact.beamTarget(_beamEnd)
        _beamEndV.set(_beamEnd.x, _beamEnd.y, _beamEnd.z)
        activeBeams.set(state.myEntityId, {
          from: topDown ? fpBody.beamOrigin() : viewmodel.beamOrigin(),
          to: _beamEndV,
          tangent: _viewFwdV,
          latched: false,
        })
      }
    }
    // Bullet tracers: short-lived bright beams riding the same renderer.
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i]!
      if (performance.now() > tr.until) tracers.splice(i, 1)
      else activeBeams.set(tr.key, tr.beam)
    }
    beams.update(elapsed, activeBeams)

    // Rope/spring visuals + rigging first-pick highlight.
    constraintLines.update()
    view.selectedId = interact.riggingFirst?.entityId ?? null

    // Placement ghost follows the crosshair while a placeable is equipped.
    ghost.update(
      state.activeItemDef(),
      player.eye,
      (out) => player.viewDir(out),
      player.viewYaw,
      input.shiftHeld,
    )

    // Underwater: dense teal fog while the camera is submerged (weather
    // haze yields via environment.underwater).
    const submerged = !topDown && player.eye.y < WATER_LEVEL
    environment.underwater = submerged
    sfx.setUnderwater(submerged)
    if (submerged !== wasSubmerged) {
      wasSubmerged = submerged
      if (submerged) {
        scene.fogMode = Scene.FOGMODE_EXP2
        scene.fogDensity = 0.09
        scene.fogColor = new Color3(0.08, 0.25, 0.3)
      } else {
        scene.fogMode = Scene.FOGMODE_NONE
      }
    }

    hud.setPrompt(promptFor(interact, content, state))
    hud.setStatus(
      `${name} · tick ${state.serverTick} · ${engine.getFps().toFixed(0)} fps · ${state.entities.size} entities`,
    )
  }
}

/** Metres walked per footstep: the viewmodel bobs once per step at this stride (phase += speed * 1.6). */
const STEP_METRES = Math.PI / 1.6

const _beamEnd = { x: 0, y: 0, z: 0 }
const _beamEndV = new Vector3()
const _viewFwd = { x: 0, y: 0, z: 0 }
const _viewFwdV = new Vector3()

/** Context-sensitive crosshair prompt based on aim target + equipped tool. */
function promptFor(
  interact: InteractionController,
  content: ReturnType<typeof createContent>,
  state: ClientState,
): string | null {
  // Behind the wheel, one prompt matters.
  if (interact.drivingId()) return 'WASD — drive · E — dismount'
  const target = interact.aim()
  const tool = interact.equippedToolKind()
  // Placement mode owns the prompt while a placeable is in hand.
  const heldId = state.activeItemDef()
  const heldItem = heldId ? content.item(heldId) : undefined
  if (heldItem?.placeable && heldItem.world && !tool) {
    return 'LMB — place · wheel — rotate · Shift — snap · G — toss'
  }
  // Ranged weapon: ammo readout owns the prompt.
  if (heldItem?.rangedWeapon) {
    const slot = state.inventory?.slots.find((s) => s.i === state.activeHotbar)
    const mag = Number(slot?.stack.meta?.mag ?? 0)
    const reserve = state.countOf(heldItem.rangedWeapon.ammoItem)
    return `LMB — fire · R — reload · ${mag}/${heldItem.rangedWeapon.magazine} (${reserve})`
  }
  if (!target) {
    if (interact.standingInWater()) {
      const held = state.activeItemDef()
      if (held && content.item(held)?.fluidContainer) return 'E — fill the can'
      return 'E — drink'
    }
    return null
  }
  if (target.kind === 'resource') {
    const nodeType = content.nodeType(target.def ?? '')
    if (!nodeType) return null
    const itemName = content.item(nodeType.item)?.name ?? nodeType.item
    // An empty node used to keep saying "E — gather …" while E did nothing (the gate piles empty fast when several
    // new scrappers arrive at once).
    if ((state.entities.get(target.entityId)?.remaining ?? 1) <= 0) {
      const back = Math.max(1, Math.round(nodeType.respawnSeconds / 60))
      const gone = nodeType.visual === 'tree' ? 'felled, grows back' : 'picked clean, back'
      return `${nodeType.name} — ${gone} within ${back} min${back === 1 ? '' : 's'}`
    }
    if (nodeType.requiredTool && tool !== nodeType.requiredTool) {
      return `LMB — hit for ${itemName} (much faster with ${nodeType.requiredTool})`
    }
    if (nodeType.requiredTool) return `LMB — harvest ${itemName}`
    return `E — gather ${itemName}`
  }
  if (target.kind === 'player') {
    const entity = state.entities.get(target.entityId)
    return `${entity?.name ?? 'scrapper'}${tool && tool !== 'physgun' ? ' — LMB attack' : ''}`
  }
  if (target.kind === 'npc') {
    const arch = content.npc(target.def ?? '')
    const stance = arch ? content.faction(arch.faction)?.playerStance : undefined
    // Town folk and wardens are friendly: their name, not an invitation to hit them (a swing still lands).
    if (stance === 'friendly') return arch?.name ?? 'stranger'
    return `${arch?.name ?? 'stranger'}${stance === 'hostile' ? ' ⚠ — LMB attack' : ' — LMB hunt'}`
  }
  if (target.kind === 'prop') {
    if (tool === 'rigging') {
      return interact.riggingFirst
        ? 'LMB — link to this prop · RMB — cancel'
        : 'LMB — pick first point · RMB — cut links'
    }
    if (target.def && content.item(target.def)?.container) {
      return 'E — open storage'
    }
    if (target.def && content.item(target.def)?.door && target.frozen) {
      return 'E — open / close door'
    }
    if (target.def && content.item(target.def)?.shop) {
      return 'E — trade with the merchant'
    }
    if (target.def && content.item(target.def)?.planter) {
      const entity = state.entities.get(target.entityId)
      const held = state.activeItemDef()
      const heldItem = held ? content.item(held) : undefined
      if (entity?.plant) {
        if (heldItem?.fluidContainer) return 'E — water the plant'
        if (heldItem?.fertilizer) return 'E — fertilize'
        if (entity.plant.t >= 1) return 'E — harvest'
        return entity.plant.water <= 0 ? '🥀 thirsty — needs water' : '🌱 growing…'
      }
      if (heldItem?.seed) return 'E — plant seeds'
    }
    if (target.def && content.item(target.def)?.waterTank) {
      const held = state.activeItemDef()
      if (held && content.item(held)?.fluidContainer) return 'E — fill / pour water'
    }
    if (target.def && content.item(target.def)?.vehiclePart?.part === 'chassis') {
      return 'E — drive (needs 2 rigged wheels + fuel in the trunk)'
    }
    if (interact.physgunActive)
      return 'RMB — freeze · E — rotate · Shift — grid · wheel — push/pull'
    const entity = state.entities.get(target.entityId)
    // Damaged structures show their state; the right material repairs.
    const healthCap = target.def ? content.item(target.def)?.health : undefined
    if (healthCap && entity?.health !== undefined && entity.health < healthCap.max) {
      const held = state.activeItemDef()
      const label = `${Math.max(0, Math.round(entity.health))}/${healthCap.max}`
      if (healthCap.repair && held === healthCap.repair.item) {
        return `E — repair (${label})`
      }
      const mat = healthCap.repair
        ? (content.item(healthCap.repair.item)?.name ?? healthCap.repair.item)
        : null
      return mat ? `Damaged ${label} — repair with ${mat}` : `Damaged ${label}`
    }
    const owned = entity?.owner !== undefined && entity.owner !== state.myPlayerId
    if (owned) return 'Owned by another player'
    const itemName = content.item(target.def ?? '')?.name ?? 'prop'
    if (tool === 'physgun')
      return `Hold LMB — grab${target.frozen ? ' (unfreezes)' : ''} · E — pick up`
    return `E — pick up ${itemName}`
  }
  return null
}

start().catch((err: unknown) => {
  console.error('client fatal:', err)
  const status = document.createElement('div')
  status.className = 'status'
  status.textContent = `fatal: ${String(err)}`
  document.getElementById('ui')?.appendChild(status)
})
