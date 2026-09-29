import { STARTER_ITEMS, worldSpawn } from '@openvibe/content'
import { Inventory, SkillSet, type GameEntity } from '@openvibe/gameplay'
import { CollisionLayer } from '@openvibe/physics'
import { PROTOCOL_VERSION, encodeServerMessage, type ClientHello } from '@openvibe/protocol'
import { asPlayerId, newEntityId, newPlayerId, qfromYaw, quat, vec3 } from '@openvibe/shared'
import { resolveNetworkUser } from '../../net/networkAuth.js'
import { isGuestToken } from '../../platform/accounts.js'
import type { GameConnection, ServerContext } from './context.js'
import { MOVE } from './movement.js'
import { eventPlayer, progressOf } from './platform.js'
import { createSession, HOTBAR_SIZE, INVENTORY_SIZE } from '../playerSession.js'
import type { HandlerMap, System } from './system.js'

/** A JWT's iat (seconds), read from a token the Network has already accepted; null otherwise. */
function tokenIat(jwt: string): number | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { iat?: unknown }
    return typeof claims.iat === 'number' ? claims.iat : null
  } catch {
    return null
  }
}

/**
 * Connect, hello, disconnect, supersede and revocation close: everything about a session's
 * lifetime in the world. It owns no gameplay state — the session record itself is the state, and
 * the registry in the context is how every other system reaches it.
 */
export class SessionsSystem implements System {
  readonly name = 'sessions'

  /** Connections whose hello is still resolving (a second one while it is refused). */
  private readonly hellosInFlight = new Set<GameConnection>()

  readonly handlers: HandlerMap

  constructor(private readonly ctx: ServerContext) {
    this.handlers = {
      hello: (session, msg, conn) => {
        // A session already exists: a duplicate hello is silently ignored.
        if (session) return
        // A second hello while the first is still resolving (it awaits Network) is refused, so two
        // frames cannot both create a session for one connection.
        if (this.hellosInFlight.has(conn)) {
          conn.close(4008, 'hello_in_flight')
          return
        }
        void this.handleHello(conn, msg as ClientHello)
      },
    }
  }

  /** Players connected now (the readiness `sessions` check; a restart would disconnect them). */
  onlineCount(): number {
    return this.ctx.sessions.size
  }

  onDisconnect(conn: GameConnection): void {
    const session = this.ctx.sessions.getByConn(conn)
    if (!session) return
    this.ctx.sessions.remove(conn)
    // Systems that hold per-session state release it: the offline friend cache and the physgun
    // latch (manipulation), and the disconnect save (persistence, which records player.left).
    this.ctx.lifecycle.left(session)
    const bodyId = this.ctx.sessions.bodyOf(session.playerId)
    if (bodyId !== undefined) {
      this.ctx.world.physics.removeBody(bodyId)
      this.ctx.sessions.deleteBody(session.playerId)
    }
    this.ctx.world.entities.remove(session.entityId)
    this.ctx.world.spatial.remove(session.entityId)
    void this.ctx.integrations.progressSummary?.playerLeft(
      session.playerId as string,
      session.subjectId,
      progressOf(session.skills, session.unlocks).levels,
      this.ctx.world.content.world.id,
    )
    this.ctx.net.broadcastDespawn(session.entityId)
    this.ctx.metrics.sessions = this.ctx.sessions.size
    this.ctx.log.info('player disconnected', { playerId: session.playerId, name: session.name })
  }

  /** Guards one hello per connection while it resolves (it awaits Network); see the handler. */
  private async handleHello(conn: GameConnection, msg: ClientHello): Promise<void> {
    this.hellosInFlight.add(conn)
    try {
      await this.resolveHello(conn, msg)
    } finally {
      this.hellosInFlight.delete(conn)
    }
  }

  private async resolveHello(conn: GameConnection, msg: ClientHello): Promise<void> {
    const ctx = this.ctx
    if (msg.v !== PROTOCOL_VERSION) {
      conn.send(encodeServerMessage({ t: 'reject', reason: 'protocol_mismatch' }))
      conn.close(4002, 'protocol_mismatch')
      return
    }
    if (ctx.sessions.size >= ctx.config.maxPlayers) {
      conn.send(encodeServerMessage({ t: 'reject', reason: 'server_full' }))
      conn.close(4003, 'server_full')
      return
    }

    const slot = msg.slot ?? 0
    // Account resolution. openvibe.network sign-in keys the account on the
    // canonical subject (3 slots, follows you across devices). Guests get ONE
    // character bound to their connection's browser token.
    let token = msg.token
    let subjectId: string | null = null
    let authIat: number | null = null
    let rank: 'owner' | 'admin' | 'moderator' | null = null
    if (msg.auth) {
      const user = await resolveNetworkUser(ctx.config.networkAuthUrl, msg.auth)
      // A signed-in account is keyed by its canonical subject (ADR-0006); a
      // token that carries none cannot name an account.
      if (!user || !user.subjectId) {
        conn.send(encodeServerMessage({ t: 'reject', reason: 'auth_failed' }))
        conn.close(4009, 'auth_failed')
        return
      }
      token = user.subjectId
      subjectId = user.subjectId
      authIat = tokenIat(msg.auth)
      rank = user.rank
      // Guest conversion (WS-B task 8): the character this browser played as a guest joins the
      // account in its first free slot, once.
      if (isGuestToken(msg.token)) {
        const g = await ctx.store.identity.adoptGuestCharacter(msg.token, subjectId, Date.now())
        if (g.moved > 0)
          ctx.log.info('guest character adopted', { subject: subjectId, slot: g.slot ?? -1 })
        else if (g.full)
          ctx.log.info('guest character kept: account slots full', { subject: subjectId })
      }
    } else {
      // A guest token may never look like an account key (`usr_…`): that
      // would open someone else's characters. The client mints plain
      // alphanumerics; anything key-shaped is refused.
      if (!isGuestToken(msg.token)) {
        conn.send(encodeServerMessage({ t: 'reject', reason: 'invalid_hello' }))
        conn.close(4007, 'invalid_guest_token')
        return
      }
      if (slot > 0) {
        conn.send(encodeServerMessage({ t: 'reject', reason: 'guest_one_character' }))
        conn.close(4010, 'guest_one_character')
        return
      }
    }
    // A disconnect save of this character may still be queued: read after it lands, not before.
    await ctx.systems.persistence.drain(5000)
    const existing = await ctx.store.players.findByTokenSlot(token, slot)
    // One live session per CHARACTER; other characters of the same account
    // may stay online (an account still only plays one at a time in
    // practice — same token kicks apply per slot).
    for (const s of ctx.sessions.values()) {
      if (s.token === token && s.charSlot === slot) {
        s.closeConnection(4004, 'session_superseded')
      }
    }

    const world = ctx.world.content.world
    const playerId = existing ? asPlayerId(existing.id) : newPlayerId()
    const mapSpawn = worldSpawn(world)
    const spawn = existing
      ? vec3(existing.pos[0], existing.pos[1], existing.pos[2])
      : vec3(mapSpawn.pos[0], mapSpawn.pos[1], mapSpawn.pos[2])
    const inventory = existing
      ? Inventory.fromDto(existing.inventory, ctx.world.content)
      : new Inventory(INVENTORY_SIZE, HOTBAR_SIZE, ctx.world.content)
    const skills = existing
      ? SkillSet.fromDto(existing.skills, ctx.world.content)
      : new SkillSet(ctx.world.content)
    const friends = new Set(existing?.friends ?? [])
    // The client's customization is authoritative for looks (validated by
    // the protocol schema) — EXCEPT body size: everyone shares one hull and
    // silhouette so combat stays fair.
    const appearance = { ...msg.appearance, height: 1, build: 1 }

    // Starter kit: every scrapper carries a physgun. Also grants it to
    // players from before the tool system existed.
    for (const grant of STARTER_ITEMS) {
      if (inventory.countOf(grant.item) === 0) {
        const leftover = inventory.add(grant.item, grant.count)
        if (leftover > 0) {
          ctx.log.warn('starter item did not fit', { item: grant.item, playerId })
        }
      }
    }

    const session = createSession({
      playerId,
      charSlot: slot,
      entityId: newEntityId(),
      token,
      subjectId,
      authIat,
      rank,
      name: msg.name,
      spawn,
      yaw: existing?.yaw ?? mapSpawn.yaw,
      inventory,
      skills,
      friends,
      appearance,
      stats: existing?.stats ?? undefined,
      armor: existing?.armor ?? null,
      reputation: existing?.reputation ?? {},
      unlocks: existing?.unlocks ?? [],
      activeJob: existing?.activeJob ?? null,
      content: ctx.world.content,
      send: (text) => conn.send(text),
      closeConnection: (code, reason) => conn.close(code, reason),
    })
    ctx.sessions.add(conn, session)
    ctx.lifecycle.joined(session)

    // Player entity (transient — players persist via the player repository).
    const entity: GameEntity = {
      id: session.entityId,
      kind: 'player',
      transform: { pos: session.move.pos, rot: qfromYaw(quat(), session.yaw) },
      persistent: false,
      dirty: false,
    }
    ctx.world.entities.add(entity)
    ctx.world.spatial.insert(entity.id, session.move.pos.x, session.move.pos.z)

    // Kinematic capsule so props collide with players. Shorter than the
    // movement hull and lifted off the feet: standing ON a prop must not
    // press it down (that caused sink/jitter loops when prop-surfing).
    const bodyId = ctx.world.physics.addBody({
      shape: { type: 'capsule', radius: MOVE.capsuleRadius, height: MOVE.capsuleHeight - 0.3 },
      motion: 'kinematic',
      pos: vec3(session.move.pos.x, session.move.pos.y + 0.15, session.move.pos.z),
      layer: CollisionLayer.Player,
      collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
    })
    ctx.sessions.setBody(playerId, bodyId)

    ctx.net.send(session, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      rank,
      playerId: playerId as string,
      entityId: session.entityId as string,
      tick: ctx.clock.tick,
      tickRate: ctx.config.tickRate,
      snapshotRate: ctx.config.tickRate / ctx.config.snapshotEvery,
    })
    ctx.net.sendInventory(session)
    ctx.net.sendSkills(session)
    await ctx.systems.social.sendFriends(session)
    ctx.net.send(session, ctx.net.timeWire())
    ctx.systems.economy.sendReputation(session)
    ctx.metrics.sessions = ctx.sessions.size
    ctx.integrations.progressSummary?.playerJoined(session.playerId as string)
    const recorder = ctx.integrations.events
    if (recorder) {
      // Baseline = what the database holds for this character (nothing for a
      // new one), so the first save reports only what was earned since.
      const stored = existing
        ? progressOf(SkillSet.fromDto(existing.skills, ctx.world.content), existing.unlocks)
        : { levels: {}, unlocks: [] }
      await ctx.store.transaction(async (t) => {
        await recorder.recordJoin(t, eventPlayer(session), stored, existing !== null)
      })
    }
    ctx.log.info('player connected', {
      playerId: playerId as string,
      name: msg.name,
      restored: existing !== null,
    })
  }

  /**
   * Network moved this person's token cutoff (sign out everywhere, password changed, banned): close
   * every session they opened with an older Network sign-in (4011 signed_out). The client's reconnect
   * then fails its /api/auth/me check. Returns how many closed.
   */
  revokeSubject(subjectId: string, validAfterMs: number): number {
    if (!subjectId || !Number.isFinite(validAfterMs)) return 0
    let closed = 0
    for (const session of this.ctx.sessions.all()) {
      if (session.subjectId !== subjectId) continue
      if (session.authIat !== null && session.authIat * 1000 >= validAfterMs) continue
      try {
        session.send(encodeServerMessage({ t: 'reject', reason: 'signed_out' }))
      } catch {
        // closing anyway
      }
      session.closeConnection(4011, 'signed_out')
      closed++
    }
    return closed
  }
}
