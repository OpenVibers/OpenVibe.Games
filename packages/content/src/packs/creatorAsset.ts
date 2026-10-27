import { emptyMapV2, parseMapFile, type MapFileV2 } from '../mapFileV2.js'
import { creatorMapIssues, creatorScriptsOf } from './creatorWorld.js'
import type { ScriptMod } from '../schema/scriptMod.js'

/**
 * The asset store (docs/platform-direction.md step 5, free first): what creators publish for others to use in their
 * own worlds. Uploaded models, textures and sounds wait on the Pics safety pipeline, so an asset is made of what a
 * creator world already takes:
 *
 *   - a **build** (`prefab`): pieces placed in the editor (statics, resource nodes, props and lights) with their
 *     positions relative to the build's own origin, the centre of its footprint at ground level. It passes the same
 *     checks as a creator world's map (built-in materials only, no models, textures or paint), with smaller limits.
 *   - a **script** (`script`): one `games-quickjs@1` mod, checked exactly as a world's own scripts are.
 *
 * The server and the editor both use these: the server checks what it stores, the editor places a build with new
 * ids where the person points (placePrefab).
 */

export type CreatorAssetKind = 'prefab' | 'script'
export const CREATOR_ASSET_KINDS: readonly CreatorAssetKind[] = ['prefab', 'script']

/** A creator asset id: `a` and ten lower-case base-36 characters. */
export const CREATOR_ASSET_ID = /^a[0-9a-z]{10}$/

export const CREATOR_ASSET_LIMITS = {
  /** A build's JSON. */
  bytes: 256 * 1024,
  statics: 400,
  nodes: 100,
  props: 100,
  lights: 16,
  /** How far a piece may sit from the build's origin, in metres. */
  reach: 256,
} as const

/** The pieces of a build, positions relative to its origin. */
export interface PrefabBody {
  v: 1
  statics: MapFileV2['statics']
  nodes: MapFileV2['nodes']
  props: MapFileV2['props']
  lights: MapFileV2['lights']
}

export type CreatorAssetBody = PrefabBody | ScriptMod

/** What a build is made of, for lists and cards. */
export function prefabCounts(body: PrefabBody): {
  statics: number
  nodes: number
  props: number
  lights: number
  pieces: number
} {
  const statics = body.statics.length
  const nodes = body.nodes.length
  const props = body.props.length
  const lights = body.lights.length
  return { statics, nodes, props, lights, pieces: statics + nodes + props + lights }
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A build, checked: the body to store (ids and positions as given), or the reasons it cannot be stored. */
export function creatorPrefabOf(raw: unknown): { body: PrefabBody | null; issues: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return {
      body: null,
      issues: ['body: a build is an object with statics, nodes, props and lights'],
    }
  const bytes = new TextEncoder().encode(JSON.stringify(raw)).length
  if (bytes > CREATOR_ASSET_LIMITS.bytes)
    return {
      body: null,
      issues: [`body: ${bytes} bytes is more than the ${CREATOR_ASSET_LIMITS.bytes} a build takes`],
    }
  // The same checks as a creator world's map: the pieces go into an empty one.
  const parsed = parseMapFile({
    ...emptyMapV2(),
    statics: list(r['statics']),
    nodes: list(r['nodes']),
    props: list(r['props']),
    lights: list(r['lights']),
  })
  if (!parsed.ok) return { body: null, issues: parsed.issues.slice(0, 40) }
  const map = parsed.map
  const issues = creatorMapIssues(map, bytes)
  const limit = (what: 'statics' | 'nodes' | 'props' | 'lights', count: number): void => {
    if (count > CREATOR_ASSET_LIMITS[what])
      issues.push(`${what}: ${count} is more than the ${CREATOR_ASSET_LIMITS[what]} a build takes`)
  }
  limit('statics', map.statics.length)
  limit('nodes', map.nodes.length)
  limit('props', map.props.length)
  limit('lights', map.lights.length)
  const body: PrefabBody = {
    v: 1,
    statics: map.statics,
    nodes: map.nodes,
    props: map.props,
    lights: map.lights,
  }
  if (prefabCounts(body).pieces === 0) issues.push('body: a build has at least one piece')
  const far = [...body.statics, ...body.nodes, ...body.props, ...body.lights].find((o) =>
    o.pos.some((v) => Math.abs(v) > CREATOR_ASSET_LIMITS.reach),
  )
  if (far)
    issues.push(
      `${far.id}: more than ${CREATOR_ASSET_LIMITS.reach} m from the build's origin (positions are relative to it)`,
    )
  return issues.length ? { body: null, issues } : { body, issues }
}

/** A script asset, checked as a world's own script is: the mod to store, or the reasons it cannot be stored. */
export function creatorScriptAssetOf(raw: unknown): { body: ScriptMod | null; issues: string[] } {
  const checked = creatorScriptsOf([raw])
  if (checked.issues.length) return { body: null, issues: checked.issues }
  // Stored as the creator wrote it; a world that adds it sets `granted` when it loads.
  const { granted: _granted, ...mod } = checked.scripts[0] as ScriptMod
  return { body: mod as ScriptMod, issues: [] }
}

/** Either kind, by name. */
export function creatorAssetOf(
  kind: unknown,
  raw: unknown,
): { kind: CreatorAssetKind | null; body: CreatorAssetBody | null; issues: string[] } {
  if (kind === 'prefab') return { kind, ...creatorPrefabOf(raw) }
  if (kind === 'script') return { kind, ...creatorScriptAssetOf(raw) }
  return { kind: null, body: null, issues: ['kind: prefab or script'] }
}

type Vec3 = [number, number, number]
type Placed = { pos: Vec3; id: string }

/**
 * Pieces chosen in the editor as a build: their positions made relative to the centre of their footprint at its
 * lowest point, so the build lands on the ground where it is placed. Ids are kept (placing gives new ones).
 */
export function prefabFromObjects(objects: {
  statics?: readonly MapFileV2['statics'][number][]
  nodes?: readonly MapFileV2['nodes'][number][]
  props?: readonly MapFileV2['props'][number][]
  lights?: readonly MapFileV2['lights'][number][]
}): PrefabBody {
  const all: Placed[] = [
    ...(objects.statics ?? []),
    ...(objects.nodes ?? []),
    ...(objects.props ?? []),
    ...(objects.lights ?? []),
  ] as Placed[]
  const axis = (i: 0 | 1 | 2) => all.map((o) => o.pos[i])
  const mid = (values: number[]) =>
    values.length ? (Math.min(...values) + Math.max(...values)) / 2 : 0
  const origin: Vec3 = [mid(axis(0)), all.length ? Math.min(...axis(1)) : 0, mid(axis(2))]
  const round = (v: number) => Math.round(v * 1000) / 1000
  const shift = <T extends Placed>(o: T): T => ({
    ...o,
    pos: [round(o.pos[0] - origin[0]), round(o.pos[1] - origin[1]), round(o.pos[2] - origin[2])],
  })
  return {
    v: 1,
    statics: (objects.statics ?? []).map((o) => shift(o as never)),
    nodes: (objects.nodes ?? []).map((o) => shift(o as never)),
    props: (objects.props ?? []).map((o) => shift(o as never)),
    lights: (objects.lights ?? []).map((o) => shift(o as never)),
  }
}

/**
 * A build placed at `at`: every piece with a new id (from `newId`, given the kind's short prefix) and its position
 * moved by `at`. Answers the pieces by editor kind, ready to add to a document.
 */
export function placePrefab(
  body: PrefabBody,
  at: Vec3,
  newId: (prefix: string) => string,
): { kind: 'static' | 'node' | 'prop' | 'light'; object: Placed & Record<string, unknown> }[] {
  const move = <T extends Placed>(o: T, prefix: string): T => ({
    ...o,
    id: newId(prefix),
    pos: [o.pos[0] + at[0], o.pos[1] + at[1], o.pos[2] + at[2]],
  })
  return [
    ...body.statics.map((o) => ({ kind: 'static' as const, object: move(o as never, 'st') })),
    ...body.nodes.map((o) => ({ kind: 'node' as const, object: move(o as never, 'no') })),
    ...body.props.map((o) => ({ kind: 'prop' as const, object: move(o as never, 'pr') })),
    ...body.lights.map((o) => ({ kind: 'light' as const, object: move(o as never, 'li') })),
  ]
}
