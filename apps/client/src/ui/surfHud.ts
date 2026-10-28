import type { ServerMessage } from '@openvibe/protocol'
import './surfHud.css'

type SurfState = Extract<ServerMessage, { t: 'surf_state' }>
type SurfFinish = Extract<ServerMessage, { t: 'surf_finish' }>

/** m:ss.mmm, the surf timer's format. */
export function formatSurfTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Engine m/s → Source units/s (1 unit = 1 inch = 0.0254 m). */
export function unitsPerSecond(mps: number): number {
  return mps / 0.0254
}

/**
 * Ride's HUD: the authoritative timer, speed, stage and split deltas, and the
 * finish card. Markup is semantic and `surf-`-classed so the session can
 * restyle it without touching behaviour; colours are the shared theme tokens.
 */
export class SurfHud {
  private readonly root: HTMLElement
  private readonly timer: HTMLElement
  private readonly speed: HTMLElement
  private readonly stage: HTMLElement
  private readonly splits: HTMLElement
  private readonly finishCard: HTMLElement
  private readonly finishTime: HTMLElement
  private readonly finishPb: HTMLElement
  private readonly finishWr: HTMLElement
  private readonly watchButton: HTMLButtonElement
  private state: SurfState | null = null
  private baseElapsed = 0
  private baseAt = performance.now()
  private deltaUntil = new Map<number, number>()
  private lastSplitCount = 0

  onRestart: (() => void) | null = null
  onWatchWr: (() => void) | null = null

  constructor(parent: HTMLElement) {
    this.root = document.createElement('aside')
    this.root.className = 'surf-hud'
    this.root.setAttribute('aria-label', 'Surf run')

    const head = document.createElement('div')
    head.className = 'surf-head'
    const title = document.createElement('strong')
    title.className = 'surf-title'
    title.textContent = 'RIDE'
    this.stage = document.createElement('span')
    this.stage.className = 'surf-stage'
    this.stage.textContent = '1/3'
    head.append(title, this.stage)

    this.timer = document.createElement('p')
    this.timer.className = 'surf-timer'
    this.timer.setAttribute('aria-live', 'off')
    this.timer.textContent = '0:00.000'

    const meta = document.createElement('div')
    meta.className = 'surf-meta'
    this.speed = document.createElement('span')
    this.speed.className = 'surf-speed'
    this.speed.textContent = '0 u/s'
    const hint = document.createElement('span')
    hint.className = 'surf-hint'
    hint.textContent = 'R restart · G ghost'
    meta.append(this.speed, hint)

    this.splits = document.createElement('ol')
    this.splits.className = 'surf-splits'
    this.splits.setAttribute('aria-label', 'Splits')

    this.finishCard = document.createElement('section')
    this.finishCard.className = 'surf-finish'
    this.finishCard.hidden = true
    const finishTitle = document.createElement('h2')
    finishTitle.className = 'surf-finish-title'
    finishTitle.textContent = 'RUN COMPLETE'
    this.finishTime = document.createElement('p')
    this.finishTime.className = 'surf-finish-time'
    this.finishTime.setAttribute('aria-live', 'polite')
    this.finishPb = document.createElement('p')
    this.finishPb.className = 'surf-finish-pb'
    this.finishWr = document.createElement('p')
    this.finishWr.className = 'surf-finish-wr'
    const actions = document.createElement('div')
    actions.className = 'surf-finish-actions'
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'surf-again'
    again.textContent = 'Again (R)'
    again.addEventListener('click', () => this.onRestart?.())
    this.watchButton = document.createElement('button')
    this.watchButton.type = 'button'
    this.watchButton.className = 'surf-watch'
    this.watchButton.textContent = 'Watch the WR'
    this.watchButton.addEventListener('click', () => this.onWatchWr?.())
    actions.append(again, this.watchButton)
    this.finishCard.append(finishTitle, this.finishTime, this.finishPb, this.finishWr, actions)

    this.root.append(head, this.timer, meta, this.splits, this.finishCard)
    parent.append(this.root)
  }

  updateState(state: SurfState): void {
    this.state = state
    this.baseElapsed = state.elapsedMs
    this.baseAt = performance.now()
    this.stage.textContent = `${Math.min(state.stage + 1, state.stages)}/${state.stages}`
    this.root.classList.toggle('is-running', state.running)
    // A fresh run (idle, zero time) puts the card away even when the reset
    // came from re-entering the start zone rather than the button.
    if (!state.running && state.elapsedMs === 0) this.hideFinish()
    this.renderSplits(state)
  }

  /** Speed in engine m/s, read from prediction; shown in Source units/s. */
  setSpeed(mps: number): void {
    this.speed.textContent = `${Math.round(unitsPerSecond(mps))} u/s`
  }

  showFinish(finish: SurfFinish): void {
    this.finishCard.hidden = false
    this.finishTime.textContent = formatSurfTime(finish.timeMs)
    this.finishPb.textContent = finish.pb
      ? 'NEW PERSONAL BEST'
      : finish.pbMs === null
        ? 'First run — set a PB'
        : `PB ${formatSurfTime(finish.pbMs)}`
    const rank = finish.rank ? ` · rank #${finish.rank}` : ''
    this.finishWr.textContent = finish.wr
      ? `WORLD RECORD${rank}`
      : finish.wrMs === null
        ? 'No WR yet'
        : `WR ${formatSurfTime(finish.wrMs)}${rank}`
    this.finishCard.classList.toggle('is-pb', finish.pb)
    this.finishCard.classList.toggle('is-wr', finish.wr)
    this.watchButton.disabled = finish.wrMs === null
  }

  hideFinish(): void {
    this.finishCard.hidden = true
  }

  /** The currently displayed elapsed time (server base + local interpolation). */
  elapsedNow(now = performance.now()): number {
    const state = this.state
    if (!state) return 0
    return state.running ? this.baseElapsed + Math.max(0, now - this.baseAt) : state.elapsedMs
  }

  /** Per-frame: interpolate the server clock and expire split deltas. */
  tick(now = performance.now()): void {
    const state = this.state
    if (!state) return
    this.timer.textContent = formatSurfTime(this.elapsedNow(now))
    let changed = false
    for (const [stage, until] of this.deltaUntil)
      if (now >= until) {
        this.deltaUntil.delete(stage)
        changed = true
      }
    if (changed) this.renderSplits(state)
  }

  private renderSplits(state: SurfState): void {
    if (state.splits.length > this.lastSplitCount) {
      const now = performance.now()
      for (let i = this.lastSplitCount; i < state.splits.length; i++)
        this.deltaUntil.set(i, now + 3000)
      this.lastSplitCount = state.splits.length
    } else if (state.splits.length < this.lastSplitCount) {
      this.lastSplitCount = state.splits.length
      this.deltaUntil.clear()
    }
    if (state.splits.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'surf-split is-empty'
      empty.textContent = 'Leave the start to begin.'
      this.splits.replaceChildren(empty)
      return
    }
    const rows = state.splits.map((timeMs, i) => {
      const item = document.createElement('li')
      item.className = 'surf-split'
      const label = document.createElement('span')
      label.className = 'surf-split-label'
      label.textContent = `S${i + 1}`
      const value = document.createElement('span')
      value.className = 'surf-split-time'
      value.textContent = formatSurfTime(timeMs)
      item.append(label, value)
      const pb = state.pbSplits?.[i]
      if (pb !== undefined && this.deltaUntil.has(i)) {
        const delta = timeMs - pb
        const badge = document.createElement('span')
        badge.className = `surf-delta ${delta <= 0 ? 'is-faster' : 'is-slower'}`
        badge.textContent = `${delta <= 0 ? '−' : '+'}${formatSurfTime(Math.abs(delta))}`
        item.append(badge)
      }
      return item
    })
    this.splits.replaceChildren(...rows)
  }
}
