import { describe, expect, it } from 'vitest'
import { mapEndpoints } from './mapEndpoints.js'

describe('editor map endpoints', () => {
  it("edits the place's map by default, with uploads and collaboration", () => {
    expect(mapEndpoints('', 'https://openvibe.games')).toEqual({
      worldId: null,
      read: '/map.json',
      save: '/api/map',
      saveMethod: 'POST',
      assets: '/api/map-assets',
      collaboration: true,
      draftKey: 'https://openvibe.games/map.json',
    })
  })

  it('edits a creator world alone, with its own draft and no uploads', () => {
    expect(mapEndpoints('?world=wabc123def0', 'https://openvibe.games')).toEqual({
      worldId: 'wabc123def0',
      read: '/api/worlds/wabc123def0/map',
      save: '/api/worlds/wabc123def0/map',
      saveMethod: 'PUT',
      assets: null,
      collaboration: false,
      draftKey: 'https://openvibe.games/api/worlds/wabc123def0/map',
    })
  })

  it('ignores a world parameter that is not a world id', () => {
    expect(mapEndpoints('?world=../../api/map', 'https://x').worldId).toBeNull()
  })
})
