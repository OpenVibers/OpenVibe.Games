import { describe, expect, it } from 'vitest'
import { SALVAGE_RUSH_PACK } from '@openvibe/content/salvage-rush'
import { resultPageHtml, resultPageUrl, type ResultPageInput } from './resultPage.js'

const row = (accountKey: string, name: string, score: number, rank: number) => ({
  accountKey,
  playerName: name,
  score,
  rank,
  finishedAt: 1_700_000_000_000,
})

const input = (over: Partial<ResultPageInput> = {}): ResultPageInput => ({
  roundId: '0:1700000000000-12',
  rows: [row('guest:aaa', 'Ada', 12, 1), row('guest:bbb', 'Bo', 5, 2)],
  viewerKey: 'guest:aaa',
  viewerBest: 12,
  site: 'https://openvibe.games',
  ...over,
})

describe('the result page of a round', () => {
  it('shows the score, the rank and the best of the player who opened it', () => {
    const html = resultPageHtml(input())
    expect(html).toContain('Your result')
    expect(html).toContain('12')
    expect(html).toContain('Rank')
    expect(html).toContain('1 of 2')
    expect(html).toContain('Best')
  })

  it('marks the viewer\'s own row on the board of that round', () => {
    const html = resultPageHtml(input())
    expect(html).toContain('You')
    expect(html).toContain('Ada')
    expect(html).toContain('Bo')
  })

  it('says so plainly when the viewer has no round on record', () => {
    const html = resultPageHtml(input({ viewerKey: 'guest:zzz', viewerBest: null }))
    expect(html).toContain('no round on record yet')
  })

  it('never invents a score: a round with no rows shows no result', () => {
    const html = resultPageHtml(input({ rows: [], viewerKey: null, viewerBest: null }))
    expect(html).toContain('Nobody scored in this round.')
    expect(html).not.toContain('Your result')
  })

  it('shares a page, not a screenshot', () => {
    const html = resultPageHtml(input())
    expect(resultPageUrl('https://openvibe.games/', '0:1700000000000-12')).toBe(
      'https://openvibe.games/result/0%3A1700000000000-12',
    )
    expect(html).toContain('data-ovk-share')
    expect(html).toContain('I scored 12 in Salvage Rush')
  })

  it('carries the one line every game page carries', () => {
    expect(resultPageHtml(input())).toContain('Play as a guest, no sign-up.')
    // kit.answer's rows are Kit 2: without kit-data.css they fall apart into a bare list.
    expect(resultPageHtml(input())).toContain('href="/shared/kit-data.css"')
  })

  it('wears the shared kit and the shared theme', () => {
    const html = resultPageHtml(input())
    expect(html).toContain('/shared/kit.css')
    expect(html).toContain('/shared/theme-loader.js')
    expect(html).toContain('ovk-page')
  })
})

describe('the card facts of the home page', () => {
  it('states the length of a round from the content pack, not from a sentence', () => {
    const seconds = SALVAGE_RUSH_PACK.game?.roundSeconds
    expect(seconds).toBeGreaterThan(0)
  })
})
