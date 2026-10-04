import { createContent, ITEMS, SCRAPLANDIA_PACK } from '@openvibe/content'
import { openTestStore } from '@openvibe/persistence/testing'
import { describe, expect, it } from 'vitest'
import {
  CAP_DEFINE,
  capabilitiesUsedBy,
  loadDefinitionPacks,
  validateContentPack,
} from './contentPack.js'
import { ModError, ModRegistry, type ModActor } from './registry.js'
import { sampleManifest } from './testFixtures.js'

/**
 * games-content@2 definitions: the install gate (games.def.define) and the boot loader that merges the
 * enabled, granted packs into the content registry before the world is built.
 */
const STAFF: ModActor = {
  audit: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
  subject: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
}
const A = 'mod_01JABCDEFGHJKMNPQRSTVWXYZA'
const B = 'mod_01JABCDEFGHJKMNPQRSTVWXYZB'
const plain = ITEMS.find(
  (i) => !i.health && !i.container && !i.machine && !i.shop && !i.seed && !i.blueprint,
)!
const itemPack = (id: string) => ({ defs: { items: [{ ...plain, id }] } })
const manifestFor = (id: string, capabilities: string[]) =>
  sampleManifest({ id, permissions: { capabilities } })

async function setup() {
  const store = await openTestStore()
  const registry = new ModRegistry(store, createContent())
  const install = (
    id: string,
    pack: unknown,
    capabilities: string[],
    approve: string[],
    enable = true,
  ) => registry.install({ manifest: manifestFor(id, capabilities), pack, approve, enable }, STAFF)
  return { store, registry, install }
}

describe('games-content@2 definitions', () => {
  it('recognizes an authored map as a definition-capability section', () => {
    const mapPack = { map: SCRAPLANDIA_PACK.map }
    expect(capabilitiesUsedBy(mapPack)).toEqual([CAP_DEFINE])
    expect(validateContentPack(mapPack, createContent()).ok).toBe(true)
    expect(validateContentPack({ map: { id: 'broken' } }, createContent()).ok).toBe(false)
  })
  it('needs games.def.define for any non-empty defs section', () => {
    expect(capabilitiesUsedBy(itemPack('widget'))).toEqual([CAP_DEFINE])
    expect(capabilitiesUsedBy({ defs: { items: [] } })).toEqual([])
    expect(capabilitiesUsedBy({})).toEqual([])
  })

  it('refuses a defs pack whose manifest does not request games.def.define, accepts it when it does', async () => {
    const { registry, install } = await setup()
    const refused = await install(A, itemPack('widget'), ['games.world.announce'], []).catch(
      (e) => e,
    )
    expect(refused).toBeInstanceOf(ModError)
    expect((refused as ModError).errors).toContain(`pack needs ${CAP_DEFINE}`)
    await install(A, itemPack('widget'), [CAP_DEFINE], [])
    expect(registry.get(A)).not.toBeNull()
  })

  it('validates definitions at install: a base id, a bad def and an unknown section are refused', async () => {
    const content = createContent()
    expect(validateContentPack(itemPack('widget'), content).ok).toBe(true)
    expect(validateContentPack({ defs: { items: [{ ...plain }] } }, content).ok).toBe(false)
    expect(validateContentPack({ defs: { items: [{ id: 'Bad Id' }] } }, content).ok).toBe(false)
    expect(validateContentPack({ defs: { shaders: [] } }, content).ok).toBe(false)
    // an install is checked against the content the server is running, which already has loaded packs
    expect(validateContentPack(itemPack('widget'), createContent([itemPack('widget')])).ok).toBe(
      false,
    )
  })

  it('boots with one enabled v2 pack: its definitions exist in the content registry', async () => {
    const { store, install } = await setup()
    await install(A, itemPack('widget'), [CAP_DEFINE], [CAP_DEFINE])
    const skipped: string[] = []
    const packs = await loadDefinitionPacks(store.mods, (id) => skipped.push(id))
    expect(packs).toHaveLength(1)
    expect(skipped).toEqual([])
    expect(createContent(packs).item('widget')).toMatchObject({ id: 'widget' })
    expect(createContent().item('widget')).toBeUndefined()
  })

  it('does not load a pack that is disabled, not granted, or whose grant was revoked', async () => {
    const { store, registry, install } = await setup()
    await install(A, itemPack('off'), [CAP_DEFINE], [CAP_DEFINE], false)
    await install(B, itemPack('ungranted'), [CAP_DEFINE], [])
    expect(await loadDefinitionPacks(store.mods)).toEqual([])
    const C = 'mod_01JABCDEFGHJKMNPQRSTVWXYZC'
    await install(C, itemPack('revoked'), [CAP_DEFINE], [CAP_DEFINE])
    expect(await loadDefinitionPacks(store.mods)).toHaveLength(1)
    await registry.revokeGrant(C, CAP_DEFINE, STAFF)
    expect(await loadDefinitionPacks(store.mods)).toEqual([])
  })

  it('skips a pack that no longer builds instead of failing the boot', async () => {
    const { store, install } = await setup()
    // each is valid alone, so both install; together the second collides with the first
    await install(A, itemPack('same_id'), [CAP_DEFINE], [CAP_DEFINE])
    await install(B, itemPack('same_id'), [CAP_DEFINE], [CAP_DEFINE])
    const skipped: string[] = []
    const packs = await loadDefinitionPacks(store.mods, (id, reason) => {
      skipped.push(id)
      expect(reason).toMatch(/already exists/)
    })
    expect(packs).toHaveLength(1)
    expect(skipped).toHaveLength(1)
    expect(createContent(packs).item('same_id')).toBeDefined()
  })
})
