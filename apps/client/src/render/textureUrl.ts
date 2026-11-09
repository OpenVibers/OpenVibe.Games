/**
 * Keep Babylon texture URL updates away from textures and scenes that are gone.
 *
 * Babylon's Texture.updateURL starts with `this.getScene().markAllMaterialsAsDirty(...)`.
 * Disposing a texture clears its scene, and disposing a scene is no place to
 * refresh materials either. An asynchronous load that loses the race — the KTX2
 * JPEG fallback after the editor replaced the material, or the glTF loader
 * finishing a model texture after the scene went away — reaches that line with
 * a null scene and throws "Cannot read properties of null (reading
 * 'markAllMaterialsAsDirty')". Skip the update instead.
 */
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Scene } from '@babylonjs/core/scene.js'

/** True when the texture was updated; false when it no longer has a live scene. */
export function updateTextureUrl(tx: Texture, url: string, scene: Scene): boolean {
  if (tx.getScene() !== scene || scene.isDisposed) return false
  tx.updateURL(url)
  return true
}

const alreadyGuarded = new WeakSet<Texture>()

/**
 * Guard every texture created until the returned function is called. The glTF
 * loader is not ours to change, but it creates a Texture for each image and
 * only calls updateURL once the bytes arrive, so a scene disposed in between
 * makes that call throw. Wrapping the textures it creates turns the race into a
 * skipped update instead of a page error.
 */
export function guardTextureUpdates(scene: Scene): () => void {
  const observer = scene.onNewTextureAddedObservable.add((texture) => {
    if (!(texture instanceof Texture) || alreadyGuarded.has(texture)) return
    alreadyGuarded.add(texture)
    const updateUrl = texture.updateURL
    texture.updateURL = function (url, buffer, onLoad, forcedExtension) {
      // Same rule as updateTextureUrl: no scene means the texture was disposed
      // with its material or its scene, so the material refresh would throw.
      // The scene can also be disposed while the loader is still parsing new
      // textures for it; those are no more useful than a disposed texture.
      if (!this.getScene() || scene.isDisposed) return
      updateUrl.call(this, url, buffer, onLoad, forcedExtension)
    }
  })
  return () => scene.onNewTextureAddedObservable.remove(observer)
}
