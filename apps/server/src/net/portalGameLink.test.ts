import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { portalHtml } from './httpServer.js'

describe('portal game card', () => {
  it('keeps the locally hosted Salvage Rush route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'games-portal-'))
    try {
      const file = join(dir, 'index.html')
      writeFileSync(
        file,
        '<html><head></head><body><a href="/play?game=salvage-rush">Rush</a></body></html>',
      )
      expect(portalHtml(file)).toContain('href="/play?game=salvage-rush"')
      expect(portalHtml(file)).not.toContain('rush.example')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
