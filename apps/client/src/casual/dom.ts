/** Small DOM helpers for the casual page: elements from data (never HTML strings), timers, toasts and sheets. */

type Child = Node | string | number | null | undefined | false
type Props = {
  class?: string
  text?: string
  title?: string
  attrs?: Record<string, string>
  style?: Record<string, string>
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props) {
    if (props.class) el.className = props.class
    if (props.text !== undefined) el.textContent = props.text
    if (props.title) el.title = props.title
    for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v)
    for (const [k, v] of Object.entries(props.style ?? {})) el.style.setProperty(k, v)
    for (const [k, fn] of Object.entries(props.on ?? {}))
      el.addEventListener(k, fn as EventListener)
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    el.append(typeof c === 'number' ? String(c) : c)
  }
  return el
}

export function button(
  label: Child | Child[],
  onClick: () => void,
  cls = 'btn',
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  const b = h('button', { class: cls, attrs: { type: 'button', ...attrs } })
  for (const c of Array.isArray(label) ? label : [label]) {
    if (c !== null && c !== undefined && c !== false)
      b.append(typeof c === 'number' ? String(c) : c)
  }
  b.addEventListener('click', () => {
    if (!b.disabled) onClick()
  })
  return b
}

/** 1234 → "1,234"; 1_234_567 → "1.23M". */
export function num(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}K`
  return n.toLocaleString('en-US')
}

/** "3h 05m", "4m 09s", "12s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(s / 86400)
  const hr = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d}d ${hr}h`
  if (hr) return `${hr}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

// ── Ticking text: countdowns re-render once a second while their element is on the page. ──
const ticking = new Map<Element, () => string>()
let ticker: number | null = null

export function tick(el: Element, text: () => string): Element {
  el.textContent = text()
  ticking.set(el, text)
  if (ticker === null) {
    ticker = window.setInterval(() => {
      for (const [e, fn] of ticking) {
        if (!e.isConnected) ticking.delete(e)
        else e.textContent = fn()
      }
    }, 1000)
  }
  return el
}

// ── Toasts ──
export function toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  let box = document.getElementById('cg-toasts')
  if (!box) {
    box = h('div', { attrs: { id: 'cg-toasts', role: 'status', 'aria-live': 'polite' } })
    document.body.append(box)
  }
  const t = h('div', { class: `toast toast-${kind}`, text })
  box.append(t)
  window.setTimeout(() => t.classList.add('out'), 2600)
  window.setTimeout(() => t.remove(), 3100)
}

// ── Bottom sheets (modal) ──
export interface Sheet {
  el: HTMLElement
  body: HTMLElement
  close(): void
}

export function sheet(title: string, opts: { wide?: boolean; onClose?: () => void } = {}): Sheet {
  const root = document.getElementById('cg') ?? document.body
  const back = h('div', { class: 'sheet-back' })
  const titleId = `sheet-${Math.random().toString(36).slice(2, 8)}`
  const body = h('div', { class: 'sheet-body' })
  let closeBtn: HTMLButtonElement
  const panel = h(
    'div',
    {
      class: `sheet${opts.wide ? ' sheet-wide' : ''}`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    },
    h(
      'div',
      { class: 'sheet-head' },
      h('h2', { text: title, attrs: { id: titleId } }),
      (closeBtn = h('button', {
        class: 'icon-btn',
        attrs: { type: 'button', 'aria-label': 'Close' },
        text: '✕',
      })),
    ),
    body,
  )
  const before = document.activeElement as HTMLElement | null
  const close = () => {
    back.classList.add('out')
    panel.classList.add('out')
    window.setTimeout(() => {
      back.remove()
      panel.remove()
    }, 180)
    document.removeEventListener('keydown', onKey)
    before?.focus?.()
    opts.onClose?.()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  closeBtn.addEventListener('click', close)
  back.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  root.append(back, panel)
  window.setTimeout(() => closeBtn.focus(), 30)
  return { el: panel, body, close }
}
