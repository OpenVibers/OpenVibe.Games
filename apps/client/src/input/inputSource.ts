import {
  Intents,
  intentCommand,
  keyCodeFor,
  type Bindings,
  type IntentName,
} from '@openvibe/shared'

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

/** Keyboard + mouse: Source key bindings, mapped onto named intents. */
export class KeyboardInputSource implements InputSource {
  /** Console-typed `+jump` / `-jump`, independent of the physical keys. */
  private manualIntents = 0

  constructor(
    private readonly keys: KeyboardState,
    /** When present, the player's binds replace the stock intent keys. */
    private readonly bindings: Bindings | null = null,
  ) {}

  /** A `+`/`-` command typed in the console feeds the same intent bits as a key. */
  setManualIntent(name: string, down: boolean): void {
    const bit = Intents[name as IntentName]
    if (typeof bit !== 'number') return
    this.manualIntents = down ? this.manualIntents | bit : this.manualIntents & ~bit
  }

  get yaw(): number {
    return this.keys.yaw
  }

  get pitch(): number {
    return this.keys.pitch
  }

  sample(): InputSample {
    const keys = this.keys
    let intents = this.manualIntents
    if (this.bindings) {
      for (const binding of this.bindings.entries()) {
        const code = keyCodeFor(binding.key)
        if (!code || !keys.keyDown(code)) continue
        const intent = intentCommand(binding.command)
        if (intent?.down) intents |= Intents[intent.name]
      }
    } else {
      // No console mounted (unit tests, embeds): the stock controls remain.
      if (keys.keyDown('Space')) intents |= Intents.Jump
      if (keys.keyDown('ShiftLeft')) intents |= Intents.Sprint
      if (keys.keyDown('ControlLeft') || keys.keyDown('KeyC')) intents |= Intents.Crouch
      if (keys.keyDown('KeyZ')) intents |= Intents.Prone
    }
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
