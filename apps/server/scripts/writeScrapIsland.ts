/**
 * Write Scrap Island (src/maps/scrapIsland.ts) as a map document: the file the server loads from MAP_PATH and the
 * editor saves. It is an ordinary v2 map, so /editor edits it like any other.
 *
 *   pnpm --filter @openvibe/server exec tsx scripts/writeScrapIsland.ts --out /path/to/map.json [--seed 20261019]
 *
 * It refuses to overwrite an existing file unless --force is given: a map staff edited must not be lost to a rerun.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseMapFile } from '@openvibe/content'
import { generateScrapIsland } from '../src/maps/scrapIsland.js'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const out = arg('--out')
if (!out) {
  console.error('usage: writeScrapIsland.ts --out <map.json> [--seed N] [--force]')
  process.exit(2)
}
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} exists (a map staff may have edited); pass --force to replace it`)
  process.exit(1)
}
const map = generateScrapIsland(Number(arg('--seed') ?? 20261019))
const parsed = parseMapFile(map)
if (!parsed.ok) {
  console.error('generated map is invalid:', parsed.issues.slice(0, 10).join('; '))
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })
const json = JSON.stringify(map)
writeFileSync(out, json)
console.log(
  `wrote ${out}: ${(json.length / 1024).toFixed(0)} KB, ${map.statics.length} statics, ${map.nodes.length} nodes, ${map.props.length} props, ${map.lights.length} lights`,
)
