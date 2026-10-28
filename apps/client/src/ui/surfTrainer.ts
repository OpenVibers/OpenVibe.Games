import type { TouchPad } from '../input/touchInputSource.js'

/**
 * Touch's Ride control: two big strafe zones (left/right) and drag-to-look.
 * It is deliberately a trainer, not a virtual stick: surf is about holding a
 * direction into the ramp and turning, and two thumb-sized zones make that
 * possible on a phone. The zones drive the same TouchPad the rest of the
 * game uses, so prediction and intent bits are identical.
 */
export class SurfTrainer {
  private readonly root: HTMLElement
  private readonly look: HTMLElement
  private active = false

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly pad: TouchPad,
    private readonly onRestart: () => void,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'surf-trainer'
    this.root.hidden = true
    this.look = document.createElement('div')
    this.look.className = 'surf-trainer-look'
    this.look.setAttribute('aria-hidden', 'true')
    const left = this.zone('left', '◀ hold left', -1)
    const right = this.zone('right', 'hold right ▶', 1)
    const restart = document.createElement('button')
    restart.type = 'button'
    restart.className = 'surf-trainer-restart'
    restart.textContent = 'Restart'
    restart.addEventListener('click', () => this.onRestart())
    this.root.append(this.look, left, right, restart)
    parent.append(this.root)
    this.bindLook()
  }

  setActive(active: boolean): void {
    this.active = active
    this.root.hidden = !active
    if (!active) this.pad.releaseAll(performance.now())
    this.canvas.style.touchAction = active ? 'none' : ''
  }

  private zone(side: 'left' | 'right', label: string, sign: -1 | 1): HTMLElement {
    const zone = document.createElement('button')
    zone.type = 'button'
    zone.className = `surf-trainer-strafe surf-trainer-${side}`
    zone.textContent = label
    zone.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return
      e.preventDefault()
      zone.setPointerCapture(e.pointerId)
      const r = zone.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      this.pad.stickRadius = r.width / 2
      this.pad.stickDown(e.pointerId, cx, cy, cx, cy)
      this.pad.move(e.pointerId, cx + sign * r.width, cy)
    })
    const lift = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      this.pad.up(e.pointerId, e.timeStamp)
    }
    zone.addEventListener('pointerup', lift)
    zone.addEventListener('pointercancel', lift)
    return zone
  }

  private bindLook(): void {
    this.look.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return
      e.preventDefault()
      this.look.setPointerCapture(e.pointerId)
      this.pad.lookDown(e.pointerId, e.clientX, e.clientY)
    })
    // TouchControls' window-level pointermove already forwards the look
    // finger to the same TouchPad; registering it again would double the
    // sensitivity.
    const lift = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      this.pad.up(e.pointerId, e.timeStamp)
    }
    this.look.addEventListener('pointerup', lift)
    this.look.addEventListener('pointercancel', lift)
  }
}
