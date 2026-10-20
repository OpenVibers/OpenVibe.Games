/**
 * First steps: a short checklist in the corner for a new scrapper, so the first minutes have a direction. A guest
 * used to arrive with an empty hotbar and nothing to say what Scraplandia is about (owner, 2026-10-19: "so boring").
 *
 * The steps follow Scrap Island (apps/server/src/maps/scrapIsland.ts) and the tool chain: branches and loose stones
 * need no tool → planks → a Stone Axe → an oak in the west forest → a Stone Pickaxe → the quarry → the scrapyard →
 * a haul at the recovery bird. Each step reads what the client already knows (inventory, skill levels, the
 * extraction announce); progress only moves forward and is kept in this browser. The panel can be closed for good.
 */

export interface StepView {
  /** Items held, by def id. */
  count: (item: string) => number
  /** Skill level (1 when untrained). */
  level: (skill: string) => number
  /** Set once an extraction secured something. */
  hauled: boolean
}

export interface FirstStep {
  id: string
  title: string
  hint: string
  done: (v: StepView) => boolean
  /**
   * Where the waypoint points (ui/waypoint.ts): the nearest node of these types that has something left, else the
   * map zone with this id (a landmark). `items` narrows the nodes to the ones yielding what the player still lacks.
   */
  toward?: { nodes?: string[]; zone?: string }
}

export const FIRST_STEPS: FirstStep[] = [
  {
    id: 'gather',
    title: 'Gather branches and stones',
    hint: 'Piles just inside every city gate. Look at one and press E.',
    done: (v) =>
      (v.count('wood_log') > 0 || v.count('wood_plank') > 0 || v.count('stone_axe') > 0) &&
      (v.count('stone') > 0 || v.count('stone_axe') > 0),
    toward: { nodes: ['branch_pile', 'loose_stones'] },
  },
  {
    id: 'axe',
    title: 'Craft a Stone Axe',
    hint: 'Tab → Crafting: turn a log into Wood Planks, then make the axe.',
    done: (v) => v.count('stone_axe') > 0 || v.level('woodcutting') >= 2,
  },
  {
    id: 'chop',
    title: 'Chop an oak',
    hint: 'The forest is west of town. Hold the axe and swing (left click).',
    done: (v) => v.level('woodcutting') >= 2,
    toward: { nodes: ['oak_tree'], zone: 'forest' },
  },
  {
    id: 'mine',
    title: 'Mine at the quarry',
    hint: 'South-west of town. A Stone Pickaxe breaks the stone deposits.',
    done: (v) => v.level('mining') >= 2,
    toward: { nodes: ['stone_deposit'], zone: 'quarry' },
  },
  {
    id: 'scrap',
    title: 'Salvage the scrapyard',
    hint: 'East of town, past the gate. Rustjaw thugs hang around out there.',
    done: (v) => v.count('scrap_metal') >= 4 || v.level('scavenging') >= 2,
    toward: { nodes: ['scrap_pile'], zone: 'scrapyard' },
  },
  {
    id: 'haul',
    title: 'Extract a haul',
    hint: 'When the recovery bird circles, stand in its circle with your valuables. Hauls score on the weekly board.',
    done: (v) => v.hauled,
  },
]

const STORAGE_KEY = 'scraplandia:first-steps'

interface Saved {
  done: string[]
  closed?: boolean
  hauled?: boolean
}

function load(storage: Storage | null): Saved {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    const saved = raw ? (JSON.parse(raw) as Saved) : null
    if (saved && Array.isArray(saved.done)) return saved
  } catch {
    // unreadable or blocked storage: start fresh
  }
  return { done: [] }
}

/** Steps done so far, never fewer than before (progress only moves forward). */
export function progress(view: StepView, saved: Saved): string[] {
  const done = new Set(saved.done)
  for (const step of FIRST_STEPS) if (step.done(view)) done.add(step.id)
  return FIRST_STEPS.map((s) => s.id).filter((id) => done.has(id))
}

export class FirstSteps {
  private readonly el: HTMLElement
  private saved: Saved

  constructor(
    root: HTMLElement,
    private readonly read: () => Omit<StepView, 'hauled'>,
    private readonly storage: Storage | null = safeStorage(),
  ) {
    this.saved = load(storage)
    this.el = document.createElement('section')
    this.el.className = 'first-steps'
    this.el.setAttribute('aria-label', 'First steps')
    root.appendChild(this.el)
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-first-steps-close]')) {
        this.saved.closed = true
        this.save()
        this.render()
      }
    })
    this.render()
  }

  /** Re-check the steps (inventory or skills changed). */
  update(): void {
    const view = { ...this.read(), hauled: !!this.saved.hauled }
    const done = progress(view, this.saved)
    if (done.length !== this.saved.done.length) {
      this.saved.done = done
      this.save()
    }
    this.render()
  }

  /** The step being worked on, or null when all are done or the panel was closed. */
  current(): FirstStep | null {
    if (this.saved.closed) return null
    const done = new Set(this.saved.done)
    return FIRST_STEPS.find((s) => !done.has(s.id)) ?? null
  }

  /** Where the recovery bird said it would land ("… near (56, -20) …"), for the haul step's waypoint. */
  birdAt: [number, number] | null = null

  /** A server announce: an extraction that secured something completes the last step. */
  onAnnounce(text: string): void {
    const near = /near \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/.exec(text)
    if (near) this.birdAt = [Number(near[1]), Number(near[2])]
    if (/Extracted|recovery bird moves on/i.test(text)) this.birdAt = null
    if (/Extracted! [1-9]/.test(text)) {
      this.saved.hauled = true
      this.update()
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.saved))
    } catch {
      // storage full or blocked: progress lives for this session
    }
  }

  private render(): void {
    const done = new Set(this.saved.done)
    const allDone = FIRST_STEPS.every((s) => done.has(s.id))
    if (this.saved.closed || allDone) {
      this.el.hidden = true
      return
    }
    this.el.hidden = false
    const current = FIRST_STEPS.find((s) => !done.has(s.id))
    const head = document.createElement('div')
    head.className = 'first-steps-head'
    const title = document.createElement('span')
    title.textContent = `First steps · ${done.size}/${FIRST_STEPS.length}`
    const close = document.createElement('button')
    close.type = 'button'
    close.dataset.firstStepsClose = '1'
    close.setAttribute('aria-label', 'Hide first steps')
    close.textContent = '×'
    head.append(title, close)
    const list = document.createElement('ol')
    for (const step of FIRST_STEPS) {
      const li = document.createElement('li')
      const isDone = done.has(step.id)
      li.className = isDone ? 'done' : step === current ? 'current' : ''
      const mark = document.createElement('span')
      mark.className = 'mark'
      mark.textContent = isDone ? '✓' : step === current ? '›' : '·'
      const text = document.createElement('span')
      text.textContent = step.title
      li.append(mark, text)
      if (step === current) {
        const hint = document.createElement('div')
        hint.className = 'hint'
        hint.textContent = step.hint
        li.appendChild(hint)
      }
      list.appendChild(li)
    }
    this.el.replaceChildren(head, list)
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
