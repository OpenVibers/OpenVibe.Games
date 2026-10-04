import { describe, expect, it } from 'vitest'
import { Intents } from '@openvibe/shared'
import {
  KeyboardInputSource,
  SwitchableInputSource,
  type InputSample,
  type KeyboardState,
} from './inputSource.js'
import type { InputAction } from './inputTracker.js'
import {
  STICK_DEAD_ZONE,
  TouchInputSource,
  TouchPad,
  stickVector,
  type IntentButton,
} from './touchInputSource.js'

/** A fake InputTracker key set (the real one needs a DOM). */
class FakeKeyboard implements KeyboardState {
  readonly keys = new Set<string>()
  yaw = 0
  pitch = 0
  keyDown(code: string): boolean {
    return this.keys.has(code)
  }
}

/** One gesture, expressed once and played on both devices. */
interface Gesture {
  intents: number
  moveX: number
  moveZ: number
  yaw: number
  pitch: number
}

const script: Gesture[] = [
  { intents: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 },
  { intents: Intents.Jump, moveX: 0, moveZ: 1, yaw: 0.3, pitch: -0.2 },
  { intents: Intents.Jump | Intents.Sprint, moveX: 0.2, moveZ: 1, yaw: 0.3, pitch: -0.2 },
  { intents: Intents.Sprint, moveX: -1, moveZ: 0.4, yaw: -0.7, pitch: 0 },
  { intents: Intents.Crouch, moveX: 0.6, moveZ: 1, yaw: 1.1, pitch: 0.4 },
  { intents: Intents.Crouch | Intents.Prone, moveX: 0, moveZ: 0, yaw: 1.1, pitch: 0.4 },
  { intents: Intents.Prone, moveX: 0, moveZ: -1, yaw: -3.0, pitch: -0.5 },
  { intents: 0, moveX: 0, moveZ: 0, yaw: -3.0, pitch: 0 },
  { intents: Intents.Jump | Intents.Crouch, moveX: -0.5, moveZ: -0.5, yaw: 3.0, pitch: 0.1 },
]

/** The desktop keys that express a gesture (mirrors KeyboardInputSource). */
function keysFor(g: Gesture): string[] {
  const keys: string[] = []
  if (g.intents & Intents.Jump) keys.push('Space')
  if (g.intents & Intents.Sprint) keys.push('ShiftLeft')
  if (g.intents & Intents.Crouch) keys.push('KeyC')
  if (g.intents & Intents.Prone) keys.push('KeyZ')
  if (g.moveX > 0) keys.push('KeyD')
  if (g.moveX < 0) keys.push('KeyA')
  if (g.moveZ > 0) keys.push('KeyW')
  if (g.moveZ < 0) keys.push('KeyS')
  return keys
}

/** The touch buttons that express a gesture's intents. */
function buttonsFor(g: Gesture): IntentButton[] {
  const buttons: IntentButton[] = []
  if (g.intents & Intents.Jump) buttons.push('jump')
  if (g.intents & Intents.Sprint) buttons.push('sprint')
  if (g.intents & Intents.Crouch) buttons.push('crouch')
  if (g.intents & Intents.Prone) buttons.push('prone')
  return buttons
}

const LIMIT = Math.PI / 2 - 0.01
/** Stick centre on screen, CSS px. */
const OX = 100
const OY = 500
/** Look drag start on screen, CSS px. */
const LX = 900
const LY = 300

/** Plays a gesture with fingers on a real TouchPad; returns the ids to lift. */
function play(pad: TouchPad, g: Gesture, firstId: number): number[] {
  const ids: number[] = []
  let id = firstId
  for (const b of buttonsFor(g)) {
    pad.buttonDown(id, b, 0)
    ids.push(id++)
  }
  if (g.moveX !== 0 || g.moveZ !== 0) {
    const r = pad.stickRadius
    pad.stickDown(id, OX + g.moveX * r, OY - g.moveZ * r, OX, OY)
    ids.push(id++)
  }
  pad.lookDown(id, LX, LY)
  pad.move(
    id,
    LX + (g.yaw - pad.yaw) / pad.sensitivity,
    LY - (g.pitch - pad.pitch) / pad.sensitivity,
  )
  ids.push(id)
  return ids
}

describe('input sources', () => {
  it('a keyboard and a touch source produce identical intent streams', () => {
    const keyboard = new FakeKeyboard()
    const keyboardSource = new KeyboardInputSource(keyboard)
    const pad = new TouchPad()
    const touch = new TouchInputSource(pad)

    const keyboardStream: InputSample[] = []
    const touchStream: InputSample[] = []
    let nextId = 1
    for (const g of script) {
      keyboard.keys.clear()
      for (const code of keysFor(g)) keyboard.keys.add(code)
      keyboard.yaw = g.yaw
      keyboard.pitch = g.pitch
      const fingers = play(pad, g, nextId)
      nextId += fingers.length
      keyboardStream.push(keyboardSource.sample())
      touchStream.push(touch.sample())
      // Held well past a tap, so sprint never latches between gestures.
      for (const id of fingers) pad.up(id, 1000)
    }

    const expected = script.map((g) => g.intents)
    const fromKeyboard = keyboardStream.map((s) => s.intents)
    const fromTouch = touchStream.map((s) => s.intents)
    expect(fromKeyboard).toEqual(fromTouch)
    expect(fromKeyboard).toEqual(expected)
    // The view follows the device too: both sources report the scripted angle.
    expect(keyboardStream.map((s) => s.yaw)).toEqual(script.map((g) => g.yaw))
    touchStream.forEach((s, i) => {
      expect(s.yaw).toBeCloseTo(script[i]!.yaw, 9)
      expect(s.pitch).toBeCloseTo(script[i]!.pitch, 9)
    })
    // Same direction of travel: the stick is analog, the keys are not.
    expect(touchStream.map((s) => [Math.sign(s.moveX), Math.sign(s.moveZ)])).toEqual(
      keyboardStream.map((s) => [Math.sign(s.moveX), Math.sign(s.moveZ)]),
    )
    // The stream really does exercise several distinct intents.
    expect(new Set(fromKeyboard).size).toBeGreaterThan(4)
  })

  it('the switchable source samples whichever device is current', () => {
    const keyboard = new FakeKeyboard()
    keyboard.keys.add('Space')
    keyboard.yaw = 0.5
    const pad = new TouchPad()
    pad.buttonDown(1, 'crouch', 0)
    const source = new SwitchableInputSource(new KeyboardInputSource(keyboard))
    expect(source.sample().intents).toBe(Intents.Jump)
    expect(source.yaw).toBe(0.5)
    source.current = new TouchInputSource(pad)
    expect(source.sample().intents).toBe(Intents.Crouch)
    expect(source.yaw).toBe(0)
  })
})

describe('touch input', () => {
  it('a stick inside the dead zone reads as centred', () => {
    expect(stickVector(0.1, 0)).toEqual({ x: 0, y: 0 })
    expect(stickVector(0.1, -0.1)).toEqual({ x: 0, y: 0 })
    expect(stickVector(0, STICK_DEAD_ZONE)).toEqual({ x: 0, y: 0 })
    const pad = new TouchPad()
    const source = new TouchInputSource(pad)
    pad.stickDown(1, OX + pad.stickRadius * 0.1, OY, OX, OY)
    expect(source.sample()).toMatchObject({ moveX: 0, moveZ: 0 })
    // Just past the edge, motion starts from zero rather than jumping.
    const edge = stickVector(0, STICK_DEAD_ZONE + 0.01)
    expect(edge.x).toBe(0)
    expect(edge.y).toBeGreaterThan(0)
    expect(edge.y).toBeLessThan(0.02)
  })

  it('the stick vector is clamped to length 1, keeping its direction', () => {
    const far = stickVector(3, 4)
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 12)
    expect(far.x / far.y).toBeCloseTo(3 / 4, 12)
    const diagonal = stickVector(1, 1)
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 12)
    const pad = new TouchPad()
    const source = new TouchInputSource(pad)
    // Dragged well outside the base, up and to the left: forward-left at full speed.
    pad.stickDown(1, OX - 5 * pad.stickRadius, OY - 5 * pad.stickRadius, OX, OY)
    const s = source.sample()
    expect(s.moveX).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(s.moveZ).toBeCloseTo(Math.SQRT1_2, 12)
    expect(s.moveX).toBeGreaterThanOrEqual(-1)
    expect(s.moveZ).toBeLessThanOrEqual(1)
  })

  it('look drag clamps pitch exactly like InputTracker', () => {
    const pad = new TouchPad()
    pad.lookDown(1, LX, LY)
    pad.move(1, LX, LY - 100_000) // drag up: look up
    expect(pad.pitch).toBe(LIMIT)
    pad.move(1, LX, LY + 100_000) // drag down: look down
    expect(pad.pitch).toBe(-LIMIT)
    pad.move(1, LX + 10, LY + 100_000) // drag right: yaw grows, pitch stays pinned
    expect(pad.yaw).toBeCloseTo(10 * pad.sensitivity, 12)
    expect(pad.pitch).toBe(-LIMIT)
  })

  it('stick, look and buttons work at once, each finger by its own pointer id', () => {
    const pad = new TouchPad()
    const source = new TouchInputSource(pad)
    pad.stickDown(1, OX, OY - pad.stickRadius, OX, OY) // full forward
    pad.lookDown(2, LX, LY)
    pad.buttonDown(3, 'jump', 0)
    pad.move(2, LX + 50, LY) // the look finger turns...
    pad.move(1, OX + pad.stickRadius, OY) // ...while the stick swings right
    let s = source.sample()
    expect(s.yaw).toBeCloseTo(50 * pad.sensitivity, 12)
    expect(s.moveX).toBeCloseTo(1, 12)
    expect(s.moveZ).toBeCloseTo(0, 12)
    expect(s.intents).toBe(Intents.Jump)
    // Lifting the look finger leaves the stick and the button alone.
    pad.up(2, 100)
    pad.move(2, LX + 500, LY)
    s = source.sample()
    expect(s.yaw).toBeCloseTo(50 * pad.sensitivity, 12)
    expect(s.moveX).toBeCloseTo(1, 12)
    expect(s.intents).toBe(Intents.Jump)
    // A finger the pad never saw (a HUD tap) changes nothing.
    pad.move(9, 0, 0)
    pad.up(9, 100)
    expect(source.sample()).toEqual(s)
  })

  it('lifting fingers clears intents and movement', () => {
    const pad = new TouchPad()
    const source = new TouchInputSource(pad)
    pad.buttonDown(1, 'jump', 0)
    pad.buttonDown(2, 'crouch', 0)
    pad.buttonDown(3, 'prone', 0)
    pad.buttonDown(4, 'sprint', 0)
    pad.stickDown(5, OX, OY - pad.stickRadius, OX, OY)
    expect(source.sample().intents).toBe(
      Intents.Jump | Intents.Crouch | Intents.Prone | Intents.Sprint,
    )
    for (const id of [1, 2, 3, 4, 5]) pad.up(id, 1000)
    expect(source.sample()).toMatchObject({ moveX: 0, moveZ: 0, intents: 0 })

    // releaseAll (menu opened, tab hidden) lifts everything, latch included.
    pad.buttonDown(6, 'sprint', 0)
    pad.up(6, 50) // a tap latches sprint on
    pad.buttonDown(7, 'jump', 100)
    pad.stickDown(8, OX + 30, OY, OX, OY)
    expect(source.sample().intents).toBe(Intents.Sprint | Intents.Jump)
    pad.releaseAll(200)
    expect(source.sample()).toMatchObject({ moveX: 0, moveZ: 0, intents: 0 })
  })

  it('sprint latches on a tap, holds on a long press, and a second press unlatches', () => {
    const pad = new TouchPad()
    const source = new TouchInputSource(pad)
    pad.buttonDown(1, 'sprint', 0)
    pad.up(1, 1000) // long press: hold only
    expect(source.sample().intents).toBe(0)
    pad.buttonDown(2, 'sprint', 2000)
    pad.up(2, 2100) // tap: latched
    expect(source.sample().intents).toBe(Intents.Sprint)
    pad.buttonDown(3, 'sprint', 3000) // press again: off at once
    expect(source.sample().intents).toBe(0)
    pad.up(3, 3050)
    expect(source.sample().intents).toBe(0)
  })

  it('use and primary emit the same actions as E and the left mouse button', () => {
    const pad = new TouchPad()
    const actions: InputAction['kind'][] = []
    pad.onAction = (a) => actions.push(a.kind)
    pad.buttonDown(1, 'use', 0)
    pad.up(1, 10)
    pad.buttonDown(2, 'primary', 20)
    pad.buttonDown(3, 'menu', 30)
    // The menu opens mid-grab: the release still fires, new presses do not.
    pad.uiCapture = true
    pad.up(2, 40)
    pad.buttonDown(4, 'use', 50)
    pad.buttonDown(5, 'jump', 50)
    expect(actions).toEqual(['use_down', 'use_up', 'primary_down', 'toggle_menu', 'primary_up'])
    expect(pad.held('jump')).toBe(false)
  })

  it('look drag is redirected to rotate_held while a held prop is rotating', () => {
    const pad = new TouchPad()
    const actions: InputAction[] = []
    pad.onAction = (a) => actions.push(a)
    pad.captureLook = () => true
    pad.lookDown(1, LX, LY)
    pad.move(1, LX + 20, LY - 10)
    expect(pad.yaw).toBe(0)
    expect(pad.pitch).toBe(0)
    expect(actions).toEqual([{ kind: 'rotate_held', dyaw: 20 * 0.005, dpitch: -10 * 0.005 }])
  })
})
