/**
 * `games-content@2` data and `games-quickjs@1` scripts, checked against the
 * live `@openvibe/content` registry. Each section
 * needs one capability:
 *
 *   announcements  games.world.announce   periodic server announcements
 *   props          games.prop.place       inert props placed in the world
 *   defs/map       games.def.define       definitions and an authored map
 *                                         merged into the content registry
 *
 * Definitions are validated here with the schemas the base content uses and
 * merged by `createContent(packs)` when the server boots, so a new pack's defs
 * exist after the next restart (the registry is immutable). The client does
 * not load installed packs yet: the def-set handshake refuses clients whose
 * local definitions differ from the server's loaded set.
 *
 * Mod props are owned by the mod, so prop protection keeps players from
 * picking them up, moving or welding them, and only items without health,
 * storage, shops, machines or vehicle parts may be placed: nothing a player
 * could destroy for loot or use to move items into or out of the world.
 */
import {
  createContent,
  MAX_PACK_DEFS,
  mergePackDefs,
  type ContentPackV2,
  type ContentRegistry,
  ScriptModSchema,
  MAX_PACK_MODS,
  type ScriptCapability,
} from '@openvibe/content'
import type { ModRepository } from '@openvibe/persistence'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { Validation } from './manifest.js'

export const CAP_ANNOUNCE = 'games.world.announce'
export const CAP_PLACE_PROP = 'games.prop.place'
export const CAP_DEFINE = 'games.def.define'
export const CAP_SCRIPT_RUN = 'games.script.run'
export const scriptGrant = (capability: ScriptCapability): string => `games.${capability}`

/** Capabilities the games-content@2 runtime can bind. Anything else is never granted here. */
export const CONTENT_RUNTIME_CAPABILITIES: readonly string[] = [
  CAP_ANNOUNCE,
  CAP_PLACE_PROP,
  CAP_DEFINE,
  CAP_SCRIPT_RUN,
]

export interface ContentAnnouncement {
  text: string
  everySeconds: number
}

export interface ContentProp {
  key: string
  item: string
  pos: [number, number, number]
  yaw?: number
}

export interface ContentPack {
  /** Definitions, deep-validated by `mergePackDefs`; the schema only bounds them. */
  defs?: NonNullable<ContentPackV2['defs']>
  map?: NonNullable<ContentPackV2['map']>
  announcements?: ContentAnnouncement[]
  props?: ContentProp[]
  mods?: NonNullable<ContentPackV2['mods']>
}

export const CONTENT_PACK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openvibe.games/schemas/games-content-pack.v2.json',
  title: 'GamesContentPack',
  type: 'object',
  additionalProperties: false,
  properties: {
    defs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', maxItems: MAX_PACK_DEFS.items, items: { type: 'object' } },
        recipes: { type: 'array', maxItems: MAX_PACK_DEFS.recipes, items: { type: 'object' } },
        crops: { type: 'array', maxItems: MAX_PACK_DEFS.crops, items: { type: 'object' } },
        npcs: { type: 'array', maxItems: MAX_PACK_DEFS.npcs, items: { type: 'object' } },
      },
    },
    map: { type: 'object', maxProperties: 12 },
    announcements: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['text', 'everySeconds'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 200 },
          everySeconds: { type: 'integer', minimum: 60, maximum: 86400 },
        },
      },
    },
    props: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        required: ['key', 'item', 'pos'],
        additionalProperties: false,
        properties: {
          key: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
          item: { type: 'string', minLength: 1, maxLength: 64 },
          pos: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number', minimum: -4096, maximum: 4096 },
          },
          yaw: { type: 'number', minimum: -10, maximum: 10 },
        },
      },
    },
    mods: { type: 'array', maxItems: MAX_PACK_MODS, items: { type: 'object' } },
  },
} as const

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateSchema = ajv.compile(CONTENT_PACK_SCHEMA)

/** Which capability each pack section needs. */
export function capabilitiesUsedBy(pack: ContentPack): string[] {
  const used: string[] = []
  if (pack.map || Object.values(pack.defs ?? {}).some((list) => (list ?? []).length > 0))
    used.push(CAP_DEFINE)
  if ((pack.announcements ?? []).length > 0) used.push(CAP_ANNOUNCE)
  if ((pack.props ?? []).length > 0) used.push(CAP_PLACE_PROP)
  if ((pack.mods ?? []).length > 0) used.push(CAP_SCRIPT_RUN)
  for (const raw of pack.mods ?? []) {
    const parsed = ScriptModSchema.safeParse(raw)
    if (parsed.success)
      for (const cap of parsed.data.capabilities ?? ['players.read', 'world.emit']) {
        const grant = scriptGrant(cap)
        if (!used.includes(grant)) used.push(grant)
      }
  }
  return used
}

/** Whether a content item may be placed as a mod prop (see the file comment). */
export function placeableByMod(content: ContentRegistry, itemId: string): string | null {
  const def = content.item(itemId)
  if (!def) return `unknown item '${itemId}'`
  if (def.health) return `item '${itemId}' can be destroyed (health) and is not allowed`
  if (def.container) return `item '${itemId}' stores items and is not allowed`
  if (def.shop) return `item '${itemId}' is a shop and is not allowed`
  if (def.machine) return `item '${itemId}' is a machine and is not allowed`
  if (def.vehiclePart) return `item '${itemId}' is a vehicle part and is not allowed`
  return null
}

/** Structure (JSON Schema) plus the content-registry cross-checks. */
export function validateContentPack(
  value: unknown,
  content: ContentRegistry,
): Validation<ContentPack> {
  if (!validateSchema(value)) {
    return {
      ok: false,
      errors: (validateSchema.errors ?? []).map(
        (e) => `pack${e.instancePath || ''} ${e.message ?? ''}`,
      ),
    }
  }
  const pack = value as unknown as ContentPack
  const errors: string[] = []
  for (const [index, raw] of (pack.mods ?? []).entries()) {
    const parsed = ScriptModSchema.safeParse(raw)
    if (!parsed.success) errors.push(`mods[${index}]: ${parsed.error.message}`)
    else if (parsed.data.granted) errors.push(`mods[${index}]: granted is server-owned`)
  }
  // The built-in pack always supplies the map, so a mod's map would be skipped at boot as a duplicate.
  if (pack.map) errors.push('map is defined by the built-in pack and cannot be replaced by a mod')
  if (pack.defs || pack.map) {
    // The content the pack would be merged onto; its own ids may not already exist.
    const merged = mergePackDefs(
      {
        items: [...content.allItems()],
        recipes: [...content.allRecipes()],
        crops: [...content.allCrops()],
        npcs: [...content.allNpcs()],
        factions: [...content.allFactions()],
      },
      [pack],
    )
    errors.push(...merged.errors)
  }
  const keys = new Set<string>()
  for (const prop of pack.props ?? []) {
    if (keys.has(prop.key)) errors.push(`duplicate prop key '${prop.key}'`)
    keys.add(prop.key)
    const problem = placeableByMod(content, prop.item)
    if (problem) errors.push(problem)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: pack }
}

/**
 * The packs whose definitions the server merges at boot: enabled installs
 * with `games.def.define` actively granted. A pack is only taken if the
 * content still builds with it, so one bad install (say two packs defining the
 * same id, each valid when installed alone) is reported and skipped rather
 * than keeping the server from starting.
 */
export async function loadDefinitionPacks(
  mods: ModRepository,
  onSkip: (modId: string, reason: string) => void = () => {},
): Promise<ContentPackV2[]> {
  const accepted: ContentPackV2[] = []
  for (const mod of await mods.list()) {
    if (mod.status !== 'enabled') continue
    const pack = mod.pack as unknown as ContentPackV2
    if (
      !pack.map &&
      !pack.mods?.length &&
      Object.values(pack.defs ?? {}).every((list) => (list ?? []).length === 0)
    )
      continue
    const grants = new Set(
      (await mods.grants(mod.id)).filter((g) => g.revokedAt === null).map((g) => g.capability),
    )
    const hasDefs =
      !!pack.map || Object.values(pack.defs ?? {}).some((list) => (list ?? []).length > 0)
    const hasScripts = !!pack.mods?.length
    if ((hasDefs && !grants.has(CAP_DEFINE)) || (hasScripts && !grants.has(CAP_SCRIPT_RUN)))
      continue
    try {
      const approved: ContentPackV2 = {
        ...pack,
        ...(pack.mods
          ? {
              mods: pack.mods.map((raw) => {
                const parsed = ScriptModSchema.parse(raw)
                return {
                  ...parsed,
                  granted: (parsed.capabilities ?? ['players.read', 'world.emit'])
                    .filter((cap) => grants.has(scriptGrant(cap)))
                    .sort(),
                }
              }),
            }
          : {}),
      }
      createContent([...accepted, approved])
      accepted.push(approved)
    } catch (err) {
      onSkip(mod.id, err instanceof Error ? err.message : String(err))
    }
  }
  return accepted
}
