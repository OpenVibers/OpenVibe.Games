// The editor's object kinds as glyphs (2026-11-16; the owner: icons drawn as emoji look cheap). One hand for all of
// them, OpenVibe's: a 24-unit grid, round 2-unit strokes, nothing filled. Built as SVG nodes, never markup strings.
const PATHS: Record<string, string[]> = {
  terrain: ['M3 19 9 9l4 6 3-4 5 8Z'],
  static: ['M12 3 4 7.5v9L12 21l8-4.5v-9Z', 'M4 7.5 12 12l8-4.5', 'M12 12v9'],
  node: ['M12 3 6 11h3l-4 6h14l-4-6h3Z', 'M12 17v4'],
  prop: ['M3 4h18v4H3z', 'M4 8h16v12H4z', 'M10 12h4'],
  npc: ['M9.5 6.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0', 'M8 21v-6l-2-1 2-4.5h8l2 4.5-2 1v6'],
  light: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z'],
  zone: ['M4 6h16v12H4z', 'M8 10h8v4H8z'],
  spawn: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  // The tool rail's tools.
  select: ['M6 3l12 8.5-5.5 1.5 3 6.5-2.5 1.2-3-6.5L6 18Z'],
  mesh: ['M12 3 4 7.5v9L12 21l8-4.5v-9Z', 'M4 7.5 12 12l8-4.5', 'M12 12v9'],
  entity: ['M12 3 6 11h3l-4 6h14l-4-6h3Z', 'M12 17v4'],
  paint: ['M17.5 3.5l3 3-8.5 8.5-3-3Z', 'M9 12c-2.2 0-4 1.6-4 4 0 1.4-.8 2.5-2 3 3.3 1 7.5-.2 7.5-4.2'],
  face: ['M4 4h16v16H4z', 'M4 12h16', 'M12 4v16'],
  // The Issues panel's severities and its all-clear, and the co-editors (2026-11-16: they were emoji).
  error: ['M8 3h8l5 5v8l-5 5H8l-5-5V8Z', 'M9.5 9.5l5 5', 'M14.5 9.5l-5 5'],
  warning: ['M12 4 2.5 20h19Z', 'M12 10v4.5', 'M12 17.5h.01'],
  info: ['M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0', 'M12 11v6', 'M12 7.5h.01'],
  check: ['M5 12.5l5 5 9-10'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0'],
}

const NS = 'http://www.w3.org/2000/svg'

/** The glyph for an object kind's icon name, as an SVG element (a plain dot for a name it does not know). */
export function kindGlyph(name: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
  for (const d of PATHS[name] ?? ['M12 12h.01']) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

export const KIND_GLYPHS = Object.keys(PATHS)
