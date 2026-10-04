import { Intents } from '@openvibe/shared'
import type { InputSample, InputSource } from './inputSource.js'
import type { InputAction } from './inputTracker.js'

/** Stick deflection (in stick radii) below which the stick reads as centred. */
export const STICK_DEAD_ZONE = 0.15
/** Same limit as InputTracker: never look straight up or down. */
const PITCH_LIMIT = Math.PI / 2 - 0.01
/** A sprint press shorter than this latches sprint on; a longer one is a hold. */
const SPRINT_TAP_MS = 250

/** Buttons that hold an intent bit while pressed. */
export type IntentButton = 'jump' | 'sprint' | 'crouch' | 'prone'
/** Buttons that emit InputActions, routed like InputTracker's. */
export type ActionButton = 'use' | 'primary' | 'menu'
export type TouchButton = IntentButton | ActionButton

/** What a touch source reads (DOM-free, like KeyboardState). */
export interface TouchState {
  /** Raw stick deflection in stick radii, +x right; unclamped. */
  readonly stickX: number
  /** Raw stick deflection in stick radii, +y forward (up the screen); unclamped. */
  readonly stickY: number
  readonly yaw: number
  readonly pitch: number
  held(button: IntentButton): boolean
}

/**
 * Stick deflection → move vector: a radial dead zone, rescaled so motion
 * starts from zero at its edge, and the length clamped to 1.
 */
export function stickVector(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y)
  if (len <= STICK_DEAD_ZONE) return { x: 0, y: 0 }
  const scale = (Math.min(len, 1) - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE) / len
  return { x: x * scale, y: y * scale }
}

const INTENT_BITS: Record<IntentButton, number> = {
  jump: Intents.Jump,
  sprint: Intents.Sprint,
  crouch: Intents.Crouch,
  prone: Intents.Prone,
}

/** Touch: the on-screen stick, look drag and buttons, mapped onto the same intents. */
export class TouchInputSource implements InputSource {
  constructor(private readonly touch: TouchState) {}

  get yaw(): number {
    return this.touch.yaw
  }

  get pitch(): number {
    return this.touch.pitch
  }

  sample(): InputSample {
    const touch = this.touch
    let intents = 0
    for (const button of Object.keys(INTENT_BITS) as IntentButton[]) {
      if (touch.held(button)) intents |= INTENT_BITS[button]
    }
    const move = stickVector(touch.stickX, touch.stickY)
    return { moveX: move.x, moveZ: move.y, yaw: touch.yaw, pitch: touch.pitch, intents }
  }
}

type Finger =
  | { role: 'stick'; originX: number; originY: number }
  | { role: 'look'; lastX: number; lastY: number }
  | { role: 'button'; button: TouchButton }

/**
 * Gesture → state, keyed by pointer id so the stick, the look drag and the
 * buttons work at once. Coordinates are CSS pixels; the DOM layer
 * (touchControls.ts) only forwards pointer events here.
 */
export class TouchPad implements TouchState {
  yaw = 0
  pitch = 0
  /** Radians per CSS pixel of look drag. */
  sensitivity = 0.006
  /** Stick radius in CSS pixels: a drag this far is full deflection. */
  stickRadius = 60
  stickX = 0
  stickY = 0
  /** UI-open state: no intents, no movement, no new actions. */
  uiCapture = false

  onAction: ((action: InputAction) => void) | null = null
  /** When this returns true, look drag is redirected to rotate_held. */
  captureLook: (() => boolean) | null = null

  private fingers = new Map<number, Finger>()
  /** Start time of the sprint press in progress, or null. */
  private sprintPress: number | null = null
  private sprintLatched = false

  held(button: IntentButton): boolean {
    if (this.uiCapture) return false
    if (button === 'sprint') return this.sprintLatched || this.sprintPress !== null
    for (const f of this.fingers.values()) {
      if (f.role === 'button' && f.button === button) return true
    }
    return false
  }

  /** A finger lands on the stick whose centre is at (originX, originY). */
  stickDown(id: number, x: number, y: number, originX = x, originY = y): void {
    if (this.uiCapture) return
    this.fingers.set(id, { role: 'stick', originX, originY })
    this.moveStick(originX, originY, x, y)
  }

  /** A finger lands on the look area. */
  lookDown(id: number, x: number, y: number): void {
    if (this.uiCapture) return
    this.fingers.set(id, { role: 'look', lastX: x, lastY: y })
  }

  buttonDown(id: number, button: TouchButton, now: number): void {
    if (this.uiCapture) return
    this.fingers.set(id, { role: 'button', button })
    switch (button) {
      case 'sprint':
        // Pressing a latched sprint turns it off; otherwise sprint holds and
        // the release decides whether it latches.
        if (this.sprintLatched) this.sprintLatched = false
        else this.sprintPress = now
        return
      case 'use':
        this.onAction?.({ kind: 'use_down' })
        return
      case 'primary':
        this.onAction?.({ kind: 'primary_down' })
        return
      case 'menu':
        this.onAction?.({ kind: 'toggle_menu' })
        return
    }
  }

  move(id: number, x: number, y: number): void {
    const f = this.fingers.get(id)
    if (!f) return
    if (f.role === 'stick') {
      this.moveStick(f.originX, f.originY, x, y)
    } else if (f.role === 'look') {
      const dx = x - f.lastX
      const dy = y - f.lastY
      f.lastX = x
      f.lastY = y
      if (this.captureLook?.()) {
        this.onAction?.({ kind: 'rotate_held', dyaw: dx * 0.005, dpitch: dy * 0.005 })
        return
      }
      this.yaw += dx * this.sensitivity
      this.pitch -= dy * this.sensitivity
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))
    }
  }

  /** A finger lifts (or the browser cancels it). Releases always fire. */
  up(id: number, now: number): void {
    const f = this.fingers.get(id)
    if (!f) return
    this.fingers.delete(id)
    if (f.role === 'stick') {
      this.stickX = 0
      this.stickY = 0
    } else if (f.role === 'button') {
      if (f.button === 'sprint' && this.sprintPress !== null) {
        if (now - this.sprintPress < SPRINT_TAP_MS) this.sprintLatched = true
        this.sprintPress = null
      } else if (f.button === 'use') {
        this.onAction?.({ kind: 'use_up' })
      } else if (f.button === 'primary') {
        this.onAction?.({ kind: 'primary_up' })
      }
    }
  }

  /** Lift every finger and drop the sprint latch (menu opened, page hidden, source switched). */
  releaseAll(now: number): void {
    for (const id of [...this.fingers.keys()]) this.up(id, now)
    this.sprintLatched = false
  }

  private moveStick(originX: number, originY: number, x: number, y: number): void {
    this.stickX = (x - originX) / this.stickRadius
    this.stickY = (originY - y) / this.stickRadius
  }
}
