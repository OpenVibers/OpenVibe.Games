import type { TouchButton, TouchPad } from './touchInputSource.js'

/**
 * The on-screen touch overlay: a stick bottom-left, buttons bottom-right,
 * and right-half drags on the canvas for look. This is only the DOM binding
 * — every gesture is forwarded to a TouchPad, which owns the state.
 *
 * Only pointers with pointerType 'touch' are handled; a mouse or pen on a
 * touch laptop stays with InputTracker.
 */
export class TouchControls {
  private readonly root: HTMLElement
  private readonly base: HTMLElement
  private readonly knob: HTMLElement
  private readonly buttons = new Map<TouchButton, HTMLElement>()
  private stickFinger: number | null = null
  private active = false
  private uiCapture = false

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly pad: TouchPad,
  ) {
    injectStyles()
    this.root = el('div', 'ov-touch')
    this.root.hidden = true
    this.base = el('div', 'ov-touch-stick')
    this.knob = el('div', 'ov-touch-knob')
    this.base.append(this.knob)
    const grid = el('div', 'ov-touch-buttons')
    for (const [button, label] of BUTTONS) {
      const b = el('button', `ov-touch-btn ov-touch-${button}`)
      b.textContent = label
      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return
        e.preventDefault()
        b.setPointerCapture(e.pointerId)
        this.pad.buttonDown(e.pointerId, button, e.timeStamp)
        this.refresh()
      })
      this.buttons.set(button, b)
      grid.append(b)
    }
    this.root.append(this.base, grid)
    parent.append(this.root)

    this.base.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return
      e.preventDefault()
      this.base.setPointerCapture(e.pointerId)
      const r = this.base.getBoundingClientRect()
      this.pad.stickRadius = r.width / 2
      this.pad.stickDown(
        e.pointerId,
        e.clientX,
        e.clientY,
        r.left + r.width / 2,
        r.top + r.height / 2,
      )
      this.stickFinger = e.pointerId
      this.refresh()
    })
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !this.visible) return
      e.preventDefault()
      if (e.clientX >= window.innerWidth / 2) this.pad.lookDown(e.pointerId, e.clientX, e.clientY)
    })
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') return
      this.pad.move(e.pointerId, e.clientX, e.clientY)
      if (e.pointerId === this.stickFinger) this.refresh()
    })
    const lift = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      this.pad.up(e.pointerId, e.timeStamp)
      if (e.pointerId === this.stickFinger) this.stickFinger = null
      this.refresh()
    }
    window.addEventListener('pointerup', lift)
    window.addEventListener('pointercancel', lift)
    window.addEventListener('blur', () => this.releaseAll())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll()
    })
  }

  /** Whether touch is the active input source. */
  setActive(active: boolean): void {
    this.active = active
    this.update()
  }

  /** Menu open/closed: the overlay hides and nothing stays held. */
  setUiCapture(captured: boolean): void {
    this.uiCapture = captured
    this.pad.uiCapture = captured
    this.update()
  }

  private get visible(): boolean {
    return this.active && !this.uiCapture
  }

  private update(): void {
    this.root.hidden = !this.visible
    // The canvas must not pan or zoom under a thumb while the controls are up.
    this.canvas.style.touchAction = this.visible ? 'none' : ''
    if (!this.visible) this.releaseAll()
  }

  private releaseAll(): void {
    this.pad.releaseAll(performance.now())
    this.stickFinger = null
    this.refresh()
  }

  /** Mirror the pad's state onto the knob and the buttons. */
  private refresh(): void {
    const len = Math.hypot(this.pad.stickX, this.pad.stickY)
    const k = len > 1 ? 1 / len : 1
    const r = this.pad.stickRadius
    this.knob.style.transform = `translate(${this.pad.stickX * k * r}px, ${-this.pad.stickY * k * r}px)`
    for (const [button, b] of this.buttons) {
      const on =
        button === 'jump' || button === 'sprint' || button === 'crouch' || button === 'prone'
          ? this.pad.held(button)
          : false
      b.classList.toggle('ov-touch-on', on)
    }
  }
}

const BUTTONS: [TouchButton, string][] = [
  ['menu', 'Menu'],
  ['use', 'Use'],
  ['primary', 'Fire'],
  ['prone', 'Prone'],
  ['crouch', 'Crouch'],
  ['sprint', 'Sprint'],
  ['jump', 'Jump'],
]

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  return e
}

/** Functional layout only; the look is styles.css's to decide. */
function injectStyles(): void {
  if (document.getElementById('ov-touch-styles')) return
  const style = document.createElement('style')
  style.id = 'ov-touch-styles'
  style.textContent = `
.ov-touch { position: fixed; inset: 0; pointer-events: none; z-index: 5; user-select: none; -webkit-user-select: none; }
.ov-touch[hidden] { display: none; }
.ov-touch-stick { position: absolute; left: 24px; bottom: 24px; width: 120px; height: 120px; border-radius: 50%;
  background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.35); pointer-events: auto; touch-action: none; }
.ov-touch-knob { position: absolute; left: 35px; top: 35px; width: 50px; height: 50px; border-radius: 50%;
  background: rgba(255,255,255,0.45); pointer-events: none; }
.ov-touch-buttons { position: absolute; right: 16px; bottom: 16px; display: grid; grid-template-columns: repeat(3, 64px);
  gap: 10px; direction: rtl; }
.ov-touch-btn { width: 64px; height: 64px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35);
  background: rgba(0,0,0,0.35); color: #fff; font: 600 12px sans-serif; pointer-events: auto; touch-action: none; }
.ov-touch-btn.ov-touch-on { background: rgba(255,255,255,0.4); }
`
  document.head.append(style)
}
