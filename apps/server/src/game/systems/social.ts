import type { ClientTrust } from '@openvibe/protocol'
import type { PlayerId } from '@openvibe/shared'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

/**
 * The player's trust list (who may manipulate their props) and the server-wide
 * announcements. There is no chat message in this protocol.
 */
export class SocialSystem implements System {
  readonly name = 'social'
  readonly handlers: HandlerMap = {
    trust: (session, msg: ClientTrust, _conn) => {
      void this.handleTrust(session, msg.player, msg.trusted)
    },
  }

  constructor(private readonly ctx: ServerContext) {}

  async sendFriends(session: PlayerSession): Promise<void> {
    const friends: { id: string; name: string }[] = []
    for (const id of session.friends) {
      const online = this.ctx.sessions.get(id as PlayerId)
      const name = online?.name ?? (await this.ctx.store.players.findById(id))?.name ?? 'unknown'
      friends.push({ id, name })
    }
    this.ctx.net.send(session, { t: 'friends', friends })
  }

  private async handleTrust(
    session: PlayerSession,
    targetId: string,
    trusted: boolean,
  ): Promise<void> {
    if (targetId === (session.playerId as string)) {
      this.ctx.net.send(session, { t: 'result', action: 'trust', ok: false, error: 'self' })
      return
    }
    // Target must be a real player (online or persisted).
    const online = this.ctx.sessions.get(targetId as PlayerId)
    const known = online ?? (await this.ctx.store.players.findById(targetId))
    if (!known) {
      this.ctx.net.send(session, {
        t: 'result',
        action: 'trust',
        ok: false,
        error: 'unknown_player',
      })
      return
    }
    if (trusted) session.friends.add(targetId)
    else session.friends.delete(targetId)
    session.dirty = true
    this.ctx.net.send(session, { t: 'result', action: 'trust', ok: true })
    await this.sendFriends(session)
  }

  /**
   * Graceful stop (WS-P lifecycle): everyone in the world is told the server is restarting. main.ts
   * then closes every socket with 1012 (service restart); each close saves that character and records
   * games.player.left, as when a player leaves, and the client reconnects on its own.
   */
  announceRestart(): void {
    this.ctx.net.broadcastAll({
      t: 'announce',
      text: '🔄 The server is restarting: you will reconnect in a moment…',
    })
  }
}
