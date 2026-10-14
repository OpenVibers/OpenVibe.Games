/**
 * Babylon's core in layers (plan M6; ADR-0007 decision 7: largest chunk ≤ 400 KB).
 *
 * Left to itself Rollup puts every vendor module the play and editor pages share into one chunk (2.09 MB: engines,
 * materials, meshes, maths). A split by Babylon folder was tried and refused: folders import each other both ways, so
 * the chunks imported each other in a circle, and naming whole folders pulled the lazily loaded shaders into the
 * initial graph.
 *
 * Layers avoid both. Each layer is the static dependency closure of a few seed modules, minus every earlier layer, so a
 * layer only ever imports from itself and the layers before it: the chunks form a chain, never a circle. And only the
 * modules both pages already load statically are placed (the vendor code of the old shared chunk); everything a page
 * imports lazily (shaders, loaders, the WebGPU engine, particles) is left to Rollup, exactly as before. Babylon's
 * static graph has no cycle of any size, which is what makes the closures small.
 *
 * Measured 2026-10-14 (built): the largest layer is 350 KB (the rest), then post-processing 309, meshes 299, scene 201,
 * maths 158, engine 157; play's initial JS 2.02 MB (511 KB gzip). The layers hold vendor code only, so a Games
 * deploy that changes no dependency leaves their file names, and the browser's copies of them, as they were.
 */

type ModuleInfo = { isEntry: boolean; importedIds: readonly string[] } | null
interface ChunkApi {
  getModuleInfo(id: string): ModuleInfo
  getModuleIds(): IterableIterator<string>
}

/** The layers in order: a name and the modules whose static closure it takes. */
export const LAYERS: readonly (readonly [string, readonly RegExp[]])[] = [
  [
    'vendor-maths',
    [
      /@babylonjs\/core\/Maths\//,
      /@babylonjs\/core\/Misc\/observable/,
      /@babylonjs\/core\/Misc\/tools\.pure/,
    ],
  ],
  [
    'vendor-engine',
    [
      /@babylonjs\/core\/Engines\/engine\.pure/,
      /@babylonjs\/core\/Materials\/effect\.pure/,
      /@babylonjs\/core\/node\.pure/,
    ],
  ],
  ['vendor-scene', [/@babylonjs\/core\/scene\.pure/]],
  [
    'vendor-meshes',
    [/@babylonjs\/core\/Meshes\/abstractMesh\.pure/, /@babylonjs\/core\/Meshes\/mesh\.pure/],
  ],
  ['vendor-materials', [/@babylonjs\/core\/Materials\/standardMaterial\.pure/]],
  ['vendor-post', [/@babylonjs\/core\/PostProcesses\//]],
  ['vendor-cameras', [/@babylonjs\/core\/Cameras\//]],
  ['vendor-lights', [/@babylonjs\/core\/Lights\//, /@babylonjs\/core\/Rendering\//]],
]
/** Whatever vendor code both pages load that no layer took. */
export const REST = 'vendor-rest'

const VENDOR = /[\\/]node_modules[\\/]/
const PAGES = [/[\\/]play\.html$/, /[\\/]editor\.html$/]
const PRELOAD_HELPER = /vite\/preload-helper/

/** Every module `from` reaches by static imports (itself included). */
function staticClosure(api: ChunkApi, from: Iterable<string>, within?: Set<string>): Set<string> {
  const seen = new Set<string>()
  const stack = [...from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id) || (within && !within.has(id))) continue
    seen.add(id)
    for (const dep of api.getModuleInfo(id)?.importedIds ?? []) stack.push(dep)
  }
  return seen
}

/** Module id → layer name, for the vendor modules both pages load statically. */
export function computeLayers(api: ChunkApi): Map<string, string> {
  const ids = [...api.getModuleIds()]
  const pages = PAGES.map((page) =>
    ids.find((id) => page.test(id) && api.getModuleInfo(id)?.isEntry),
  )
  const layerOf = new Map<string, string>()
  if (pages.some((p) => p === undefined)) return layerOf
  const [play, editor] = pages.map((p) => staticClosure(api, [p!]))
  const shared = new Set([...play!].filter((id) => VENDOR.test(id) && editor!.has(id)))
  for (const [name, seeds] of LAYERS) {
    const from = [...shared].filter((id) => seeds.some((s) => s.test(id)))
    for (const id of staticClosure(api, from, shared)) if (!layerOf.has(id)) layerOf.set(id, name)
  }
  for (const id of shared) if (!layerOf.has(id)) layerOf.set(id, REST)
  // Vite's preload helper (behind every lazy import, in every layer) has no imports of its own: it goes in the first
  // layer. Left to Rollup it joined the last one, and every layer imported that one back.
  const helper = ids.find((id) => PRELOAD_HELPER.test(id))
  if (helper && layerOf.size > 0) layerOf.set(helper, LAYERS[0]![0])
  return layerOf
}

/** `build.rollupOptions.output.manualChunks`: the layer of a shared vendor module; everything else is Rollup's. */
export function vendorLayers(): (id: string, api: ChunkApi) => string | undefined {
  let layerOf: Map<string, string> | null = null
  return (id, api) => {
    layerOf ??= computeLayers(api)
    return layerOf.get(id)
  }
}
