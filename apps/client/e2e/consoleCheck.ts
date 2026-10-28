/**
 * Console smoke (job 4): a real browser opens ~, types a Source query and
 * closes with Escape on the surf page.
 *
 * Run after `pnpm --filter @openvibe/client build`:
 *   pnpm test:console
 *
 * The game server hosts every surf place itself, so `/surf/embed?map=surf_lagoon`
 * is served without extra fixtures. The assertions are behavioural: the DOM
 * overlay, the input capture that keeps typing out of movement, the
 * authoritative `sv_gravity` value from welcome, and an autoexec bind.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

const PORT = 18196
const dir = mkdtempSync(join(tmpdir(), 'openvibe-console-'))

const waitForServer = (server: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 90_000)
    server.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
    server.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  })

/** Poll in the page with page.evaluate; rAF-driven waitForFunction is unreliable headless. */
async function poll(
  page: Page,
  check: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await page.evaluate(check)) return
    await page.waitForTimeout(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main(): Promise<void> {
  const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      DATABASE_DIR: dir,
      DATABASE_URL: '',
      DATABASE_DIRECT_URL: '',
      STATIC_DIR: 'apps/client/dist',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(server)
    const browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-webgl', '--disable-gpu-sandbox'],
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(String(err)))
      const url = `http://127.0.0.1:${PORT}/surf/embed?map=surf_lagoon`
      // autoexec.cfg is a virtual file, applied once welcome has landed. Set
      // it with the page's real origin and reload, rather than racing an init
      // script against the app's boot.
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.evaluate(() => {
        localStorage.setItem('openvibe.cfg.autoexec.cfg', 'bind q +duck; echo AUTOEXEC_RAN')
      })
      await page.reload({ waitUntil: 'domcontentloaded' })

      await poll(
        page,
        () =>
          Boolean(
            (window as unknown as { __openvibe?: { state?: { myEntityId?: string } } }).__openvibe
              ?.state?.myEntityId,
          ),
        90_000,
        'welcome',
      )
      await poll(
        page,
        () =>
          document
            .querySelector('.ovg-console .console-log')
            ?.textContent?.includes('AUTOEXEC_RAN') ?? false,
        10_000,
        'autoexec.cfg',
      )
      const bound = await page.evaluate(() =>
        (
          window as unknown as {
            __openvibe: { input: { bindings: { commandForCode(code: string): string | null } } }
          }
        ).__openvibe.input.bindings.commandForCode('KeyQ'),
      )
      if (bound !== '+duck') throw new Error(`autoexec bind missing: ${String(bound)}`)

      await page.bringToFront()
      const consoleOpen = (): Promise<boolean> =>
        page.evaluate(() => {
          const el = document.querySelector('.ovg-console')
          return el instanceof HTMLElement && !el.hidden
        })
      // A fresh tab can lose the first synthetic key to focus; retry the real
      // key, not a synthetic DOM event, so this still proves ~ opens it.
      for (let attempt = 0; attempt < 3 && !(await consoleOpen()); attempt++) {
        await page.keyboard.press('`')
        await page.waitForTimeout(200)
      }
      if (!(await consoleOpen())) throw new Error('~ did not open the console')
      // The overlay focuses its input in a microtask; focus explicitly so the
      // smoke is about the console behaviour, not a one-frame focus race.
      await page.locator('.console-input').focus()
      const captured = await page.evaluate(
        () =>
          (window as unknown as { __openvibe: { input: { uiCapture: boolean } } }).__openvibe.input
            .uiCapture,
      )
      if (!captured) throw new Error('opening the console did not capture input')

      await page.keyboard.type('sv_gravity')
      await page.keyboard.press('Enter')
      await poll(
        page,
        () =>
          document
            .querySelector('.ovg-console .console-log')
            ?.textContent?.includes('sv_gravity = 800') ?? false,
        5_000,
        'sv_gravity reply',
      )
      await page.keyboard.type('help sv_airaccelerate')
      await page.keyboard.press('Enter')
      await poll(
        page,
        () =>
          document
            .querySelector('.ovg-console .console-log')
            ?.textContent?.includes('sv_airaccelerate = 150') ?? false,
        5_000,
        'sv_airaccelerate reply',
      )

      await page.keyboard.press('Escape')
      await poll(
        page,
        () => document.querySelector('.ovg-console')?.hasAttribute('hidden') ?? false,
        5_000,
        'console close',
      )
      const released = await page.evaluate(
        () =>
          (window as unknown as { __openvibe: { input: { uiCapture: boolean } } }).__openvibe.input
            .uiCapture,
      )
      if (released) throw new Error('closing the console did not release input')
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
      console.log('console smoke passed: open, type sv_gravity/help, Escape close')
    } finally {
      await browser.close()
    }
  } finally {
    server.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
