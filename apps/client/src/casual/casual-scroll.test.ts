// @vitest-environment node
/**
 * A finger drag on the casual game's view carries on into the page.
 *
 * The view is a bounded scroll area inside a page that itself scrolls (the footer sits below it). It held its
 * overscroll (`contain`), so at the view's end a drag moved nothing and the page could not be reached from the
 * game. The fixture is the real `casual.css` and the shell the game page renders; a raw CDP touch drag is the
 * only thing that scrolls headless Chrome here (`Input.synthesizeScrollGesture` does not).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))

function chromePath(): string | null {
  let bundled: string | null = null
  try {
    bundled = chromium.executablePath()
  } catch {
    bundled = null
  }
  for (const candidate of [
    process.env.CHROME_BIN,
    bundled,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const chrome = chromePath()

const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${readFileSync(join(here, 'casual.css'), 'utf8')}</style>
<style>
  html, body { margin: 0; background: #0b0820; color: #f4f1ff; }
  #navbar-mount { height: 56px; }
  /* The inline shell in apps/client/casual.html. */
  .cg { max-width: 480px; margin: 0 auto; height: calc(100dvh - 56px); min-height: 520px;
        display: flex; flex-direction: column; }
  footer { height: 400px; }
</style></head>
<body>
  <div id="navbar-mount"></div>
  <main id="cg" class="cg">
    <header class="cg-top">Vibe Heroes</header>
    <section class="cg-view"><div><div style="height:900px">the game's content</div></div></section>
    <nav class="cg-tabs"><a href="#home">Battle</a><a href="#heroes">Heroes</a><a href="#summon">Summon</a><a href="#quests">Quests</a><a href="#shop">Shop</a></nav>
  </main>
  <footer>the page's footer</footer>
</body></html>`

const run = chrome ? test : test.skip

run(
  'a drag at the game view’s end scrolls the page',
  async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ executablePath: chrome!, args: ['--no-sandbox'] })
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      })
      const tab = await context.newPage()
      await tab.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
      const view = tab.locator('.cg-view')
      const sizes = await view.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }))
      expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight)
      expect(await tab.evaluate(() => scrollY)).toBe(0)

      // Park the view at its end: the page below it is still reachable only if the view passes the drag on.
      await view.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      const at = await view.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + Math.min(120, r.height / 2)),
        }
      })
      const cdp = await context.newCDPSession(tab)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      const drag = async () => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
        for (let i = 1; i <= 12; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: at.x, y: at.y - (300 * i) / 12 }],
          })
          await tab.waitForTimeout(16)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await tab.waitForTimeout(400)
      }
      await drag()
      await drag()
      expect(await tab.evaluate(() => scrollY)).toBeGreaterThan(0)
    } finally {
      await browser.close()
      server.close()
    }
  },
  60_000,
)
