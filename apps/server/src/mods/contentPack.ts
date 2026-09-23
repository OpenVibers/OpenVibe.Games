/**
 * `games-content@1`: the first mod kind — a declarative data pack, checked
 * against the live `@openvibe/content` registry. It adds no code and no new
 * definitions (the client ships the same registry, so a pack can only use
 * what both sides already know). Each section needs one capability:
 *
 *   announcements  games.world.announce   periodic server announcements
 *   props          games.prop.place       inert props placed in the world
 *
 * Mod props are owned by the mod, so prop protection keeps players from
 * picking them up, moving or welding them, and only items without health,
 * storage, shops, machines or vehicle parts may be placed: nothing a player
 * could destroy for loot or use to move items into or out of the world.
 */
import type { ContentRegistry } from '@openvibe/content'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { Validation } from './manifest.js'

export const CAP_ANNOUNCE = 'games.world.announce'
export const CAP_PLACE_PROP = 'games.prop.place'

/** Capabilities the games-content@1 runtime can bind. Anything else is never granted here. */
export const CONTENT_RUNTIME_CAPABILITIES: readonly string[] = [CAP_ANNOUNCE, CAP_PLACE_PROP]

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
  announcements?: ContentAnnouncement[]
  props?: ContentProp[]
}

export const CONTENT_PACK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openvibe.games/schemas/games-content-pack.v1.json',
  title: 'GamesContentPack',
  type: 'object',
  additionalProperties: false,
  properties: {
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
  },
} as const

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateSchema = ajv.compile(CONTENT_PACK_SCHEMA)

/** Which capability each pack section needs. */
export function capabilitiesUsedBy(pack: ContentPack): string[] {
  const used: string[] = []
  if ((pack.announcements ?? []).length > 0) used.push(CAP_ANNOUNCE)
  if ((pack.props ?? []).length > 0) used.push(CAP_PLACE_PROP)
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
  const keys = new Set<string>()
  for (const prop of pack.props ?? []) {
    if (keys.has(prop.key)) errors.push(`duplicate prop key '${prop.key}'`)
    keys.add(prop.key)
    const problem = placeableByMod(content, prop.item)
    if (problem) errors.push(problem)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: pack }
}
