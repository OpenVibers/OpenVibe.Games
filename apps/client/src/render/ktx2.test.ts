import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scene } from '@babylonjs/core/scene.js'
import { builtinTexSource, ktx2Enabled, loadTexture, resetKtx2ForTests } from './ktx2'
import { resolveTexInfo } from './mapStyle'

/**
 * A Texture that does not touch the GPU: it records the error callback Babylon
 * would call when the KTX2 load fails, so the fallback path can be driven
 * directly. `getScene()` and `dispose()` follow Babylon's contract (dispose
 * clears the scene).
 */
const textureMock = vi.hoisted(() => ({
  scene: null as unknown,
  updateURL: vi.fn(),
  onError: null as null | (() => void),
  failInConstructor: false,
}))

vi.mock('@babylonjs/core/Materials/Textures/texture.js', () => ({
  Texture: class MockTexture {
    static readonly TRILLINEAR_SAMPLINGMODE = 3
    url: string
    constructor(
      url: string,
      scene: unknown,
      _noMipmap?: boolean,
      _invertY?: boolean,
      _samplingMode?: number,
      _onLoad?: unknown,
      onError?: () => void,
    ) {
      this.url = url
      textureMock.scene = scene
      textureMock.onError = onError ?? null
      if (textureMock.failInConstructor) onError?.()
    }
    getScene(): unknown {
      return textureMock.scene
    }
    updateURL(url: string): void {
      textureMock.updateURL(url)
      this.url = url
    }
    dispose(): void {
      textureMock.scene = null
    }
  },
}))

describe('KTX2 material textures (Games M6)', () => {
  afterEach(() => {
    resetKtx2ForTests(null)
    vi.unstubAllGlobals()
  })

  it('a built-in texture loads its KTX2 with the JPEG as the fallback', () => {
    resetKtx2ForTests(true)
    expect(builtinTexSource('red_brick')).toEqual({
      url: '/assets/tex/red_brick.ktx2',
      fallback: '/assets/tex/red_brick.jpg',
    })
    expect(resolveTexInfo('leafy_grass')).toEqual({
      url: '/assets/tex/leafy_grass.ktx2',
      fallback: '/assets/tex/leafy_grass.jpg',
    })
  })

  it('without KTX2 the JPEG alone', () => {
    resetKtx2ForTests(false)
    expect(builtinTexSource('red_brick')).toEqual({ url: '/assets/tex/red_brick.jpg' })
    expect(resolveTexInfo('none')).toBeNull()
  })

  it('needs WebAssembly and workers, and honours ?ktx2=0', () => {
    resetKtx2ForTests(null)
    vi.stubGlobal('WebAssembly', {})
    vi.stubGlobal('Worker', function Worker() {})
    vi.stubGlobal('location', { search: '' })
    expect(ktx2Enabled()).toBe(true)
    resetKtx2ForTests(null)
    vi.stubGlobal('location', { search: '?ktx2=0' })
    expect(ktx2Enabled()).toBe(false)
    resetKtx2ForTests(null)
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('Worker', undefined)
    expect(ktx2Enabled()).toBe(false)
  })
})

describe('loadTexture KTX2 fallback', () => {
  const liveScene = (): { isDisposed: boolean } => ({ isDisposed: false })
  const asScene = (scene: { isDisposed: boolean }): Scene => scene as unknown as Scene

  afterEach(() => {
    textureMock.updateURL.mockClear()
    textureMock.onError = null
    textureMock.failInConstructor = false
    textureMock.scene = null
  })

  it('switches to the JPEG when the KTX2 fails', () => {
    const scene = liveScene()
    loadTexture(
      { url: '/assets/tex/red_brick.ktx2', fallback: '/assets/tex/red_brick.jpg' },
      asScene(scene),
    )
    expect(textureMock.onError).toBeTypeOf('function')
    textureMock.onError!()
    expect(textureMock.updateURL).toHaveBeenCalledWith('/assets/tex/red_brick.jpg')
  })

  it('does not retry the fallback after the texture was disposed', () => {
    const scene = liveScene()
    const tx = loadTexture(
      { url: '/assets/tex/red_brick.ktx2', fallback: '/assets/tex/red_brick.jpg' },
      asScene(scene),
    )
    tx.dispose()
    textureMock.onError!()
    expect(textureMock.updateURL).not.toHaveBeenCalled()
  })

  it('does not retry the fallback after the scene was disposed', () => {
    const scene = liveScene()
    loadTexture(
      { url: '/assets/tex/red_brick.ktx2', fallback: '/assets/tex/red_brick.jpg' },
      asScene(scene),
    )
    scene.isDisposed = true
    textureMock.onError!()
    expect(textureMock.updateURL).not.toHaveBeenCalled()
  })

  it('still falls back when the decoder fails inside the constructor', () => {
    textureMock.failInConstructor = true
    const scene = liveScene()
    loadTexture(
      { url: '/assets/tex/red_brick.ktx2', fallback: '/assets/tex/red_brick.jpg' },
      asScene(scene),
    )
    expect(textureMock.updateURL).toHaveBeenCalledWith('/assets/tex/red_brick.jpg')
  })
})
