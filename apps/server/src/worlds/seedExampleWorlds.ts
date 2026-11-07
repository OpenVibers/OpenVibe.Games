import { creatorMapIssues, parseMapFile } from '@openvibe/content'
import { mapRevision, type CreatorWorld, type CreatorWorldStore } from '@openvibe/persistence'
import type { Logger } from '@openvibe/shared'
import { EXAMPLE_WORLDS } from './exampleWorlds.js'

/**
 * Publish the official example creator worlds (src/worlds/exampleWorlds.ts) through the same store the API
 * writes with. Idempotent: a world the official account already has under the same title is left alone (and
 * published if it is still a draft); { revise: true } updates its map when the seed's revision changed. Only
 * the official account's own worlds are read; a person's world is never touched, even with the same title.
 */
export interface OfficialWorldAccount {
  /** The account's usr_… subject. */
  subject: string
  /** The name the worlds carry (the Network's display name for the account). */
  name: string
}

export interface SeedExampleWorldResult {
  title: string
  id: string
  action: 'created' | 'published' | 'revised' | 'unchanged'
}

export async function seedExampleWorlds(opts: {
  store: CreatorWorldStore
  official: OfficialWorldAccount
  log: Logger
  revise?: boolean
  now?: number
}): Promise<SeedExampleWorldResult[]> {
  const { store, official, log, revise = false } = opts
  const now = opts.now ?? Date.now()
  const out: SeedExampleWorldResult[] = []
  for (const def of EXAMPLE_WORLDS) {
    const parsed = parseMapFile(def.map)
    if (!parsed.ok) {
      throw new Error(`${def.title}: the map is not valid: ${(parsed as { issues: string[] }).issues.join('; ')}`)
    }
    const issues = creatorMapIssues(parsed.map, Buffer.byteLength(JSON.stringify(parsed.map)))
    if (issues.length) throw new Error(`${def.title}: the creator-world gate refuses it: ${issues.join('; ')}`)

    const owned = await store.listByOwner(official.subject)
    let world: CreatorWorld | null = owned.find((w) => w.title === def.title) ?? null
    let action: SeedExampleWorldResult['action'] = 'unchanged'
    if (!world) {
      world = await store.create({
        ownerSubject: official.subject,
        ownerName: official.name,
        title: def.title,
        summary: def.summary,
        map: parsed.map,
        now,
      })
      action = 'created'
      log.info('example world created', { world: world.id, title: def.title })
    } else if (revise) {
      const stored = await store.map(world.id)
      if (!stored || stored.revision !== mapRevision(parsed.map)) {
        const saved = await store.saveMap(world.id, parsed.map, null, now)
        if (saved && saved !== 'conflict') world = saved
        action = 'revised'
        log.info('example world revised', { world: world.id, title: def.title })
      }
    }
    if (world.status !== 'published') {
      const published = await store.update(world.id, { status: 'published' }, now)
      if (published) world = published
      if (action === 'unchanged') action = 'published'
      log.info('example world published', { world: world.id, title: def.title })
    }
    out.push({ title: def.title, id: world.id, action })
  }
  return out
}
