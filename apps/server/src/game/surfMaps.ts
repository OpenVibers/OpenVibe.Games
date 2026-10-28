import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileMapFileV2, parseMapFile, surfMap, type MapFileV2, type MapOverride } from '@openvibe/content'

/** The authored surf maps, versioned with the code (the runtime world under data/ is the editor's). */
export const SURF_MAP_DIR = 'content/surf'

/**
 * The repository root, independent of the process cwd. Tests (and some
 * launchers) start the server from `apps/server/`, while a deployed server
 * runs from the repo root; `surfMapPath` accepts an explicit root for tests.
 */
function defaultRoot(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), '../..')]) {
    if (existsSync(join(candidate, SURF_MAP_DIR))) return candidate
  }
  // Bundled layouts: apps/server/dist/… -> repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
}

export function surfMapPath(mapId: string, root = defaultRoot()): string {
  const info = surfMap(mapId)
  if (!info) throw new Error(`unknown surf map: ${mapId}`)
  return join(root, SURF_MAP_DIR, info.file)
}

/** Read and validate one authored map. A bad document fails the place, not the process silently. */
export function loadSurfMap(mapId: string, root = defaultRoot()): MapFileV2 {
  const raw = JSON.parse(readFileSync(surfMapPath(mapId, root), 'utf8')) as unknown
  const parsed = parseMapFile(raw)
  if (!parsed.ok)
    throw new Error(`surf map ${mapId} is invalid: ${parsed.issues.slice(0, 5).join('; ')}`)
  return parsed.map
}

/** The compiled runtime override, with the map's movement/surf metadata. */
export function loadSurfOverride(mapId: string, root = defaultRoot()): MapOverride {
  return compileMapFileV2(loadSurfMap(mapId, root))
}
