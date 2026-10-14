import type { RapierModule } from './rapierWorld.js'

/**
 * Loads and initializes the pinned deterministic Rapier build (ADR-0007
 * decision 2): `@dimforge/rapier3d-deterministic-compat`, whose wasm is inlined
 * as base64 so a single entry works in Node with no asset plumbing. The
 * browser build aliases it to `@dimforge/rapier3d-deterministic` (plan M6: the
 * wasm becomes its own file, so the 4.4 MB base64 chunk is gone).
 *
 * The import is dynamic on purpose: physics is loaded while the WebSocket
 * ticket is fetched, so it is never part of the initial JavaScript.
 */
export async function loadRapier(): Promise<RapierModule> {
  const R = (await import('@dimforge/rapier3d-deterministic-compat')) as unknown as RapierModule
  // The browser build resolves this import to `@dimforge/rapier3d-deterministic` (apps/client/vite.config.ts): the same
  // engine and wasm as a separate file, instantiated as the module loads, so it has no init() to call.
  if (typeof R.init === 'function') await R.init()
  return R
}
