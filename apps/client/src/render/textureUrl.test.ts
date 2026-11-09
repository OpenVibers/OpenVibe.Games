import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '@babylonjs/core/scene.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { updateTextureUrl, guardTextureUpdates } from './textureUrl.js'

describe('updateTextureUrl', () => {
  let engine: NullEngine
  let scene: Scene

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
  })

  afterEach(() => {
    if (!scene.isDisposed) scene.dispose()
    engine.dispose()
  })

  it('skips a texture whose scene was disposed (the editor E2E pageerror)', () => {
    const tx = new Texture('/assets/tex/red_brick.ktx2', scene)
    scene.dispose()
    expect(tx.getScene()).toBeNull()
    // The unguarded call is what the browser reports as a page error.
    expect(() => tx.updateURL('/assets/tex/red_brick.jpg')).toThrow(/markAllMaterialsAsDirty/)
    expect(updateTextureUrl(tx, '/assets/tex/red_brick.jpg', scene)).toBe(false)
  })

  it('skips a texture disposed with its material while the scene lives', () => {
    const tx = new Texture('/assets/tex/red_brick.ktx2', scene)
    tx.dispose()
    expect(updateTextureUrl(tx, '/assets/tex/red_brick.jpg', scene)).toBe(false)
  })

  it('updates a live texture', () => {
    const tx = new Texture('/assets/tex/red_brick.ktx2', scene)
    expect(updateTextureUrl(tx, '/assets/tex/red_brick.jpg', scene)).toBe(true)
    expect(tx.url).toBe('/assets/tex/red_brick.jpg')
  })

  it('guards every texture a loader creates, even after the scene goes away', () => {
    const unguard = guardTextureUpdates(scene)
    const tx = new Texture('/assets/model/image.png', scene)
    scene.dispose()
    expect(() => tx.updateURL('/assets/model/other.png')).not.toThrow()
    expect(tx.url).toBe('/assets/model/image.png')
    unguard()
  })

  it('lets a live texture created under the guard update normally', () => {
    const unguard = guardTextureUpdates(scene)
    const tx = new Texture('/assets/model/image.png', scene)
    tx.updateURL('/assets/model/other.png')
    expect(tx.url).toBe('/assets/model/other.png')
    unguard()
  })
})
