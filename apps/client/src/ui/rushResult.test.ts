// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildResultCard, resultPageUrl, resultShareText } from './rushResult.js'

const result = {
  t: 'salvage_result' as const,
  roundId: '0:1700000000000-12',
  score: 12,
  rank: 2,
  players: 7,
  best: 12,
}

/**
 * The result card of a finished round: the player's own score, their rank and their best, and the button
 * that shares the round's page. The numbers come from the server's result, never from the client.
 */
describe('the result card of a round', () => {
  it('shows the score, the rank and the best', () => {
    const card = buildResultCard(result, 'https://openvibe.games')
    expect(card.textContent).toContain('12')
    expect(card.textContent).toContain('2 of 7')
    expect(card.textContent).toContain('Best')
  })

  it('says plainly when there is no best on record', () => {
    const card = buildResultCard({ ...result, best: null }, 'https://openvibe.games')
    expect(card.textContent).toContain('no round on record yet')
  })

  it('shares a page, not a screenshot', () => {
    expect(resultPageUrl('0:1700000000000-12', 'https://openvibe.games')).toBe(
      'https://openvibe.games/result/0%3A1700000000000-12',
    )
    expect(resultShareText(result)).toBe(
      'I scored 12 in Salvage Rush (rank 2 of 7). My best round: 12.',
    )
  })

  it('carries the buttons a player needs', () => {
    const card = buildResultCard(result, 'https://openvibe.games')
    expect(card.querySelector('.rush-result-share')?.textContent).toBe('Share')
    expect(card.querySelector('.rush-result-board')?.getAttribute('href')).toBe(
      '/leaderboard.html?game=salvage-rush',
    )
  })
})
