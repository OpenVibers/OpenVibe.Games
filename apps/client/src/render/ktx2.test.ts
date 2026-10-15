import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinTexSource, ktx2Enabled, resetKtx2ForTests } from './ktx2'
import { resolveTexInfo } from './mapStyle'

describe('KTX2 material textures (Games M6)', () => {
  afterEach(() => {
    resetKtx2ForTests(null)
    vi.unstubAllGlobals()
  })

  it('a built-in texture loads its KTX2 with the JPEG as the fallback', () => {
    resetKtx2ForTests(true)
    expect(builtinTexSource('red_brick')).toEqual({ url: '/assets/tex/red_brick.ktx2', fallback: '/assets/tex/red_brick.jpg' })
    expect(resolveTexInfo('leafy_grass')).toEqual({ url: '/assets/tex/leafy_grass.ktx2', fallback: '/assets/tex/leafy_grass.jpg' })
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
