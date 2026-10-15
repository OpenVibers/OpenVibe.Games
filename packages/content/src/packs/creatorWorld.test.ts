import { describe, expect, it } from 'vitest'
import { createContent } from '../index.js'
import { emptyMapV2, type MapFileV2 } from '../mapFileV2.js'
import {
  CREATOR_MAP_LIMITS,
  creatorMapIssues,
  creatorPlaceId,
  creatorWorldOf,
  creatorWorldPack,
} from './creatorWorld.js'

describe('creator worlds', () => {
  it('maps world ids to places and back, refusing anything else', () => {
    expect(creatorPlaceId('wabc123def0')).toBe('world:wabc123def0')
    expect(creatorWorldOf('world:wabc123def0')).toBe('wabc123def0')
    expect(creatorWorldOf('world:WABC123DEF0')).toBeNull()
    expect(creatorWorldOf('world:wabc')).toBeNull()
    expect(creatorWorldOf('scraplandia')).toBeNull()
    expect(creatorWorldOf(undefined)).toBeNull()
    expect(() => creatorWorldPack('../etc')).toThrow(/creator world id/)
  })

  it('builds the same def set on server and client, one per world, never Scraplandia’s', () => {
    const a = createContent([], creatorWorldPack('w0000000001'))
    expect(createContent([], creatorWorldPack('w0000000001')).digest).toBe(a.digest)
    expect(createContent([], creatorWorldPack('w0000000002')).digest).not.toBe(a.digest)
    expect(createContent().digest).not.toBe(a.digest)
    expect(a.world.id).toBe('creator_w0000000001')
    expect(a.world.zones).toEqual([])
  })

  it('takes a plain map and refuses uploads, paint and oversized maps', () => {
    const plain: MapFileV2 = emptyMapV2()
    expect(creatorMapIssues(plain, 200)).toEqual([])
    const uploads: MapFileV2 = {
      ...plain,
      textures: [{ name: 'photo', url: '/map-assets/abc.png' }],
      models: [{ id: 'm', name: 'm', glb: '/map-assets/m.glb', bounds: [1, 1, 1] }],
    }
    const issues = creatorMapIssues(uploads, CREATOR_MAP_LIMITS.bytes + 1)
    expect(issues.some((i) => i.startsWith('bytes:'))).toBe(true)
    expect(issues.some((i) => i.startsWith('textures:'))).toBe(true)
    expect(issues.some((i) => i.startsWith('models:'))).toBe(true)
    const lights = Array.from({ length: CREATOR_MAP_LIMITS.lights + 1 }, (_, n) => ({
      ...(plain.lights[0] ?? {}),
      id: `l${n}`,
    })) as MapFileV2['lights']
    expect(creatorMapIssues({ ...plain, lights }, 10).some((i) => i.startsWith('lights:'))).toBe(
      true,
    )
    const painted = {
      ...plain,
      statics: [
        {
          id: 's',
          surface: {
            base: {},
            paint: {
              layers: [{ id: 'l', tex: 'none', color: '#ffffff', channel: 'r' }],
              mask: 'm',
            },
          },
        },
      ],
    } as unknown as MapFileV2
    expect(creatorMapIssues(painted, 10).some((i) => i.startsWith('statics:'))).toBe(true)
  })
})
