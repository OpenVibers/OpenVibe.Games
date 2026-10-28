// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Bindings } from '@openvibe/shared'
import { InputTracker } from './inputTracker.js'

function setup(pointerLock: boolean) {
  document.body.innerHTML = '<canvas id="game"></canvas><button id="hud">Inventory</button>'
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const hud = document.getElementById('hud') as HTMLButtonElement
  canvas.requestPointerLock = (() => undefined) as never
  const input = new InputTracker(canvas)
  input.pointerLock = pointerLock
  const actions: string[] = []
  const wheel: number[] = []
  input.onAction = (a) => actions.push(a.kind)
  input.onWheel = (d) => wheel.push(d)
  const press = (target: Element, buttons: number) =>
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, buttons }))
  const release = (target: Element) =>
    target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, buttons: 0 }))
  const scroll = (target: Element) =>
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
  return { canvas, hud, input, actions, wheel, press, release, scroll }
}

describe('input tracker presses', () => {
  it('acts on a press on the game canvas in a world seen from above (no pointer lock)', () => {
    const { canvas, hud, actions, wheel, press, release, scroll } = setup(false)
    press(canvas, 1)
    release(canvas)
    press(canvas, 2)
    expect(actions).toEqual(['primary_down', 'primary_up', 'rmb_down'])
    scroll(canvas)
    expect(wheel).toEqual([1])
    // The HUD and the menus keep their own clicks and wheel.
    actions.length = 0
    press(hud, 1)
    scroll(hud)
    expect(actions.filter((a) => a !== 'primary_up')).toEqual([])
    expect(wheel).toEqual([1])
  })

  it('still waits for the pointer lock in first person', () => {
    const { canvas, actions, wheel, press, scroll } = setup(true)
    press(canvas, 1)
    scroll(canvas)
    expect(actions).toEqual([])
    expect(wheel).toEqual([])
  })

  it('routes a bound key to onBind instead of the stock action table', () => {
    const { input, actions } = setup(false)
    input.bindings = new Bindings({ storage: null, defaults: { space: '+jump', r: '+restart' } })
    const bound: [string, boolean][] = []
    input.onBind = (command, down) => bound.push([command, down])
    const press = (code: string) =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true }),
      )
    const release = (code: string) =>
      document.body.dispatchEvent(
        new KeyboardEvent('keyup', { code, key: code, bubbles: true, cancelable: true }),
      )
    press('Space')
    expect(bound).toEqual([['+jump', true]])
    expect(input.keyDown('Space')).toBe(true)
    release('Space')
    expect(bound).toEqual([
      ['+jump', true],
      ['+jump', false],
    ])
    // R would normally reload; the bind wins, and no stock action fires.
    press('KeyR')
    expect(bound.at(-1)).toEqual(['+restart', true])
    expect(actions).toEqual([])
  })

  it('ignores keys aimed at a text input, even with no UI capture', () => {
    const { input, actions } = setup(false)
    const field = document.createElement('input')
    document.body.append(field)
    field.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }),
    )
    expect(input.keyDown('Space')).toBe(false)
    field.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true, cancelable: true }),
    )
    expect(actions).toEqual([])
  })
})
