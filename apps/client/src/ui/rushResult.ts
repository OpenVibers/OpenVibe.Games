/**
 * The result card of a finished Salvage Rush round (the market outcome, 2026-10-30): the player's own
 * score, their rank in that round and their own best, and one button that shares it. The numbers come
 * from the server's round result, never from the client.
 */
import type { ServerMessage } from '@openvibe/protocol'
import './rushResult.css'

export type RoundResult = Extract<ServerMessage, { t: 'salvage_result' }>

/** The address of the shareable page of one round. */
export function resultPageUrl(roundId: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/result/${encodeURIComponent(roundId)}`
}

/** The words a player sends: their score, their rank and their best. */
export function resultShareText(result: RoundResult): string {
  const score = new Intl.NumberFormat('en-US').format(result.score)
  const rank = new Intl.NumberFormat('en-US').format(result.rank)
  const players = new Intl.NumberFormat('en-US').format(result.players)
  const best = result.best === null ? null : new Intl.NumberFormat('en-US').format(result.best)
  return [
    `I scored ${score} in Salvage Rush (rank ${rank} of ${players}).`,
    best === null ? null : `My best round: ${best}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The card, as a DOM tree. The share button shares the round's page (the result screen), so the link
 * that travels is a page, not a screenshot.
 */
export function buildResultCard(result: RoundResult, origin: string): HTMLElement {
  const fmt = new Intl.NumberFormat('en-US')
  const url = resultPageUrl(result.roundId, origin)
  const card = document.createElement('div')
  card.className = 'rush-result'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Round result')

  const kicker = document.createElement('p')
  kicker.className = 'rush-result-kicker'
  kicker.textContent = 'Round over'

  const score = document.createElement('p')
  score.className = 'rush-result-score'
  const scoreValue = document.createElement('b')
  scoreValue.textContent = fmt.format(result.score)
  score.append(scoreValue, document.createTextNode(' scrap'))

  const facts = document.createElement('dl')
  facts.className = 'rush-result-facts'
  const add = (label: string, value: string): void => {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    row.append(dt, dd)
    facts.append(row)
  }
  add('Rank', `${fmt.format(result.rank)} of ${fmt.format(result.players)}`)
  add('Best', result.best === null ? 'no round on record yet' : fmt.format(result.best))

  const actions = document.createElement('div')
  actions.className = 'rush-result-actions'
  const share = document.createElement('button')
  share.type = 'button'
  share.className = 'rush-result-share'
  share.textContent = 'Share'
  share.addEventListener('click', () => {
    const text = resultShareText(result)
    if (navigator.share) {
      navigator.share({ title: 'A Salvage Rush round', text, url }).catch(() => undefined)
      return
    }
    void navigator.clipboard?.writeText(`${text} ${url}`).catch(() => undefined)
    share.textContent = 'Copied'
    window.setTimeout(() => {
      share.textContent = 'Share'
    }, 1500)
  })
  const board = document.createElement('a')
  board.className = 'rush-result-board'
  board.href = '/leaderboard.html?game=salvage-rush'
  board.textContent = 'Full board'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'rush-result-close'
  close.textContent = 'Next round'
  close.addEventListener('click', () => card.remove())
  actions.append(share, board, close)

  card.append(kicker, score, facts, actions)
  return card
}
