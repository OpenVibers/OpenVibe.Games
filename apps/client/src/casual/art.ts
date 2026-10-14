/**
 * The casual games' art, drawn as SVG from data: hero busts from `look`, enemies by kind and element, and the UI
 * icons. Nothing is downloaded, so the page is playable as soon as its one script has loaded.
 */
import type { Element, EnemyDef, HeroClass, HeroDef, Look, Rarity } from '@openvibe/casual'

const NS = 'http://www.w3.org/2000/svg'

export const ELEMENT_COLOR: Record<Element, string> = {
  flame: '#ff6b3d',
  tide: '#3ba7ff',
  grove: '#4cc96a',
  dawn: '#ffc93c',
  dusk: '#a77bff',
}

export const ELEMENT_NAME: Record<Element, string> = {
  flame: 'Flame',
  tide: 'Tide',
  grove: 'Grove',
  dawn: 'Dawn',
  dusk: 'Dusk',
}

export const CLASS_NAME: Record<HeroClass, string> = {
  guardian: 'Guardian',
  blade: 'Blade',
  arcanist: 'Arcanist',
  ranger: 'Ranger',
  mender: 'Mender',
  herald: 'Herald',
}

export const RARITY_NAME: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
}

/** Builds an SVG element from markup this module writes itself (never from user text). */
function svg(viewBox: string, body: string, cls = ''): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg')
  el.setAttribute('viewBox', viewBox)
  el.setAttribute('aria-hidden', 'true')
  if (cls) el.setAttribute('class', cls)
  el.innerHTML = body
  return el
}

/** A colour darkened (negative) or lightened (positive) by `amount` of 255. */
export function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, v + amount))
  const r = c(n >> 16)
  const g = c((n >> 8) & 0xff)
  const b = c(n & 0xff)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

let uid = 0

// Hair drawn behind the head, by style.
const BACK_HAIR = [
  // 0 long and straight
  'M24 52 C20 22 80 22 76 52 L80 104 L64 98 L62 72 L38 72 L36 98 L20 104 Z',
  // 1 ponytail
  'M27 50 C25 26 75 26 73 50 L72 60 L28 60 Z M66 36 C92 40 94 84 78 108 C80 86 76 64 64 50 Z',
  // 2 bob
  'M26 54 C22 24 78 24 74 54 L75 76 C71 79 67 78 64 73 L36 73 C33 78 29 79 25 76 Z',
  // 3 spiky
  'M28 50 C26 28 74 28 72 50 L70 62 L30 62 Z',
  // 4 swept, collar length
  'M27 52 C24 26 76 26 73 52 L74 74 L66 70 L34 70 L26 74 Z',
  // 5 curly and full
  'M22 60 C12 46 22 22 38 20 C46 12 60 14 66 22 C82 22 90 44 78 62 C86 74 76 92 66 86 L34 86 C22 92 14 74 22 60 Z',
  // 6 cropped
  'M30 48 C30 30 70 30 70 48 L70 54 L30 54 Z',
  // 7 bun
  'M28 50 C26 28 74 28 72 50 L72 60 L28 60 Z',
]

// Hair over the forehead, by style.
const FRONT_HAIR = [
  'M29 52 C28 30 72 28 71 52 C66 42 60 40 54 44 C50 38 42 38 38 44 C34 42 31 46 29 52 Z',
  'M29 50 C30 30 70 28 71 48 C60 46 50 40 44 32 C42 40 36 46 29 50 Z',
  'M28 52 C28 28 72 28 72 52 L66 46 L60 50 L54 45 L48 50 L42 45 L36 50 L32 46 Z',
  'M28 52 L24 30 L36 38 L36 22 L46 34 L52 16 L56 34 L66 22 L64 38 L76 32 L72 52 C66 44 34 44 28 52 Z',
  'M29 50 C27 30 73 28 71 48 C64 40 52 36 42 40 C38 42 33 45 29 50 Z',
  'M28 50 C24 34 36 26 44 30 C48 22 58 24 60 30 C68 26 78 36 72 50 C66 42 58 42 50 44 C42 42 34 42 28 50 Z',
  'M31 46 C32 32 68 32 69 46 C62 41 38 41 31 46 Z',
  'M29 50 C30 32 70 30 71 50 C66 44 58 40 50 42 C42 40 34 44 29 50 Z',
]

function accessory(kind: number, look: Look, id: string): string {
  const trim = look.trim
  switch (kind) {
    case 1: // circlet with a gem
      return `<path d="M30 40 Q50 32 70 40" fill="none" stroke="${trim}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M50 30 L54 36 L50 41 L46 36 Z" fill="${look.eyes}" stroke="${shade(trim, -40)}" stroke-width="0.8"/>`
    case 2: // flower pin
      return `<g transform="translate(68 40)">${[0, 72, 144, 216, 288]
        .map(
          (a) =>
            `<ellipse rx="3.4" ry="5.6" fill="${shade(trim, 30)}" transform="rotate(${a}) translate(0 -4.6)"/>`,
        )
        .join('')}<circle r="2.6" fill="#ffe08a"/></g>`
    case 3: // headband with a sun gem
      return `<path d="M29 44 Q50 36 71 44" fill="none" stroke="${trim}" stroke-width="3.2"/>
        <circle cx="50" cy="38.5" r="3.6" fill="#fff4c2" stroke="${shade(trim, -30)}" stroke-width="1"/>`
    case 4: // hood
      return `<path d="M20 70 C16 30 40 14 50 14 C60 14 84 30 80 70 L74 68 C76 40 64 26 50 26 C36 26 24 40 26 68 Z"
        fill="${shade(look.outfit, 18)}" stroke="${shade(look.outfit, -30)}" stroke-width="1"/>`
    case 5: // helm
      return `<path d="M27 50 C26 26 74 26 73 50 L69 50 C68 34 60 30 50 30 C40 30 32 34 31 50 Z"
        fill="url(#metal-${id})" stroke="${shade('#9aa3ad', -50)}" stroke-width="1"/>
        <rect x="47" y="24" width="6" height="12" rx="2" fill="${trim}"/>`
    case 6: // goggles
      return `<path d="M29 46 Q50 40 71 46" fill="none" stroke="#3a2a1a" stroke-width="2.4"/>
        <circle cx="40" cy="44" r="5.2" fill="#9be7ff" stroke="${trim}" stroke-width="2"/>
        <circle cx="60" cy="44" r="5.2" fill="#9be7ff" stroke="${trim}" stroke-width="2"/>
        <circle cx="38.5" cy="42.5" r="1.4" fill="#fff"/><circle cx="58.5" cy="42.5" r="1.4" fill="#fff"/>`
    default:
      return ''
  }
}

/** A hero's bust; `close` frames the face for small cards. */
export function heroPortrait(def: HeroDef, close = false): SVGSVGElement {
  return svg(portraitBox(close), portraitBody(def, `h${++uid}`), 'portrait')
}

const portraitBox = (close: boolean) => (close ? '13 16 74 90' : '0 0 100 122')

/** The same bust as standalone SVG markup (the share card is drawn from it). */
export function portraitMarkup(def: HeroDef, close = false): string {
  return `<svg xmlns="${NS}" viewBox="${portraitBox(close)}">${portraitBody(def, `m${++uid}`)}</svg>`
}

function portraitBody(def: HeroDef, id: string): string {
  const l = def.look
  const hairDark = shade(l.hair, -45)
  const skinShade = shade(l.skin, -28)
  const style = Math.abs(l.hairStyle) % BACK_HAIR.length
  const body = `
    <defs>
      <linearGradient id="hair-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${shade(l.hair, 30)}"/><stop offset="1" stop-color="${hairDark}"/>
      </linearGradient>
      <linearGradient id="cloth-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${shade(l.outfit, 22)}"/><stop offset="1" stop-color="${shade(l.outfit, -30)}"/>
      </linearGradient>
      <linearGradient id="metal-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e8edf2"/><stop offset="1" stop-color="#8a96a3"/>
      </linearGradient>
    </defs>
    ${l.accessory === 4 ? accessory(4, l, id) : ''}
    ${style === 7 ? `<circle cx="50" cy="22" r="11" fill="url(#hair-${id})"/>` : ''}
    <path d="${BACK_HAIR[style]}" fill="url(#hair-${id})"/>
    <path d="M10 122 C12 104 24 94 50 90 C76 94 88 104 90 122 Z" fill="url(#cloth-${id})"/>
    <path d="M36 92 L50 108 L64 92" fill="none" stroke="${l.trim}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M14 112 C22 102 30 98 36 96" fill="none" stroke="${l.trim}" stroke-width="2" opacity="0.7"/>
    <path d="M86 112 C78 102 70 98 64 96" fill="none" stroke="${l.trim}" stroke-width="2" opacity="0.7"/>
    <path d="M43 76 L43 93 C46 96 54 96 57 93 L57 76 Z" fill="${skinShade}"/>
    <ellipse cx="30.5" cy="58" rx="3.6" ry="5" fill="${skinShade}"/>
    <ellipse cx="69.5" cy="58" rx="3.6" ry="5" fill="${skinShade}"/>
    <path d="M30 48 C30 30 70 30 70 48 L70 58 C70 72 60 82 50 82 C40 82 30 72 30 58 Z" fill="${l.skin}"/>
    <ellipse cx="38" cy="66" rx="4" ry="2.2" fill="#ff7a8a" opacity="0.28"/>
    <ellipse cx="62" cy="66" rx="4" ry="2.2" fill="#ff7a8a" opacity="0.28"/>
    <path d="M35 51 Q41 48 46 51" fill="none" stroke="${hairDark}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M54 51 Q59 48 65 51" fill="none" stroke="${hairDark}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="41" cy="58" rx="5" ry="4.2" fill="#fff"/>
    <ellipse cx="59" cy="58" rx="5" ry="4.2" fill="#fff"/>
    <circle cx="41.4" cy="58.4" r="3.3" fill="${l.eyes}"/>
    <circle cx="59.4" cy="58.4" r="3.3" fill="${l.eyes}"/>
    <circle cx="41.6" cy="58.8" r="1.6" fill="#1b1b2a"/>
    <circle cx="59.6" cy="58.8" r="1.6" fill="#1b1b2a"/>
    <circle cx="40.2" cy="57.2" r="1.1" fill="#fff"/>
    <circle cx="58.2" cy="57.2" r="1.1" fill="#fff"/>
    <path d="M35.6 55.6 Q41 52.4 46.4 55.8" fill="none" stroke="#2a1f2a" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M53.6 55.8 Q59 52.4 64.4 55.6" fill="none" stroke="#2a1f2a" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M50 62 L49 66 L51 66.4" fill="none" stroke="${skinShade}" stroke-width="1" stroke-linecap="round"/>
    <path d="M45.5 71 Q50 74 54.5 71" fill="none" stroke="#a0464f" stroke-width="1.5" stroke-linecap="round"/>
    <path d="${FRONT_HAIR[style]}" fill="url(#hair-${id})"/>
    ${l.accessory !== 4 ? accessory(l.accessory, l, id) : ''}
  `
  return body
}

/** An enemy, cute rather than grim, coloured by its element. */
export function enemyArt(def: EnemyDef): SVGSVGElement {
  const c = ELEMENT_COLOR[def.element]
  const dark = shade(c, -70)
  const light = shade(c, 60)
  const id = `e${++uid}`
  const eyes = (y: number, gap = 9, r = 4) => `
    <ellipse cx="${50 - gap}" cy="${y}" rx="${r}" ry="${r * 1.2}" fill="#fff"/>
    <ellipse cx="${50 + gap}" cy="${y}" rx="${r}" ry="${r * 1.2}" fill="#fff"/>
    <circle cx="${50 - gap + 0.8}" cy="${y + 0.8}" r="${r * 0.6}" fill="#1b1b2a"/>
    <circle cx="${50 + gap + 0.8}" cy="${y + 0.8}" r="${r * 0.6}" fill="#1b1b2a"/>
    <circle cx="${50 - gap - 0.6}" cy="${y - 1}" r="${r * 0.28}" fill="#fff"/>
    <circle cx="${50 + gap - 0.6}" cy="${y - 1}" r="${r * 0.28}" fill="#fff"/>`
  const grad = `<defs><radialGradient id="g-${id}" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${c}"/><stop offset="1" stop-color="${dark}"/>
    </radialGradient></defs>`
  const fill = `url(#g-${id})`
  let body = ''
  switch (def.kind) {
    case 'slime':
      body = `<path d="M14 84 C10 60 30 30 50 26 C70 30 90 60 86 84 C80 92 20 92 14 84 Z" fill="${fill}"/>
        <ellipse cx="36" cy="40" rx="8" ry="5" fill="#fff" opacity="0.45"/>${eyes(60, 11, 5)}
        <path d="M44 74 Q50 78 56 74" fill="none" stroke="${dark}" stroke-width="2" stroke-linecap="round"/>`
      break
    case 'wisp':
      body = `<path d="M50 10 C60 26 80 34 78 60 C76 80 62 90 50 90 C38 90 24 80 22 60 C20 40 36 34 40 22 C44 30 46 34 50 10 Z" fill="${fill}" opacity="0.95"/>
        <path d="M50 30 C56 42 66 48 64 62 C62 74 56 80 50 80 C44 80 38 74 36 62 C36 50 46 44 50 30 Z" fill="${light}" opacity="0.55"/>${eyes(60, 8, 4)}`
      break
    case 'golem':
      body = `<path d="M22 34 L40 20 L62 22 L80 36 L84 74 L68 90 L32 90 L16 74 Z" fill="${fill}" stroke="${dark}" stroke-width="2"/>
        <path d="M30 46 L44 40 M58 40 L72 48 M34 72 L48 78 L64 72" stroke="${dark}" stroke-width="2" fill="none"/>
        <rect x="34" y="50" width="12" height="7" rx="2" fill="${light}"/><rect x="54" y="50" width="12" height="7" rx="2" fill="${light}"/>`
      break
    case 'imp':
      body = `<path d="M30 30 L22 10 L40 24 Z M70 30 L78 10 L60 24 Z" fill="${dark}"/>
        <circle cx="50" cy="54" r="30" fill="${fill}"/>${eyes(50, 10, 5)}
        <path d="M40 66 Q50 74 60 66" fill="none" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M44 68 L46 72 L48 68 M52 68 L54 72 L56 68" fill="#fff"/>`
      break
    case 'drone':
      body = `<rect x="18" y="14" width="64" height="5" rx="2.5" fill="${dark}"/><rect x="47" y="16" width="6" height="14" fill="${dark}"/>
        <ellipse cx="50" cy="56" rx="32" ry="26" fill="${fill}" stroke="${dark}" stroke-width="2"/>
        <circle cx="50" cy="56" r="13" fill="#1b1b2a"/><circle cx="50" cy="56" r="8" fill="${light}"/><circle cx="47" cy="53" r="2.6" fill="#fff"/>
        <path d="M22 76 L14 88 M78 76 L86 88" stroke="${dark}" stroke-width="3" stroke-linecap="round"/>`
      break
    case 'beetle':
      body = `<path d="M20 80 L10 90 M30 84 L24 96 M70 84 L76 96 M80 80 L90 90" stroke="${dark}" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="50" cy="60" rx="34" ry="28" fill="${fill}" stroke="${dark}" stroke-width="2"/>
        <path d="M50 32 L50 88" stroke="${dark}" stroke-width="2"/>
        <circle cx="50" cy="30" r="14" fill="${dark}"/><path d="M42 20 L36 8 M58 20 L64 8" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="45" cy="29" r="2.6" fill="${light}"/><circle cx="55" cy="29" r="2.6" fill="${light}"/>`
      break
    case 'specter':
      body = `<path d="M22 92 L22 46 C22 24 36 12 50 12 C64 12 78 24 78 46 L78 92 L68 84 L59 92 L50 84 L41 92 L32 84 Z" fill="${fill}" opacity="0.92"/>
        <path d="M30 50 C30 30 70 30 70 50 C70 62 30 62 30 50 Z" fill="#14101f"/>
        <ellipse cx="41" cy="48" rx="4" ry="5" fill="${light}"/><ellipse cx="59" cy="48" rx="4" ry="5" fill="${light}"/>`
      break
    case 'drake':
      body = `<path d="M28 34 L18 12 L38 28 Z M72 34 L82 12 L62 28 Z" fill="${dark}"/>
        <path d="M18 52 C18 30 82 30 82 52 L80 70 C76 86 24 86 20 70 Z" fill="${fill}" stroke="${dark}" stroke-width="2"/>
        <path d="M34 74 C40 84 60 84 66 74 L60 76 L56 72 L50 77 L44 72 L40 76 Z" fill="#fff"/>
        ${eyes(52, 13, 5)}
        <circle cx="44" cy="65" r="1.8" fill="${dark}"/><circle cx="56" cy="65" r="1.8" fill="${dark}"/>`
      break
  }
  if (def.boss) {
    body += `<path d="M34 12 L38 2 L44 9 L50 0 L56 9 L62 2 L66 12 Z" fill="#ffd25a" stroke="#a56b00" stroke-width="1"/>`
  }
  return svg('0 0 100 100', grad + body, 'enemy')
}

const ICONS: Record<string, string> = {
  gold: `<circle cx="12" cy="12" r="9" fill="#ffcf3f" stroke="#b07a00" stroke-width="1.6"/><circle cx="12" cy="12" r="5.6" fill="none" stroke="#d99c00" stroke-width="1.4"/><path d="M9.4 9.6 L12 8 L14.6 9.6" stroke="#fff6c8" stroke-width="1.2" fill="none" stroke-linecap="round"/>`,
  gems: `<path d="M6 9 L9 4.5 L15 4.5 L18 9 L12 20 Z" fill="#ff5fc8" stroke="#a31f7d" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 9 L18 9 M9 4.5 L12 9 L15 4.5 M12 9 L12 20" stroke="#ffd1f0" stroke-width="0.9" fill="none"/>`,
  sigils: `<circle cx="12" cy="12" r="9" fill="#7c4dff" stroke="#3b1d99" stroke-width="1.4"/><path d="M12 5 L13.8 10.2 L19 12 L13.8 13.8 L12 19 L10.2 13.8 L5 12 L10.2 10.2 Z" fill="#e9dcff"/>`,
  energy: `<path d="M13.5 2.5 L5 13.5 L11 13.5 L9.5 21.5 L19 9.5 L12.8 9.5 Z" fill="#5ee0ff" stroke="#0a7fa3" stroke-width="1.3" stroke-linejoin="round"/>`,
  battle: `<path d="M4 4 L13 13 M4 4 L4 8 M4 4 L8 4 M20 4 L11 13 M20 4 L20 8 M20 4 L16 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M7 15 L5 17 L7 19 L9 17 Z M17 15 L19 17 L17 19 L15 17 Z" fill="currentColor"/><path d="M9 13 L6.5 15.5 M15 13 L17.5 15.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  heroes: `<path d="M12 3 C7 3 5 7 5 11 L5 15 L8 15 L8 11 L16 11 L16 15 L19 15 L19 11 C19 7 17 3 12 3 Z" fill="currentColor"/><path d="M8 15 L8 18 C8 20 10 21 12 21 C14 21 16 20 16 18 L16 15" fill="none" stroke="currentColor" stroke-width="2"/><rect x="11" y="11" width="2" height="7" fill="currentColor"/>`,
  summon: `<path d="M12 2 L15 9 L22 12 L15 15 L12 22 L9 15 L2 12 L9 9 Z" fill="currentColor"/><circle cx="12" cy="12" r="2.4" fill="var(--cg-bg, #120c2a)"/>`,
  quests: `<path d="M6 3 L16 3 C18 3 19 4 19 6 L19 18 C19 20 18 21 16 21 L8 21 C6 21 5 20 5 18 L5 6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 8 L15 8 M9 12 L15 12 M9 16 L13 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  shop: `<path d="M5 8 L19 8 L18 21 L6 21 Z" fill="currentColor"/><path d="M9 10 L9 6 C9 4 10.5 3 12 3 C13.5 3 15 4 15 6 L15 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  trophy: `<path d="M7 3 L17 3 L17 9 C17 12 15 14 12 14 C9 14 7 12 7 9 Z" fill="currentColor"/><path d="M7 5 L4 5 C4 8 5 10 7 10 M17 5 L20 5 C20 8 19 10 17 10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 14 L12 18 M8 21 L16 21 L15 18 L9 18 Z" stroke="currentColor" stroke-width="1.8" fill="currentColor"/>`,
  chest: `<rect x="3" y="9" width="18" height="11" rx="1.5" fill="#b8742a" stroke="#6b3d0f" stroke-width="1.4"/><path d="M3 9 C3 5 6 4 12 4 C18 4 21 5 21 9 Z" fill="#d18a35" stroke="#6b3d0f" stroke-width="1.4"/><rect x="10" y="9" width="4" height="5" rx="1" fill="#ffd25a" stroke="#6b3d0f" stroke-width="1"/><path d="M3 13 L21 13" stroke="#6b3d0f" stroke-width="1"/>`,
  star: `<path d="M12 2.5 L14.9 8.6 L21.5 9.4 L16.6 13.9 L17.9 20.5 L12 17.2 L6.1 20.5 L7.4 13.9 L2.5 9.4 L9.1 8.6 Z" fill="currentColor"/>`,
  close: `<path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`,
  menu: `<path d="M4 7 L20 7 M4 12 L20 12 M4 17 L20 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  guardian: `<path d="M12 2 L20 5 L20 11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 L4 5 Z" fill="currentColor"/>`,
  blade: `<path d="M18.5 2.5 L21.5 2.5 L21.5 5.5 L10 17 L7 14 Z" fill="currentColor"/><path d="M5 12 L12 19 M6 18 L3 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  arcanist: `<path d="M12 2 L13.6 6.4 L18 8 L13.6 9.6 L12 14 L10.4 9.6 L6 8 L10.4 6.4 Z" fill="currentColor"/><path d="M12 14 L12 22" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  ranger: `<path d="M6 3 C14 6 14 18 6 21" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M6 3 L6 21 M4 12 L21 12 M18 9 L21 12 L18 15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  mender: `<path d="M9.5 3 L14.5 3 L14.5 9.5 L21 9.5 L21 14.5 L14.5 14.5 L14.5 21 L9.5 21 L9.5 14.5 L3 14.5 L3 9.5 L9.5 9.5 Z" fill="currentColor"/>`,
  herald: `<path d="M5 3 L5 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6 4 L19 4 L16 8.5 L19 13 L6 13 Z" fill="currentColor"/>`,
  board: `<rect x="3" y="12" width="5" height="9" rx="1" fill="currentColor"/><rect x="9.5" y="5" width="5" height="16" rx="1" fill="currentColor"/><rect x="16" y="9" width="5" height="12" rx="1" fill="currentColor"/>`,
  lock: `<rect x="5" y="10" width="14" height="11" rx="2" fill="currentColor"/><path d="M8 10 L8 7 C8 4.5 10 3 12 3 C14 3 16 4.5 16 7 L16 10" fill="none" stroke="currentColor" stroke-width="2"/>`,
  sweep: `<path d="M4 20 L14 10 M12 6 L18 12 M14 4 L20 10 L16 14 L10 8 Z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`,
}

export function icon(name: string, cls = 'ico'): SVGSVGElement {
  return svg('0 0 24 24', ICONS[name] ?? '', cls)
}

const ELEMENT_GLYPH: Record<Element, string> = {
  flame:
    '<path d="M12 2.5 C14.5 7 19 9 18 14.5 C17.4 18.4 14.8 21 12 21 C8.6 21 6 18.6 6 15.2 C6 12 8.4 10.6 9.6 7.6 C10.8 9.6 11.6 10 12 2.5 Z" fill="currentColor"/>',
  tide: '<path d="M12 2.5 C15.4 8 18.5 11 18.5 15 A6.5 6.5 0 0 1 5.5 15 C5.5 11 8.6 8 12 2.5 Z" fill="currentColor"/>',
  grove:
    '<path d="M4.5 19.5 C4.5 10 10 4.5 19.5 4.5 C19.5 14 14 19.5 4.5 19.5 Z" fill="currentColor"/><path d="M5.5 18.5 L14 10" stroke="rgba(0,0,0,0.35)" stroke-width="1.6" stroke-linecap="round"/>',
  dawn: '<circle cx="12" cy="12" r="4.6" fill="currentColor"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  dusk: '<path d="M14.5 2.8 A9.4 9.4 0 1 0 21.2 15 A7.4 7.4 0 1 1 14.5 2.8 Z" fill="currentColor"/>',
}

/** The small element badge: a coloured disc with the element's glyph (flame, drop, leaf, sun, moon). */
export function elementBadge(e: Element): HTMLElement {
  const b = document.createElement('span')
  b.className = `el el-${e}`
  b.title = ELEMENT_NAME[e]
  b.setAttribute('role', 'img')
  b.setAttribute('aria-label', ELEMENT_NAME[e])
  b.append(svg('0 0 24 24', ELEMENT_GLYPH[e], 'ico'))
  return b
}
