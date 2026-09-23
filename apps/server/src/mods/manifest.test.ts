import { readFileSync } from 'node:fs'
import { createContent } from '@openvibe/content'
import { describe, expect, it } from 'vitest'
import { validateContentPack } from './contentPack.js'
import { checkForGames, validateManifest } from './manifest.js'
import { MOD_MANIFEST_SCHEMA } from './manifestSchema.js'
import { sampleManifest } from './testFixtures.js'

describe('mod manifest schema', () => {
  it('is the same document as the Contracts proposal', () => {
    const proposal: unknown = JSON.parse(
      readFileSync(
        new URL('../../../../docs/contracts-proposal/mods/mod-manifest.v1.json', import.meta.url),
        'utf8',
      ),
    )
    expect(MOD_MANIFEST_SCHEMA).toEqual(proposal)
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
