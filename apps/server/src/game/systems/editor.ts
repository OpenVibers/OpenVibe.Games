import type { ServerContext } from './context.js'
import type { System } from './system.js'

/**
 * The editor's one wire effect: tell every client the map changed. The reconcile itself is main.ts's
 * (it owns the map document) and stays there.
 */
export class EditorSystem implements System {
  readonly name = 'editor'

  constructor(private readonly ctx: ServerContext) {}

  broadcastMapReload(): void {
    this.ctx.net.broadcastAll({ t: 'map_reload' })
    this.ctx.net.broadcastAll({
      t: 'announce',
      text: '🗺 The world was reshaped by the map editors…',
    })
  }
}
