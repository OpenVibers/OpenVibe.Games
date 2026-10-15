import type { PersistenceStore, PlayerRepository } from '@openvibe/persistence'

/**
 * A creator world's store: the world's own rows (its props, constraints, clock) are written as in any place, but a
 * character is never saved there. A player brings their character in and leaves with it exactly as it was: nothing
 * gathered, crafted, traded or dropped in somebody's world reaches Scraplandia, the boards or the Inventory.
 * Characters are still read (appearance, name and the items a player carries in), and a new character made in a
 * creator world lives only for that session.
 */
export function sandboxStore(store: PersistenceStore): PersistenceStore {
  const players: PlayerRepository = {
    findByToken: (token) => store.players.findByToken(token),
    listByToken: (token) => store.players.listByToken(token),
    findByTokenSlot: (token, slot) => store.players.findByTokenSlot(token, slot),
    findById: (id) => store.players.findById(id),
    upsert: async () => {},
    upsertMany: async () => {},
    resetAllPositions: async () => {},
  }
  const wrapped = Object.create(store) as PersistenceStore
  Object.defineProperty(wrapped, 'players', { value: players, enumerable: true })
  return wrapped
}
