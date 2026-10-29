import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from 'openvibe-sdk/db'
import { createClient } from 'openvibe-sdk/core'
import { createBenchClient } from 'openvibe-sdk/bench'
import { parseCookies, SESSION_COOKIE } from '../net/sso.js'
import { loadMatch } from './job.js'

const escape = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · OpenVibe Games</title><link rel="stylesheet" href="/shared/kit.css"><link rel="stylesheet" href="/shared/room.css"></head><body class="ovk-app"><main class="ovk-page"><h1>${escape(title)}</h1>${body}</main></body></html>`
const send = (res: ServerResponse, status: number, html: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html) }

export function createAiMatchRoutes(db: Db, benchUrl: string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = new URL(req.url ?? '/', 'http://games.local').pathname
    const match = /^\/ai-matches\/([0-9a-f-]{36})(?:\/games\/(\d+)|\/fun|\/vote)?$/.exec(path)
    if (!match) return false
    void (async () => {
      const stored = await loadMatch(db, match[1]!)
      if (!stored) return send(res, 404, page('Match not found', '<p>No replay is available.</p>'))
      const { result, bench } = stored
      const link = `/ai-matches/${result.id}`
      if (path.endsWith('/vote')) {
        if (req.method !== 'POST') return send(res, 405, page('Method not allowed', ''))
        const origin = req.headers.origin
        const host = req.headers.host
        if (!origin || !host || new URL(origin).host !== host) return send(res, 403, page('Vote refused', '<p>Open this page on Games to vote.</p>'))
        const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? parseCookies(req.headers.cookie)[SESSION_COOKIE]
        if (!token) return send(res, 401, page('Sign in required', '<p>Sign in to vote.</p>'))
        const chunks: Buffer[] = []
        for await (const chunk of req) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 1024) return send(res, 413, page('Vote too large', '')) }
        const vote = new URLSearchParams(Buffer.concat(chunks).toString()).get('vote')
        if (vote !== 'left' && vote !== 'right' && vote !== 'tie') return send(res, 400, page('Invalid vote', ''))
        try {
          const client = createBenchClient(createClient({ network: benchUrl, baseUrls: { bench: benchUrl }, token, autoDiscover: false, retries: 0 }), { baseUrl: benchUrl })
          await client.judgements.cast(bench.funRound, { kind_id: 'games.fun', judge: 'human_pairwise', pair: { left: bench.funEntries[0], right: bench.funEntries[1] }, outcome: vote })
          return send(res, 200, page('Vote recorded', `<p>Thanks for voting.</p><p><a href="${link}/fun">Back to replays</a></p>`))
        } catch { return send(res, 400, page('Vote refused', '<p>Bench could not record this vote. You may have voted already.</p>')) }
      }
      if (path.endsWith('/fun')) {
        const columns = ([0, 1] as const).map((side) => {
          const game = result.games[0]!
          const actor = side === game.first ? 'a' : 'd'
          return `<td><section class="ovk-card"><h2>Replay ${side + 1}</h2><p>Team: ${game.teams[side].map(escape).join(', ')}</p><ol>${game.moves.filter((m) => m.side === side).map((m) => `<li>${escape(m.hero)}</li>`).join('')}</ol><h3>Battle</h3><ol>${game.battle.events.filter((e) => e.actor.startsWith(actor)).map((e) => `<li>Round ${e.round}: ${escape(e.kind)}</li>`).join('')}</ol><a href="${link}/games/1?side=${side}">Full replay</a></section></td>`
        }).join('')
        return send(res, 200, page('Which replay is more fun?', `<table><tr>${columns}</tr></table><form method="post" action="${link}/vote"><button name="vote" value="left">Vote replay 1</button> <button name="vote" value="right">Vote replay 2</button> <button name="vote" value="tie">Tie</button></form>`))
      }
      if (match[2]) {
        const number = Number(match[2])
        const game = result.games[number - 1]
        if (!game) return send(res, 404, page('Game not found', ''))
        const selected = new URL(req.url ?? '/', 'http://games.local').searchParams.get('side')
        const side = selected === '0' || selected === '1' ? Number(selected) as 0 | 1 : null
        const moves = game.moves.filter((m) => side === null || m.side === side).map((m, i) => `<li>Pick ${i + 1}: ${escape(result.offers[m.side].model)} chose ${escape(m.hero)}${m.error ? ' (fallback after illegal answer)' : ''}</li>`).join('')
        const events = game.battle.events.filter((e) => side === null || e.actor.startsWith(side === game.first ? 'a' : 'd')).map((e) => `<li>Round ${e.round}: ${escape(e.actor)} ${escape(e.kind)} ${e.hits.map((h) => `${escape(h.r)} ${h.dmg ?? h.heal ?? h.shield ?? 0}`).join(', ')}</li>`).join('')
        return send(res, 200, page(`Game ${number} replay`, `<p><a href="${link}">Match summary</a></p><p>Winner: ${escape(result.offers[game.winner].model)}</p><h2>Draft</h2><ol>${moves}</ol><h2>Battle</h2><ol>${events}</ol>`))
      }
      const games = result.games.map((g, i) => `<li><a href="${link}/games/${i + 1}">Game ${i + 1}</a>: ${escape(result.offers[g.winner].model)} won</li>`).join('')
      return send(res, 200, page('AI match replay', `<p>${escape(result.offers[0].model)} ${result.wins[0]}–${result.wins[1]} ${escape(result.offers[1].model)}</p><ol>${games}</ol><p><a href="${link}/fun">Vote for the more fun replay</a></p>`))
    })().catch(() => send(res, 500, page('Replay unavailable', '')))
    return true
  }
}
