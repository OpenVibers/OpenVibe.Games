#!/usr/bin/env node
/**
 * Publish the two official example creator worlds (plan §4 Games; review next step 3: "Seed one or two
 * staff-published creator worlds so /worlds and the home section have real entries").
 *
 *   pnpm --filter @openvibe/server exec tsx scripts/seedExampleWorlds.ts
 *   pnpm --filter @openvibe/server exec tsx scripts/seedExampleWorlds.ts --revise   # also update maps that differ
 *
 * The worlds are authored in src/worlds/exampleWorlds.ts as ordinary v2 map documents; src/worlds/seedExampleWorlds.ts
 * validates them with the same parseMapFile + creatorMapIssues the API uses and writes them through the creator
 * world store. They belong to the official OpenVibe account (the staff account the other official content uses);
 * a person's world is never read, renamed or overwritten. Running it twice changes nothing.
 *
 *   GAMES_OFFICIAL_SUBJECT   the account's usr_… subject (default: the owner's account)
 *   GAMES_OFFICIAL_NAME      the name its worlds carry (default: goosely)
 */
import { createRequire } from 'node:module'
import { createCreatorWorldStore } from '@openvibe/persistence'
import { createConsoleLogger } from '@openvibe/shared'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import { seedExampleWorlds } from '../src/worlds/seedExampleWorlds.js'

const contracts = createRequire(import.meta.url)('openvibe-contracts') as { ids: { isSubjectId(kind: string, value: string): boolean } }
const official = {
  subject: process.env.GAMES_OFFICIAL_SUBJECT || 'usr_01KKT9AC60KM7CRTB3WN1Z8P56',
  name: process.env.GAMES_OFFICIAL_NAME || 'goosely',
}

async function main(): Promise<void> {
  if (!contracts.ids.isSubjectId('user', official.subject)) {
    throw new Error(`GAMES_OFFICIAL_SUBJECT is not a usr_… subject: ${official.subject}`)
  }
  const log = createConsoleLogger({ app: 'seed-example-worlds' }, 'info')
  const config = loadConfig(process.env)
  const db = await openDb(config.db, log)
  try {
    const results = await seedExampleWorlds({
      store: createCreatorWorldStore(db),
      official,
      log,
      revise: process.argv.includes('--revise'),
    })
    for (const r of results) console.log(`[examples] ${r.action.padEnd(9)} ${r.title} (${r.id})`)
    console.log(`[examples] ${results.length} world(s), official account ${official.subject}`)
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error('[examples] failed:', err instanceof Error ? err.stack || err.message : err)
  process.exit(1)
})
