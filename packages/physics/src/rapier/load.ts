import type { RapierModule } from './rapierWorld.js'

/**
 * Loads and initializes the pinned deterministic Rapier build (ADR-0007
 * decision 2): `@dimforge/rapier3d-deterministic-compat`, whose wasm is inlined
 * as base64 so a single entry works in Node and the browser with no asset
 * plumbing and no loader.
 *
 * The import is dynamic on purpose: physics is loaded while the WebSocket
 * ticket is fetched, so it is never part of the initial JavaScript.
 */
export async function loadRapier(): Promise<RapierModule> {
  const R = (await import('@dimforge/rapier3d-deterministic-compat')) as unknown as RapierModule
  await R.init()
  return R
}
