/**
 * Draws a casual game's share card (plan T22: the Open Graph / X card a shared or advertised link unfurls as),
 * 1200×630, from the game's own heroes, into public/casual/<game>/card.png.
 *
 * Run: node --import tsx apps/client/scripts/casualCard.ts [game] (needs Chrome: playwright's, or CHROME=path)
 * The PNG is committed; rerun it when the game's look or name changes.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { CASUAL_GAMES, heroDef } from '@openvibe/casual'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const game = process.argv[2] ?? 'vibe-heroes'
const pack = CASUAL_GAMES[game]
if (!pack) throw new Error(`unknown casual game ${game}`)

// The portraits as markup (no DOM needed), the same art the game draws.
const { portraitMarkup } = await import('../src/casual/art.js')

const RING: Record<string, string> = {
  legendary: '#ffcf3f',
  epic: '#b979ff',
  rare: '#45a8ff',
  common: '#a3adbb',
}
const BG: Record<string, string> = {
  flame: 'radial-gradient(circle at 50% 30%, #ffb38a, #e2502a 75%)',
  tide: 'radial-gradient(circle at 50% 30%, #a6dcff, #2a7fd8 75%)',
  grove: 'radial-gradient(circle at 50% 30%, #b8f0b0, #2f9a4c 75%)',
  dawn: 'radial-gradient(circle at 50% 30%, #fff1b0, #e0a400 75%)',
  dusk: 'radial-gradient(circle at 50% 30%, #d6c2ff, #6a3fd0 75%)',
}
const cast = ['kaito', 'thalia', 'seraphine', 'nyx', 'juno']
// Fanned: left, top and tilt of each card; the middle one is the big legendary.
const FAN = [
  [0, 170, -12],
  [95, 115, -6],
  [175, 60, 0],
  [315, 115, 6],
  [405, 170, 12],
]
const cards = cast
  .map((id, i) => {
    const d = heroDef(pack, id)
    if (!d) return ''
    const [left, top, tilt] = FAN[i] ?? [0, 0, 0]
    const mid = i === 2
    return `<div class="card${mid ? ' mid' : ''}" style="--rc:${RING[d.rarity]};background:${BG[d.element]};left:${left}px;top:${top}px;transform:rotate(${tilt}deg);z-index:${mid ? 5 : 3 - Math.abs(i - 2)}">${portraitMarkup(d)}</div>`
  })
  .join('')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: 'Noto Sans', system-ui, sans-serif;
    background: radial-gradient(700px 420px at 78% 40%, rgba(255,207,63,.35), transparent 70%),
      radial-gradient(900px 600px at 10% 0%, #3a2378, transparent 70%), radial-gradient(900px 500px at 50% 120%, #1d3a7a, transparent 70%), #120c2a; color: #f4f1ff; }
  .text { position: absolute; left: 64px; top: 92px; width: 500px; }
  .eyebrow { font-size: 22px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #bdb4dc; }
  h1 { margin: 10px 0 18px; font-size: 100px; line-height: .95; font-weight: 900;
    background: linear-gradient(180deg, #fff6c8, #ffd25a 45%, #ff9f1c); -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 5px 0 #5a2a00); }
  p { margin: 0; font-size: 28px; line-height: 1.3; color: #e9e4ff; }
  .pill { display: inline-block; margin-top: 30px; padding: 14px 26px; border-radius: 999px; font-size: 26px; font-weight: 900; color: #2a1600;
    background: linear-gradient(180deg, #fff1a8, #ffd25a 40%, #ff9f1c); box-shadow: 0 5px 0 #8a4b00; }
  .row { position: absolute; left: 585px; top: 40px; width: 580px; height: 560px; }
  .card { position: absolute; width: 170px; height: 230px; border-radius: 20px; overflow: hidden; border: 5px solid var(--rc);
    box-shadow: 0 20px 40px rgba(0,0,0,.55), 0 0 26px color-mix(in srgb, var(--rc) 50%, transparent); }
  .card.mid { width: 230px; height: 310px; }
  .card svg { width: 100%; height: 100%; display: block; }
  .brand { position: absolute; left: 64px; bottom: 34px; font-size: 22px; font-weight: 800; color: #bdb4dc; letter-spacing: .02em; }
</style></head><body>
  <div class="text"><div class="eyebrow">Free in your browser</div><h1>${pack.name}</h1>
  <p>Collect heroes, fuse their shards and win even while you are away.</p><div class="pill">Play now, no download</div></div>
  <div class="row">${cards}</div>
  <div class="brand">openvibe.games</div>
</body></html>`

const out = join(root, 'public', 'casual', pack.id, 'card.png')
mkdirSync(dirname(out), { recursive: true })
const browser = await chromium.launch(
  process.env.CHROME ? { executablePath: process.env.CHROME } : {},
)
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
  await page.setContent(html)
  await page.screenshot({ path: out })
  console.log(`card: ${out}`)
} finally {
  await browser.close()
}
