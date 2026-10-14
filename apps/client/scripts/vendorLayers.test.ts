/**
 * The layering's two promises (scripts/vendorLayers.ts) on a synthetic module graph: a layer only ever depends on
 * itself and the layers before it (the chunks form a chain, never a circle), and only vendor code both pages load
 * statically is placed — a module either page imports lazily, and the app's own code, stay Rollup's.
 */
import { describe, expect, it } from 'vitest'
import { LAYERS, REST, computeLayers } from './vendorLayers.js'

const nm = (p: string) => `/repo/node_modules/${p}`
const BJS = (p: string) => nm(`@babylonjs/core/${p}`)

/** id → [static imports]; the two pages are entries. */
function api(graph: Record<string, string[]>) {
  const ids = new Set(Object.keys(graph))
  for (const deps of Object.values(graph)) for (const d of deps) ids.add(d)
  return {
    getModuleIds: () => ids.values(),
    getModuleInfo: (id: string) =>
      ids.has(id) ? { isEntry: id.endsWith('.html'), importedIds: graph[id] ?? [] } : null,
  }
}

const graph: Record<string, string[]> = {
  '/repo/apps/client/play.html': ['/repo/apps/client/src/main.ts'],
  '/repo/apps/client/editor.html': ['/repo/apps/client/src/editor/main.ts'],
  '/repo/apps/client/src/main.ts': [
    BJS('scene.pure.js'),
    BJS('Meshes/mesh.pure.js'),
    '/repo/packages/protocol/index.ts',
    '\0vite/preload-helper.js',
  ],
  '/repo/apps/client/src/editor/main.ts': [
    BJS('scene.pure.js'),
    BJS('Meshes/mesh.pure.js'),
    BJS('Layers/highlightLayer.js'),
  ],
  [BJS('scene.pure.js')]: [
    BJS('Maths/math.vector.pure.js'),
    BJS('Engines/engine.pure.js'),
    BJS('Misc/sceneHelpers.js'),
  ],
  [BJS('Meshes/mesh.pure.js')]: [
    BJS('Meshes/abstractMesh.pure.js'),
    BJS('Maths/math.vector.pure.js'),
  ],
  [BJS('Meshes/abstractMesh.pure.js')]: [BJS('scene.pure.js'), BJS('Culling/ray.js')],
  [BJS('Engines/engine.pure.js')]: [BJS('Maths/math.vector.pure.js')],
  [BJS('Maths/math.vector.pure.js')]: [],
  [BJS('Misc/sceneHelpers.js')]: [],
  [BJS('Culling/ray.js')]: [],
  [BJS('Layers/highlightLayer.js')]: [BJS('scene.pure.js')],
  '/repo/packages/protocol/index.ts': [nm('zod/index.js')],
  [nm('zod/index.js')]: [],
}

describe('vendorLayers', () => {
  const layers = computeLayers(api(graph))
  const order = [...LAYERS.map(([name]) => name), REST]

  it('places the vendor code both pages load, in the layer of its first seed', () => {
    expect(layers.get(BJS('Maths/math.vector.pure.js'))).toBe('vendor-maths')
    expect(layers.get(BJS('Engines/engine.pure.js'))).toBe('vendor-engine')
    expect(layers.get(BJS('scene.pure.js'))).toBe('vendor-scene')
    expect(layers.get(BJS('Misc/sceneHelpers.js'))).toBe('vendor-scene')
    expect(layers.get(BJS('Meshes/mesh.pure.js'))).toBe('vendor-meshes')
    expect(layers.get(BJS('Culling/ray.js'))).toBe('vendor-meshes')
  })

  it('leaves the app, editor-only code and vendor code of one page to Rollup', () => {
    expect(layers.has('/repo/apps/client/src/main.ts')).toBe(false)
    expect(layers.has('/repo/packages/protocol/index.ts')).toBe(false)
    expect(layers.has(BJS('Layers/highlightLayer.js'))).toBe(false)
    expect(layers.has(nm('zod/index.js'))).toBe(false)
  })

  it('puts the preload helper in the first layer', () => {
    expect(layers.get('\0vite/preload-helper.js')).toBe(LAYERS[0]![0])
  })

  it('never lets a layer import a later one', () => {
    for (const [id, layer] of layers) {
      for (const dep of graph[id] ?? []) {
        const depLayer = layers.get(dep)
        if (depLayer) expect(order.indexOf(depLayer)).toBeLessThanOrEqual(order.indexOf(layer))
      }
    }
  })

  it('places nothing without both pages', () => {
    const { ['/repo/apps/client/editor.html']: _editor, ...playOnly } = graph
    expect(computeLayers(api(playOnly)).size).toBe(0)
  })
})
