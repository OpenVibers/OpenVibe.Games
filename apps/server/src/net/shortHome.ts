/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, all shown, each with its own heading; on a phone the chips are a
 *                row of links that jump to them (the owner, 2026-10-31: never hide content to shorten).
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in apps/client/index.html.
 */
import { escapeHtml } from './notFound.js'

const esc = (v: unknown): string => escapeHtml(String(v ?? ''))

export interface PickPane {
  id: string
  label: string
  html: string
}

/**
 * A pick block. The panes are the page's own blocks, every one shown; on a phone the chips jump to them, and on a wide
 * screen there are no chips.
 */
export function pickBlock(o: {
  key: string
  label: string
  head?: string
  panes: PickPane[]
}): string {
  const panes = o.panes ?? []
  if (!panes.length) return ''
  const chips = panes
    .map((p) => `<a class="pick-chip" href="#pp-${esc(o.key)}-${esc(p.id)}">${esc(p.label)}</a>`)
    .join('')
  const body = panes
    .map((p) => `<div class="pick-pane" id="pp-${esc(o.key)}-${esc(p.id)}">${p.html}</div>`)
    .join('')
  const heading = `<h2>${esc(o.head || o.label)}</h2>`
  return `<div class="pick" id="pick-${esc(o.key)}"><div class="pick-bar"><div class="pick-head">${heading}</div><nav class="pick-row" aria-label="${esc(o.label)}">${chips}</nav></div><div class="pick-body">${body}</div></div>`
}


/**
 * What a fold holds, counted, for its title row (the owner, 2026-10-31: a fold that shortens a page shows its count):
 * "6 questions", "12 items", "latest 5" for the shipped list, or nothing when there is nothing to count. Replaces the
 * hint the fold used to show instead.
 */
export function foldMeta(body: string, cls = ''): string {
  const s = String(body ?? '')
  const n = (re: RegExp): number => (s.match(re) ?? []).length
  const shipped = /data-ov-shipped="list"[^>]*?data-limit="(\d+)"|data-limit="(\d+)"[^>]*?data-ov-shipped="list"/.exec(s)
  const q = n(/<details[\s>]/g)
  const li = n(/<li[\s>]/g)
  const a = n(/<a\s/g)
  const text = shipped ? `latest ${shipped[1] || shipped[2]}` : q > 1 ? `${q} questions` : li > 1 ? `${li} items` : a > 1 ? `${a} links` : ''
  return text ? `<span${cls ? ` class="${cls}"` : ''}>${text}</span>` : ''
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 */
export function foldBlock(o: { id: string; head: string; html: string }): string {
  return `<details class="gm-fold gm-fold-block" id="${esc(o.id)}" open><summary>${o.head}${foldMeta(o.html)}</summary>${o.html}</details>${foldScript(o.id)}`
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
export function foldScript(id: string): string {
  return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`
}
