import type { InputSample, InputSource } from './inputSource.js'

/**
 * Controls for a world seen from above (a creator world's `view: 'top'`, migration 0017): twin-stick style.
 *
 * The camera looks straight down with north (+Z) at the top of the screen, so the wrapped source's move axes are read
 * as SCREEN directions: W is up the screen, D is right, whatever way the character faces. The character faces the
 * mouse (or, with no mouse, the way it walks), and that facing is the yaw the simulation and the aim ray use. The
 * move axes are turned back into the simulation's yaw-relative ones (gameplay's simulate.ts wish direction), so the
 * server moves the player exactly where the screen says. Pitch stays tilted down, so the aim ray finds what is on the
 * ground just ahead (nodes, props) within reach.
 */
export const TOP_DOWN_AIM_PITCH = -0.55

/** Where the pointer is, relative to the player on screen: +x right, +y down (CSS pixels); null when unknown. */
export type PointerOffset = () => { x: number; y: number } | null

export class TopDownInputSource implements InputSource {
  private facing = 0

  constructor(
    private readonly inner: InputSource,
    private readonly pointer: PointerOffset,
  ) {}

  get yaw(): number {
    return this.facing
  }

  get pitch(): number {
    return TOP_DOWN_AIM_PITCH
  }

  /** Screen up is +Z, screen right is +X: a yaw of 0 faces up the screen. */
  private aim(): void {
    const p = this.pointer()
    if (p && Math.hypot(p.x, p.y) > 6) this.facing = Math.atan2(p.x, -p.y)
  }

  sample(): InputSample {
    const s = this.inner.sample()
    // The wrapped axes as a world direction (screen right = +X, screen up = +Z).
    const wx = s.moveX
    const wz = s.moveZ
    const moving = Math.hypot(wx, wz) > 1e-3
    const before = this.facing
    this.aim()
    // No pointer (touch, or it never moved): face the way you walk.
    if (this.facing === before && moving && !this.pointer()) this.facing = Math.atan2(wx, wz)
    const sy = Math.sin(this.facing)
    const cy = Math.cos(this.facing)
    return {
      moveX: cy * wx - sy * wz,
      moveZ: sy * wx + cy * wz,
      yaw: this.facing,
      pitch: TOP_DOWN_AIM_PITCH,
      intents: s.intents,
    }
  }
}
