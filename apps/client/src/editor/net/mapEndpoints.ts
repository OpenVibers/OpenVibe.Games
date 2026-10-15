import { CREATOR_WORLD_ID } from '@openvibe/content'
import { editorToken } from './editorToken.js'

/**
 * Where the editor reads and saves its map. Staff edit the place's map (/map.json, POST /api/map, uploads, live
 * collaboration). `/editor?world=<id>` edits a creator world instead: the owner's map at /api/worlds/<id>/map
 * (PUT, with the Network token), built-in materials only and no collaboration socket (that one is staff-only).
 */
export interface MapEndpoints {
  /** The creator world being edited, or null for the place's own map. */
  worldId: string | null
  /** GET: the v2 document, ETag = revision. */
  read: string
  save: string
  saveMethod: 'POST' | 'PUT'
  /** Content-addressed uploads (textures, models, paint masks), or null where uploads are off. */
  assets: string | null
  /** Live collaboration over /editor-ws. */
  collaboration: boolean
  /** The local draft store's key: one draft per map. */
  draftKey: string
}

export function mapEndpoints(
  search: string = location.search,
  origin: string = location.origin,
): MapEndpoints {
  const requested = new URLSearchParams(search).get('world')
  if (requested && CREATOR_WORLD_ID.test(requested)) {
    const base = `/api/worlds/${requested}/map`
    return {
      worldId: requested,
      read: base,
      save: base,
      saveMethod: 'PUT',
      assets: null,
      collaboration: false,
      draftKey: `${origin}${base}`,
    }
  }
  return {
    worldId: null,
    read: '/map.json',
    save: '/api/map',
    saveMethod: 'POST',
    assets: '/api/map-assets',
    collaboration: true,
    draftKey: `${origin}/map.json`,
  }
}

/** Reads the map being edited (a creator world's draft answers only its owner, so the token goes along). */
export function fetchMap(endpoints: MapEndpoints): Promise<Response> {
  const token = endpoints.worldId ? editorToken() : ''
  return fetch(endpoints.read, {
    cache: 'no-store',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  })
}
