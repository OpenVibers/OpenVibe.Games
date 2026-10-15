// KTX2 material textures (Games M6). The built-in surface textures ship as KTX2 (Basis ETC1S with mipmaps, made by
// scripts/encodeKtx2.sh): the GPU keeps them compressed (about a seventh of the memory of a decoded JPEG), they decode
// in workers instead of on the main thread, and they are a quarter smaller to download. Babylon's decoder is vendored
// same-origin in /ktx2/ (scripts/vendorKtx2.sh; Babylon's default is its CDN). Where the decoder cannot run (no
// WebAssembly or workers), when `?ktx2=0` or the `openvibe.ktx2` setting is off, or when a KTX2 fails to load, the
// JPEG beside it is used.
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Scene } from '@babylonjs/core/scene.js'

const BASE = '/ktx2/'

/** A texture reference: the URL to load and, for a KTX2, the JPEG to fall back to. */
export interface TexSource {
  url: string
  fallback?: string
}

function settingOff(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ktx2') === '0') return true
    if (typeof localStorage !== 'undefined' && localStorage.getItem('openvibe.ktx2') === 'off') return true
  } catch {
    /* storage blocked: the default stands */
  }
  return false
}

let support: boolean | null = null

/** Whether KTX2 textures are used here (decided once). */
export function ktx2Enabled(): boolean {
  if (support === null) support = typeof WebAssembly === 'object' && typeof Worker === 'function' && !settingOff()
  return support
}

/** Tests only: decide again. */
export function resetKtx2ForTests(value: boolean | null = null): void {
  support = value
}

let configured = false
function configure(): void {
  if (configured) return
  configured = true
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: `${BASE}babylon.ktx2Decoder.js`,
    jsMSCTranscoder: `${BASE}msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${BASE}msc_basis_transcoder.wasm`,
    wasmZSTDDecoder: `${BASE}zstddec.wasm`,
    wasmUASTCToASTC: `${BASE}uastc_astc.wasm`,
    wasmUASTCToBC7: `${BASE}uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM: `${BASE}uastc_rgba8_unorm_v2.wasm`,
    wasmUASTCToRGBA_SRGB: `${BASE}uastc_rgba8_srgb_v2.wasm`,
    wasmUASTCToR8_UNORM: `${BASE}uastc_r8_unorm.wasm`,
    wasmUASTCToRG8_UNORM: `${BASE}uastc_rg8_unorm.wasm`,
  }
}

/** A built-in surface texture by name: its KTX2 where KTX2 is used, else its JPEG. */
export function builtinTexSource(name: string): TexSource {
  const jpg = `/assets/tex/${name}.jpg`
  return ktx2Enabled() ? { url: `/assets/tex/${name}.ktx2`, fallback: jpg } : { url: jpg }
}

/**
 * The texture for a source. A KTX2 that fails to load (a decoder error, a missing file) switches to its JPEG, so a
 * surface is never left blank.
 */
export function loadTexture(src: TexSource, scene: Scene): Texture {
  if (!src.fallback || !src.url.endsWith('.ktx2')) return new Texture(src.url, scene)
  configure()
  let tx: Texture | null = null
  const fallBack = (): void => {
    if (tx && src.fallback) tx.updateURL(src.fallback)
  }
  tx = new Texture(src.url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, fallBack)
  return tx
}
