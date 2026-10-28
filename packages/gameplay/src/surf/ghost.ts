import type { SurfTrackSample } from './run.js'

/**
 * The ghost transform track (inventory §5.3 option 1): authoritative positions
 * quantised to 1 cm and yaw to 1/256 turn, little-endian. The server gzips the
 * bytes for storage/HTTP; this codec stays pure so the client can decode it
 * without a decompressor of its own (the browser's content-encoding does that).
 *
 *   header  magic "SURF", u8 version, u8 pad, u16 tickRate, u32 startTick, u32 count
 *   sample  i32 x_cm, i32 y_cm, i32 z_cm, u8 yawQ
 */
const MAGIC = 0x46525553 // "SURF" little-endian
const VERSION = 1
export const GHOST_HEADER_BYTES = 16
export const GHOST_SAMPLE_BYTES = 13

export interface DecodedGhost {
  tickRate: number
  startTick: number
  samples: SurfTrackSample[]
}

export function quantiseCentimetres(v: number): number {
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(v * 100)))
}

/** One byte per 1/256 turn. */
export function quantiseYaw8(yaw: number): number {
  const turn = yaw / (Math.PI * 2)
  const q = Math.round(turn * 256) % 256
  return q < 0 ? q + 256 : q
}

export function dequantiseYaw8(q: number): number {
  const yaw = (q / 256) * Math.PI * 2
  return yaw > Math.PI ? yaw - Math.PI * 2 : yaw
}

export function encodeSurfTrack(
  track: readonly SurfTrackSample[],
  tickRate: number,
  startTick: number,
): Uint8Array {
  const out = new Uint8Array(GHOST_HEADER_BYTES + GHOST_SAMPLE_BYTES * track.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint8(4, VERSION)
  view.setUint8(5, 0)
  view.setUint16(6, tickRate, true)
  view.setUint32(8, startTick >>> 0, true)
  view.setUint32(12, track.length, true)
  let o = GHOST_HEADER_BYTES
  for (const s of track) {
    view.setInt32(o, quantiseCentimetres(s.x), true)
    view.setInt32(o + 4, quantiseCentimetres(s.y), true)
    view.setInt32(o + 8, quantiseCentimetres(s.z), true)
    view.setUint8(o + 12, quantiseYaw8(s.yaw))
    o += GHOST_SAMPLE_BYTES
  }
  return out
}

export function decodeSurfTrack(bytes: Uint8Array): DecodedGhost {
  if (bytes.byteLength < GHOST_HEADER_BYTES) throw new Error('ghost track: truncated header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('ghost track: bad magic')
  if (view.getUint8(4) !== VERSION) throw new Error('ghost track: unsupported version')
  const tickRate = view.getUint16(6, true)
  const startTick = view.getUint32(8, true)
  const count = view.getUint32(12, true)
  if (bytes.byteLength !== GHOST_HEADER_BYTES + count * GHOST_SAMPLE_BYTES)
    throw new Error('ghost track: length does not match its header')
  const samples: SurfTrackSample[] = []
  let o = GHOST_HEADER_BYTES
  for (let i = 0; i < count; i++) {
    samples.push({
      tick: startTick + i,
      x: view.getInt32(o, true) / 100,
      y: view.getInt32(o + 4, true) / 100,
      z: view.getInt32(o + 8, true) / 100,
      yaw: dequantiseYaw8(view.getUint8(o + 12)),
    })
    o += GHOST_SAMPLE_BYTES
  }
  return { tickRate, startTick, samples }
}
