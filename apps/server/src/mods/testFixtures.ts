/** Shared test fixtures for the mod platform (not used at runtime). */
import type { ModManifest } from './manifest.js'

export const MOD_ID = 'mod_01JABCDEFGHJKMNPQRSTVWXYZ0'

export function sampleManifest(overrides: Partial<ModManifest> = {}): ModManifest {
  return {
    id: MOD_ID,
    name: 'Town Square',
    version: '1.0.0',
    description: 'A public workbench and a greeting.',
    publisher: { type: 'user', id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' },
    target: 'games.browser',
    runtime: 'games-content@1',
    permissions: { capabilities: ['games.world.announce', 'games.prop.place'] },
    resources: { cpuMs: 1, memoryMb: 0, storageMb: 0 },
    compatibility: { runtime: '>=1.0.0 <2.0.0' },
    ...overrides,
  }
}
