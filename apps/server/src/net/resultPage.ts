/**
 * The result page of a Salvage Rush round (the market outcome, 2026-10-30): a page you can send to
 * someone, with the score, the rank and the player's own best on it. Every number on it is read from the
 * rows the server wrote when the round ended; nothing here is typed in by hand.
 *
 * The page is built with the OpenVibe Kit (openvibe-shared/kit), the same look every OpenVibe app page
 * has, and wears the reader's theme (dark or light) through the shared tokens.
 */
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from 'openvibe-sdk/db'
import { playerBestScore, roundRows, type RoundRow } from '../game/progression.js'
import { viewerAccountKey } from './viewer.js'

type Builder = (o: Record<string, unknown>) => string
interface Kit {
  esc: (v: unknown) => string
  icon: (name: string, o?: Record<string, unknown>) => string
  head: Builder
  list: (rows: string[], o?: Record<string, unknown>) => string
  row: Builder
  section: Builder
  fold: Builder
  answer: Builder
  toolHead: Builder
  tool: Builder
  page: Builder
  button: Builder
  badge: (text: string, tone?: string) => string
}
const sharedRequire = createRequire(import.meta.url)
const kit = sharedRequire('openvibe-shared/kit') as Kit

/** The game the rounds belong to. */
export const RESULT_GAME = 'salvage-rush' as const

/** The one line every game page carries: what a player gets, and what they never have to do. */
export const GAME_PROMISE =
  'Play as a guest, no sign-up. No ads inside the games.'

export interface ResultPageInput {
  /** The round the page is about. */
  roundId: string
  /** The round's rows, in rank order. */
  rows: RoundRow[]
  /** The viewer's account key, when the request named one. */
  viewerKey: string | null
  /** The viewer's own best round, when we keep one. */
  viewerBest: number | null
  /** The address the page is served on (the share link). */
  site: string
}

const n = (v: number): string => new Intl.NumberFormat('en-US').format(v)

/** The shareable address of a round's result page. */
export function resultPageUrl(site: string, roundId: string): string {
  return `${site.replace(/\/+$/, '')}/result/${encodeURIComponent(roundId)}`
}

function shareText(input: ResultPageInput, mine: RoundRow | null): string {
  if (!mine) return 'A round of Salvage Rush on OpenVibe.Games'
  const best = input.viewerBest === null ? null : Math.max(input.viewerBest, mine.score)
  return [
    `I scored ${n(mine.score)} in Salvage Rush (rank ${n(mine.rank)} of ${n(input.rows.length)}).`,
    best === null ? null : `My best round: ${n(best)}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

/** The page itself, built from the rows of one round. */
export function resultPageHtml(input: ResultPageInput): string {
  const mine = input.viewerKey ? (input.rows.find((r) => r.accountKey === input.viewerKey) ?? null) : null
  const players = input.rows.length
  const url = resultPageUrl(input.site, input.roundId)
  const board = input.rows.slice(0, 25).map((row) =>
    kit.row({
      title: row.playerName,
      meta: `${n(row.score)} scrap`,
      badge: mine && row.accountKey === mine.accountKey ? kit.badge('You', 'accent') : '',
      sub: `Rank ${n(row.rank)} of ${n(players)}`,
    }),
  )
  const best = input.viewerBest === null ? null : Math.max(input.viewerBest, mine?.score ?? 0)
  const answer = kit.answer({
    title: mine ? 'Your result' : 'This round',
    rows: mine
      ? [
          ['Score', n(mine.score)],
          ['Rank', `${n(mine.rank)} of ${n(players)}`],
          ['Best', best === null ? 'no round on record yet' : n(best)],
        ]
      : input.viewerKey
        ? [
            ['Players', n(players)],
            ['Your best', best === null ? 'no round on record yet' : n(best)],
          ]
        : [['Players', n(players)]],
  })
  const share = kit.button({
    href: url,
    label: 'Share this result',
    icon: 'send',
    attrs: { 'data-ovk-share': shareText(input, mine) },
  })
  const body = [
    kit.tool({
      head: kit.toolHead({
        icon: 'trophy',
        title: mine ? 'Round over' : 'A round of Salvage Rush',
        task: 'The server scored this round; these are its numbers.',
      }),
      answer,
    }),
    kit.section({
      title: 'The board of this round',
      note: players > 0 ? `${n(players)} ${players === 1 ? 'player' : 'players'} scored in it.` : '',
      body: kit.list(board, { empty: 'Nobody scored in this round.' }),
    }),
    kit.section({
      body:
        `<div class="ovk-tool-card">${share}</div>` +
        `<p class="ovk-note">${kit.esc(GAME_PROMISE)}</p>` +
        kit.button({ href: '/leaderboard.html?game=salvage-rush', label: 'Full leaderboard', kind: 'ghost', icon: 'trophy' }),
    }),
  ].join('\n')
  const html = kit.page({
    head: kit.head({
      title: 'A Salvage Rush round',
      sub: mine ? `You scored ${n(mine.score)} scrap, rank ${n(mine.rank)} of ${n(players)}.` : `Round of ${n(players)} players.`,
      back: { href: '/play?game=salvage-rush', label: 'Play Salvage Rush' },
    }),
    body,
  })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A Salvage Rush round · OpenVibe.Games</title><meta name="robots" content="noindex,follow"><meta name="description" content="A scored round of Salvage Rush on OpenVibe.Games."><script src="/shared/theme-loader.js"></script><link rel="stylesheet" href="/shared/kit.css"></head><body class="ovk-app"><div id="navbar-mount"></div>${html}<script src="/shared/navbar.js" defer></script><script src="/shared/kit-web.js" defer></script></body></html>`
}

export interface ResultRouteOptions {
  db: Db
  networkAuthUrl: string | null
  /** The public address of the site, for the share link. */
  site: string
}

/**
 * GET /result/<roundId>: the page of one finished round. A round we do not have is a 404, said plainly.
 */
export function handleResultPage(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResultRouteOptions,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const match = /^\/result\/([^/]+)\/?$/.exec(new URL(req.url ?? '/', 'http://games.local').pathname)
  if (!match) return false
  const roundId = decodeURIComponent(match[1] ?? '')
  const send = (status: number, body: string): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  void (async () => {
    const rows = await roundRows(opts.db, RESULT_GAME, roundId)
    if (!rows.length) {
      send(
        404,
        resultPageHtml({
          roundId,
          rows: [],
          viewerKey: null,
          viewerBest: null,
          site: opts.site,
        }),
      )
      return
    }
    const viewerKey = await viewerAccountKey(req, { networkAuthUrl: opts.networkAuthUrl }).catch(() => null)
    const viewerBest = viewerKey ? await playerBestScore(opts.db, RESULT_GAME, viewerKey) : null
    send(
      200,
      resultPageHtml({ roundId, rows, viewerKey, viewerBest, site: opts.site }),
    )
  })().catch(() => {
    if (!res.headersSent) send(503, resultPageHtml({ roundId, rows: [], viewerKey: null, viewerBest: null, site: opts.site }))
  })
  return true
}
