/**
 * A casual game's page (plan T22): the one built `casual.html` with the game's own title, description, share card
 * (Open Graph and X) and JSON-LD filled in where the build left `<!--casual:head-->`. A shared or advertised link
 * unfurls as the game, and the page knows which game to start from `<body data-game>`.
 */
import { readFileSync, statSync } from 'node:fs'
import { CASUAL_GAMES } from '@openvibe/casual'
import { casualJsonLdTag } from '../net/discovery.js'

const SITE = 'https://openvibe.games'
const MARK = '<!--casual:head-->'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The id of the casual game a `/play/<id>` path names, or null. */
export function casualGameOf(path: string): string | null {
  const id = /^\/play\/([a-z0-9-]{1,40})\/?$/.exec(path)?.[1]
  return id && CASUAL_GAMES[id] ? id : null
}

export function casualHead(id: string): string {
  const pack = CASUAL_GAMES[id]
  if (!pack) return ''
  const url = `${SITE}/play/${pack.id}`
  const title = `${pack.name} · OpenVibe.Games`
  const image = `${SITE}/casual/${pack.id}/card.png`
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(pack.tagline)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="OpenVibe.Games" />`,
    `<meta property="og:title" content="${esc(pack.name)}" />`,
    `<meta property="og:description" content="${esc(pack.tagline)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(pack.name)}" />`,
    `<meta name="twitter:description" content="${esc(pack.tagline)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    casualJsonLdTag(pack.id),
  ].join('\n    ')
}

/** What the page says without JavaScript (and what a crawler reads): the game, how it plays, and where to go. */
export function casualAbout(id: string): string {
  const pack = CASUAL_GAMES[id]
  if (!pack) return ''
  const name = esc(pack.name)
  return [
    `<p>${esc(pack.tagline)}</p>`,
    `<p>${name} plays in your phone's browser with nothing to install, as a guest or with your OpenVibe account,`,
    `and your team keeps earning while you are away. Turn on JavaScript to play.</p>`,
    `<p><a href="/">More free browser games on OpenVibe.Games</a></p>`,
  ].join(' ')
}

let memo: { path: string; mtimeMs: number; raw: string } | null = null

/** The built page for one game (the file is read once per build). */
export function casualPageHtml(filePath: string, id: string): string {
  const mtimeMs = statSync(filePath).mtimeMs
  if (!memo || memo.path !== filePath || memo.mtimeMs !== mtimeMs) {
    memo = { path: filePath, mtimeMs, raw: readFileSync(filePath, 'utf8') }
  }
  return memo.raw
    .replace(MARK, casualHead(id))
    .replace('<body>', `<body data-game="${esc(id)}">`)
    .replaceAll('<!--casual:name-->', esc(CASUAL_GAMES[id]?.name ?? ''))
    .replace('<!--casual:about-->', casualAbout(id))
}
