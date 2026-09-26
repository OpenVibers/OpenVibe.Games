/**
 * Every page of the client names its icon, and the file is in public/. Without a
 * <link rel="icon"> the browser asks for /favicon.ico, which the server answers
 * 404: a console error on every visit, found by the browser check
 * (OpenVibe.Host scripts/browser-check.js, roadmap WS-Q task 3). The icon is the
 * network's app icon in the Games colours (openvibe-shared/app-icon favicon({ site: 'games' })).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const client = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))

describe('page icon', () => {
  it.each(['index.html', 'play.html', 'editor.html'])('%s links /favicon.svg', (page) => {
    const html = readFileSync(client(page), 'utf8')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
  })

  it('public/favicon.svg exists and is an SVG', () => {
    expect(existsSync(client('public/favicon.svg'))).toBe(true)
    expect(readFileSync(client('public/favicon.svg'), 'utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  })
})
