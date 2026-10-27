// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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
  return { canvas, hud, actions, wheel, press, release, scroll }
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
})
