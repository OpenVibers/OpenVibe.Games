import { Intents } from '@openvibe/shared'

/** One simulation tick of intent input, independent of the device behind it. */
export interface InputSample {
  /** Strafe axis [-1,1], +X right. */
  moveX: number
  /** Forward axis [-1,1], +Z forward. */
  moveZ: number
  /** Absolute view yaw, radians. */
  yaw: number
  /** Absolute view pitch, radians (clamped to ±90°). */
  pitch: number
  /** Intent bitfield (see @openvibe/shared Intents). */
  intents: number
}

/**
 * Where movement input comes from. The protocol carries intents, not keys: a
 * keyboard/mouse source and a touch source (touchInputSource.ts) implement
 * it, both producing the same `InputSample`.
 */
export interface InputSource {
  /** Latest view yaw for the render camera (updates at frame rate). */
  readonly yaw: number
  /** Latest view pitch for the render camera (updates at frame rate). */
  readonly pitch: number
  /** Sample the current tick's intent input. */
  sample(): InputSample
}

/** The subset of InputTracker a keyboard source reads (DOM-free, so tests can fake it). */
export interface KeyboardState {
  keyDown(code: string): boolean
  readonly yaw: number
  readonly pitch: number
}

/** Keyboard + mouse: today's desktop bindings, mapped onto named intents. */
export class KeyboardInputSource implements InputSource {
  constructor(private readonly keys: KeyboardState) {}

  get yaw(): number {
    return this.keys.yaw
  }

  get pitch(): number {
    return this.keys.pitch
  }

  sample(): InputSample {
    const keys = this.keys
    let intents = 0
    if (keys.keyDown('Space')) intents |= Intents.Jump
    if (keys.keyDown('ShiftLeft')) intents |= Intents.Sprint
    if (keys.keyDown('ControlLeft') || keys.keyDown('KeyC')) intents |= Intents.Crouch
    if (keys.keyDown('KeyZ')) intents |= Intents.Prone
    const moveX = (keys.keyDown('KeyD') ? 1 : 0) - (keys.keyDown('KeyA') ? 1 : 0)
    const moveZ = (keys.keyDown('KeyW') ? 1 : 0) - (keys.keyDown('KeyS') ? 1 : 0)
    return { moveX, moveZ, yaw: keys.yaw, pitch: keys.pitch, intents }
  }
}

/**
 * The source the player is using right now. A device with both a keyboard
 * and a touch screen switches to whichever was used last; the simulation
 * keeps one InputSource and never notices.
 */
export class SwitchableInputSource implements InputSource {
  constructor(public current: InputSource) {}

  get yaw(): number {
    return this.current.yaw
  }

  get pitch(): number {
    return this.current.pitch
  }

  sample(): InputSample {
    return this.current.sample()
  }
}
