import { describe, expect, it } from 'vitest'
import { Intents } from '@openvibe/shared'
import {
  KeyboardInputSource,
  type InputSample,
  type InputSource,
  type KeyboardState,
} from './inputSource.js'

/** A fake InputTracker key set (the real one needs a DOM). */
class FakeKeyboard implements KeyboardState {
  readonly keys = new Set<string>()
  yaw = 0
  pitch = 0
  keyDown(code: string): boolean {
    return this.keys.has(code)
  }
}

/** A synthetic touch pad: M2 ships the real one; this models the same stream. */
class TouchSource implements InputSource {
  yaw = 0
  pitch = 0
  moveX = 0
  moveZ = 0
  intents = 0
  sample(): InputSample {
    return {
      moveX: this.moveX,
      moveZ: this.moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      intents: this.intents,
    }
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

describe('input sources', () => {
  it('a keyboard and a touch source produce identical intent streams', () => {
    const keyboard = new FakeKeyboard()
    const keyboardSource = new KeyboardInputSource(keyboard)
    const touch = new TouchSource()

    const keyboardStream: InputSample[] = []
    const touchStream: InputSample[] = []
    for (const g of script) {
      keyboard.keys.clear()
      for (const code of keysFor(g)) keyboard.keys.add(code)
      keyboard.yaw = g.yaw
      keyboard.pitch = g.pitch
      touch.moveX = g.moveX
      touch.moveZ = g.moveZ
      touch.yaw = g.yaw
      touch.pitch = g.pitch
      touch.intents = g.intents
      keyboardStream.push(keyboardSource.sample())
      touchStream.push(touch.sample())
    }

    const expected = script.map((g) => g.intents)
    const fromKeyboard = keyboardStream.map((s) => s.intents)
    const fromTouch = touchStream.map((s) => s.intents)
    expect(fromKeyboard).toEqual(fromTouch)
    expect(fromKeyboard).toEqual(expected)
    // The view follows the device too: both sources report the scripted angle.
    expect(keyboardStream.map((s) => s.yaw)).toEqual(script.map((g) => g.yaw))
    expect(touchStream.map((s) => s.yaw)).toEqual(script.map((g) => g.yaw))
    // The stream really does exercise several distinct intents.
    expect(new Set(fromKeyboard).size).toBeGreaterThan(4)
  })
})
