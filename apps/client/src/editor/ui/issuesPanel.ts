/**
 * The Issues panel: everything wrong with the map, in one place.
 *
 * These checks already existed — `validateMapFile` and `validateSurface` run
 * on every save — but their output only appeared as a rejection message after
 * the fact. Surfacing them live means an author sees a missing texture or a
 * duplicate id while they can still fix it, and clicking an issue selects the
 * object it belongs to.
 */
import { kindGlyph } from './kindGlyphs.js'

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface EditorIssue {
  severity: IssueSeverity
  message: string
  /** Object to select when the row is clicked, when there is one. */
  objectId?: string
}

export interface IssuesPanelDeps {
  /** Recompute the current issue list. */
  collect: () => EditorIssue[]
  /** Select and frame an object the user clicked through to. */
  focus: (objectId: string) => void
}

// Each severity's glyph (kindGlyphs: error, warning, info), in the severity's colour.
const ICON: Record<IssueSeverity, string> = { error: 'error', warning: 'warning', info: 'info' }
const COLOR: Record<IssueSeverity, string> = {
  error: '#ff8f6e',
  warning: '#e8b54a',
  info: '#7fd0ff',
}

export function createIssuesPanel(deps: IssuesPanelDeps): {
  refresh: () => void
  count: () => number
} {
  const panel = document.getElementById('issues') as HTMLElement | null
  const list = document.getElementById('issues-list') as HTMLElement | null
  const badge = document.getElementById('issues-badge') as HTMLElement | null
  let issues: EditorIssue[] = []

  const refresh = (): void => {
    issues = deps.collect()
    if (badge) {
      const errors = issues.filter((i) => i.severity === 'error').length
      badge.replaceChildren(kindGlyph(issues.length === 0 ? 'check' : ICON.error), document.createTextNode(issues.length === 0 ? ' no issues' : ` ${issues.length}`))
      badge.style.color = errors > 0 ? COLOR.error : issues.length > 0 ? COLOR.warning : '#78828e'
    }
    if (!list) return
    list.replaceChildren()
    if (issues.length === 0) {
      const d = document.createElement('div')
      d.style.color = '#78828e'
      d.textContent = 'no issues — the map validates cleanly'
      list.appendChild(d)
      return
    }
    for (const issue of issues) {
      const row = document.createElement('div')
      row.style.cssText = `display:flex;gap:6px;align-items:flex-start;color:${COLOR[issue.severity]}`
      const icon = document.createElement('span')
      icon.style.cssText = 'display:inline-flex;flex:none;padding-top:1px'
      icon.setAttribute('aria-label', issue.severity)
      icon.appendChild(kindGlyph(ICON[issue.severity]))
      const text = document.createElement('span')
      text.style.flex = '1'
      text.textContent = issue.message
      if (issue.objectId) {
        row.style.cursor = 'pointer'
        row.title = `select ${issue.objectId}`
        const oid = issue.objectId
        row.addEventListener('click', () => deps.focus(oid))
      }
      row.append(icon, text)
      list.appendChild(row)
    }
  }

  document.getElementById('issues-btn')?.addEventListener('click', () => {
    if (!panel) return
    const open = panel.style.display === 'flex'
    panel.style.display = open ? 'none' : 'flex'
    if (!open) refresh()
  })
  document.getElementById('issues-close')?.addEventListener('click', () => {
    if (panel) panel.style.display = 'none'
  })

  refresh()
  return { refresh, count: () => issues.length }
}
