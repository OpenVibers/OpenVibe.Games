import type { EditorConnection } from './editorConnection.js'

/**
 * The editor's connection when nobody else can be editing: a creator world has one editor, its owner, and no
 * collaboration socket (/editor-ws is staff-only). Mutations still go through the same lock gate; every request is
 * granted at once, so `acquire` answers true (proceed now) and never calls `then`.
 */
export function createSoloConnection(): EditorConnection {
  const held = new Set<string>()
  return {
    connect: () => {},
    disconnect: () => {},
    sendSelection: () => {},
    canInspect: () => true,
    isLockedByOther: () => false,
    owns: (id) => held.has(id),
    ownsAll: (ids) => ids.every((id) => held.has(id)),
    acquire: (ids) => {
      for (const id of ids) held.add(id)
      return true
    },
    release: (ids) => {
      for (const id of ids) held.delete(id)
    },
    releaseAll: () => held.clear(),
    lockOwner: () => null,
    lockOwners: () => new Map(),
    lockColors: () => new Map(),
    remoteSelectionColors: () => new Map(),
    peers: () => [],
    peerCount: () => 0,
    myPeerId: () => 0,
    connected: () => true,
  }
}
