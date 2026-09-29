import { createRequire } from 'node:module'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createContent } from '@openvibe/content'
import { describe, expect, it } from 'vitest'
import { validateContentPack } from './contentPack.js'
import { checkForGames, MOD_MANIFEST_REF, validateManifest } from './manifest.js'
import { MOD_ID, sampleManifest } from './testFixtures.js'

interface ContractsModule {
  schema(ref: string): Record<string, unknown>
}
const contracts = createRequire(import.meta.url)('openvibe-contracts') as ContractsModule

describe('mod manifest schema', () => {
  // 1.1.0 (openvibe-contracts v0.34.0) added permissions.readGrants and
  // writeGrants, billingHooks and dependencies; a 1.0 structure rejects them
  // (additionalProperties: false). Exercising them is what makes the
  // agreement test below a real drift detector: a local 1.0 copy that happens
  // to match the minimal fixtures would fail here.
  const minimalV11 = {
    ...sampleManifest(),
    permissions: {
      capabilities: ['games.world.announce'],
      readGrants: { modules: ['other.read'] },
      writeGrants: { mediaNamespaces: ['games'] },
    },
    billingHooks: [{ kind: 'entitlement', key: 'vip.plan:pln_01jab' }],
    dependencies: [{ id: MOD_ID, version: '>=1.0.0' }],
  } as unknown as Record<string, unknown>

  it('validates against the installed contracts schema for mods.mod-manifest@1, version 1.1.0', () => {
    // The installed package advertises the version the pin claims. Neither the
    // schema nor contracts exposes a machine-readable version field, so the
    // canonical $id and the description's version marker are asserted here.
    const schema = contracts.schema(MOD_MANIFEST_REF) as { $id?: string; description?: string }
    expect(schema.$id).toBe('https://openvibe.network/contracts/mods/mod-manifest.v1.json')
    expect(schema.description).toContain('1.1.0')
    // The 1.1.0-only fields are accepted: proof validateManifest is using the
    // package's 1.1.0 schema, not a stale local 1.0 copy.
    expect(validateManifest(minimalV11).ok).toBe(true)
  })

  it('agrees with the installed contracts package on every sample manifest', () => {
    // Pin drift is a defect (ADR-0007 decision 12): whenever Games accepts a
    // manifest, the installed contracts package must accept it too, and the
    // other way round. Both validators must return the SAME verdict for
    // every case, valid or invalid — if a future change reintroduces a local
    // schema copy, this fails the moment the two disagree.
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    ajv.addSchema(contracts.schema('identity.subject-ref@1'))
    ajv.addSchema(contracts.schema('media.media-ref@1'))
    const validate = ajv.compile(contracts.schema(MOD_MANIFEST_REF))

    const minimal = sampleManifest()
    const missingRequired = { ...minimal } as Record<string, unknown>
    delete missingRequired['version']
    const cases: [string, unknown][] = [
      [
        'the full fixture (assets, modules, mediaNamespaces, events, homepage)',
        sampleManifest({
          assets: [{ media_id: 'med_01JABCDEFGHJKMNPQRSTVWXYZ0', role: 'icon' }],
          homepage: 'https://openvibe.games/mods/town-square',
          permissions: {
            capabilities: ['games.world.announce'],
            events: ['games.player.joined'],
            modules: ['games.progress.summary'],
            mediaNamespaces: ['games'],
          },
        }),
      ],
      ['the minimal fixture', minimal],
      ['the 1.1.0-only fields (readGrants, writeGrants, billingHooks, dependencies)', minimalV11],
      ['a 1.0 structure that omits the 1.1.0 fields', minimal],
      ['a non-conforming id', { ...minimal, id: 'my-mod' }],
      ['an unknown top-level property', { ...minimal, extra: true }],
      ['a missing required field', missingRequired],
      [
        'a bad 1.1.0 billingHooks kind',
        { ...minimalV11, billingHooks: [{ kind: 'nope', key: 'vip.plan:x' }] },
      ],
      [
        'a 1.1.0 dependency id that is not a mod ULID',
        { ...minimalV11, dependencies: [{ id: 'other', version: '>=1.0.0' }] },
      ],
    ]
    for (const [label, manifest] of cases) {
      expect(validateManifest(manifest).ok, `Games vs contracts: ${label}`).toBe(
        Boolean(validate(manifest)),
      )
    }
  })

  it('has an independent expected verdict for each 1.1.0 delta case', () => {
    // A second oracle, not agreement: the explicit verdicts these fields must
    // get, so a future schema bump that Games silently ignores is caught even
    // if both validators are (wrongly) reading the same stale source.
    expect(validateManifest(minimalV11).ok).toBe(true)
    expect(
      validateManifest({
        ...minimalV11,
        permissions: { capabilities: ['games.world.announce'], readGrants: {} },
      }).ok,
    ).toBe(false)
    expect(
      validateManifest({
        ...minimalV11,
        billingHooks: [{ kind: 'refund', key: 'vip.plan:x' }],
      }).ok,
    ).toBe(false)
    expect(validateManifest({ ...minimalV11, dependencies: [{ id: MOD_ID }] }).ok).toBe(false)
  })

  it('accepts a complete manifest, including Media asset refs', () => {
    const r = validateManifest(
      sampleManifest({
        assets: [{ media_id: 'med_01JABCDEFGHJKMNPQRSTVWXYZ0', role: 'icon' }],
        homepage: 'https://openvibe.games/mods/town-square',
        permissions: {
          capabilities: ['games.world.announce'],
          events: ['games.player.joined'],
          modules: ['games.progress.summary'],
          mediaNamespaces: ['games'],
        },
      }),
    )
    expect(r).toMatchObject({ ok: true })
  })

  it('rejects malformed manifests with a reason', () => {
    const bad: [string, unknown][] = [
      ['id not a mod ULID', sampleManifest({ id: 'my-mod' })],
      ['version not semver', sampleManifest({ version: 'v1' })],
      ['publisher not a subject', sampleManifest({ publisher: { type: 'user', id: '57' } })],
      [
        '2-segment capability',
        sampleManifest({ permissions: { capabilities: ['games.announce'] } }),
      ],
      ['unknown field', { ...sampleManifest(), trust_tier: 'first-party' }],
      [
        'cpu budget too high',
        sampleManifest({ resources: { cpuMs: 5000, memoryMb: 0, storageMb: 0 } }),
      ],
      ['asset not a Media id', sampleManifest({ assets: [{ media_id: 'https://x/y.png' }] })],
      ['missing compatibility', { ...sampleManifest(), compatibility: undefined }],
    ]
    for (const [why, value] of bad) {
      const r = validateManifest(JSON.parse(JSON.stringify(value)))
      expect(r.ok, why).toBe(false)
    }
  })

  it('only admits declarative content packs in Games (executable mods wait for Host)', () => {
    expect(checkForGames(sampleManifest())).toEqual([])
    expect(checkForGames(sampleManifest({ runtime: 'source-quickjs@1' }))[0]).toMatch(
      /only games-content@1/,
    )
    expect(checkForGames(sampleManifest({ target: 'games.source' }))).toHaveLength(1)
    expect(checkForGames(sampleManifest({ compatibility: { runtime: '>=2.0.0' } }))).toHaveLength(1)
    expect(
      checkForGames(
        sampleManifest({
          resources: { cpuMs: 1, memoryMb: 0, storageMb: 0, outboundHosts: ['example.com'] },
        }),
      ),
    ).toHaveLength(1)
  })
})

describe('games-content@1 packs', () => {
  const content = createContent()

  it('accept existing, inert items and announcements', () => {
    const r = validateContentPack(
      {
        announcements: [{ text: 'Welcome to the square', everySeconds: 600 }],
        props: [{ key: 'bench', item: 'workbench', pos: [10, 0, 10], yaw: 1.5 }],
      },
      content,
    )
    expect(r.ok).toBe(true)
  })

  it('refuse unknown items, loot-bearing or storage props, duplicates and bad shapes', () => {
    const reject = (pack: unknown) => validateContentPack(pack, content).ok
    expect(reject({ props: [{ key: 'x', item: 'no_such_item', pos: [0, 0, 0] }] })).toBe(false)
    const storage = content.allItems().find((i) => i.container)
    const breakable = content.allItems().find((i) => i.health)
    expect(storage && breakable).toBeTruthy()
    expect(reject({ props: [{ key: 'x', item: storage!.id, pos: [0, 0, 0] }] })).toBe(false)
    expect(reject({ props: [{ key: 'x', item: breakable!.id, pos: [0, 0, 0] }] })).toBe(false)
    expect(
      reject({
        props: [
          { key: 'a', item: 'workbench', pos: [0, 0, 0] },
          { key: 'a', item: 'campfire', pos: [1, 0, 0] },
        ],
      }),
    ).toBe(false)
    expect(reject({ announcements: [{ text: 'spam', everySeconds: 5 }] })).toBe(false)
    expect(reject({ scripts: ['while(true){}'] })).toBe(false)
    expect(reject({ props: [{ key: 'x', item: 'workbench', pos: [0, 0, 1e9] }] })).toBe(false)
  })
})
