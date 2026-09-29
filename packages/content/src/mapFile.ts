/**
 * Map document primitives shared by the editor, the server and the client:
 * the base64 heightfield codec, the custom-texture entry shape, and the
 * authored light type. The document itself is `MapFileV2` (./mapFileV2.ts).
 */

/**
 * Editor-placed light. Covers every Babylon punctual/ambient light type:
 * point, spot (angle+exponent), directional (sun-like), hemispheric
 * (ambient dome with ground color) and rectangular area lights.
 *
 * The shape lives in `schema/world.ts` as `MapLightSchema` so there is ONE
 * definition: this used to be a hand-written interface next to an untyped
 * `z.record(unknown)` on the wire, which meant an authored light was
 * validated nowhere and could reach Babylon malformed.
 */
export type { MapLight } from './schema/world.js'

/** A custom texture: either embedded (dataUrl) or server-hosted. */
export interface MapTextureEntry {
  name: string
  /** Embedded payload (small uploads). */
  dataUrl?: string
  /** Server-hosted asset path (/map-assets/...), preferred. */
  url?: string
  /** Default UV tiling scale hint. */
  scale?: number
}

export function decodeHeights(b64: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

export function encodeHeights(heights: Float32Array): string {
  const bytes = new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number)
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')
}
