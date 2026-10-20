/**
 * The first-steps waypoint: an arrow and a distance at the top of the screen toward the current step's target, so
 * "the forest is west of town" becomes something to follow. Scrap Island's forest is over 100 m from the spawn, and a
 * new scrapper had no marker to find it by.
 */

export interface WaypointTarget {
  label: string
  x: number
  z: number
}

export interface NodeSighting {
  def: string
  name: string
  x: number
  z: number
  remaining: number
}

export interface ZoneBox {
  id: string
  name: string
  min: readonly number[]
  max: readonly number[]
}

/**
 * Where to point: the nearest sighted node of the wanted types that has something left (of `nodes`, preferring the
 * ones in `prefer` when any are sighted), else the named zone's centre. Null when there is nothing to point at.
 */
export function pickTarget(
  from: { x: number; z: number },
  toward: { nodes?: readonly string[]; zone?: string; prefer?: readonly string[] },
  nodes: Iterable<NodeSighting>,
  zones: readonly ZoneBox[],
): WaypointTarget | null {
  const wanted = new Set(toward.nodes ?? [])
  const preferred = new Set(toward.prefer ?? [])
  let best: NodeSighting | null = null
  let bestScore = Infinity
  for (const n of nodes) {
    if (!wanted.has(n.def) || n.remaining <= 0) continue
    // A preferred type wins over any other; within a rank the nearest wins.
    const score =
      Math.hypot(n.x - from.x, n.z - from.z) + (preferred.size && !preferred.has(n.def) ? 1e6 : 0)
    if (score < bestScore) {
      best = n
      bestScore = score
    }
  }
  if (best) return { label: best.name, x: best.x, z: best.z }
  const zone = toward.zone ? zones.find((z) => z.id === toward.zone) : undefined
  if (zone)
    return {
      label: zone.name,
      x: (zone.min[0]! + zone.max[0]!) / 2,
      z: (zone.min[2]! + zone.max[2]!) / 2,
    }
  return null
}

/** The arrow's turn, radians clockwise from straight ahead, for a target seen from `from` facing `yaw` (0 = +z). */
export function bearing(
  from: { x: number; z: number },
  yaw: number,
  to: { x: number; z: number },
): number {
  const a = Math.atan2(to.x - from.x, to.z - from.z) - yaw
  return Math.atan2(Math.sin(a), Math.cos(a))
}

export class Waypoint {
  private readonly el: HTMLElement
  private readonly arrow: HTMLElement
  private readonly text: HTMLElement
  private shown = ''

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'waypoint'
    this.el.hidden = true
    this.el.setAttribute('role', 'status')
    this.arrow = document.createElement('span')
    this.arrow.className = 'waypoint-arrow'
    this.arrow.setAttribute('aria-hidden', 'true')
    this.arrow.textContent = '↑'
    this.text = document.createElement('span')
    this.el.append(this.arrow, this.text)
    root.appendChild(this.el)
  }

  /** Point at `target` from the player's position and facing; null hides it. Within 4 m it hides too (you're there). */
  update(from: { x: number; z: number }, yaw: number, target: WaypointTarget | null): void {
    const d = target ? Math.hypot(target.x - from.x, target.z - from.z) : 0
    if (!target || d < 4) {
      this.el.hidden = true
      return
    }
    this.el.hidden = false
    this.arrow.style.transform = `rotate(${bearing(from, yaw, target).toFixed(3)}rad)`
    const label = `${target.label} · ${Math.round(d)} m`
    if (label !== this.shown) {
      this.text.textContent = label
      this.shown = label
    }
  }
}
