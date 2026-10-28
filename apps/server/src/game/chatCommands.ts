import {
  CHAT_MAX_LENGTH,
  type ClientSay,
  type ClientSayTeam,
  type ServerSay,
} from '@openvibe/protocol'
import type { PlayerSession } from './playerSession.js'
import type { ServerContext } from './systems/context.js'
import type { HandlerMap, System } from './systems/system.js'

/**
 * Chat and its Source-style commands (`!r`, `!top`, `!wr`, `!pr`, `!stage`).
 *
 * Two rules shape this file:
 *  - A command is only ever text the player typed. The server authorizes and
 *    performs every action; a `!` prefix is a convenience, not a capability.
 *  - Every reply is a chat line (`say`), so command output lives in the same
 *    scrollback as conversation instead of flashing past as a toast.
 *
 * `/` commands reply only to the sender; `!` commands reply to the room.
 * `!r` resets and announces, while `/r` resets silently.
 */

/** `!`/`/` are stripped; the command word is lower-cased. */
export interface ParsedChat {
  /** Lower-cased command without its trigger; null for ordinary chat. */
  command: string | null
  args: string[]
  /** The `/` trigger: feedback goes only to the sender. */
  silent: boolean
}

/**
 * Parse one chat line. SourceMod treats a leading `!` as public and `/` as
 * silent; ordinary text has no command. Command names are case-insensitive.
 */
export function parseChatCommand(text: string): ParsedChat {
  const trimmed = text.trim()
  if (!trimmed) return { command: null, args: [], silent: false }
  const trigger = trimmed[0]
  if (trigger !== '!' && trigger !== '/') return { command: null, args: [], silent: false }
  const body = trimmed.slice(1).trim()
  if (!body) return { command: '', args: [], silent: trigger === '/' }
  const [command = '', ...args] = body.split(/\s+/)
  return { command: command.toLowerCase(), args: args.slice(0, 8), silent: trigger === '/' }
}

export type ChatCommandName = 'r' | 'top' | 'wr' | 'pr' | 'practice' | 'stage' | 'b' | 'help'

/** Source's aliases, kept in one table so parsing and help cannot disagree. */
const COMMAND_ALIASES: Readonly<Record<string, ChatCommandName>> = {
  r: 'r',
  restart: 'r',
  top: 'top',
  wr: 'wr',
  pr: 'pr',
  practice: 'practice',
  p: 'practice',
  stage: 'stage',
  stages: 'stage',
  b: 'b',
  bonus: 'b',
  help: 'help',
  h: 'help',
}

export function canonicalChatCommand(name: string): ChatCommandName | null {
  return COMMAND_ALIASES[name] ?? null
}

/** Escape/normalise a chat line before it reaches the wire: one line, no controls. */
export function cleanChatText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH)
}

/** `m:ss.mmm`, the same format as the surf timer. */
export function formatChatTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** One second's budget for a normal player: five lines, refilling at 2/s. */
export const CHAT_RATE_CAPACITY = 5
export const CHAT_RATE_REFILL_PER_SECOND = 2

/**
 * Per-player token bucket. Commands and conversation share it, so a client
 * cannot hammer `!top` (or the database behind it) faster than it can talk.
 */
export class ChatRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly capacity = CHAT_RATE_CAPACITY,
    private readonly refillPerSecond = CHAT_RATE_REFILL_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const at = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at }
    const elapsed = Math.max(0, at - bucket.at)
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed * this.refillPerSecond) / 1000)
    bucket.at = at
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }

  forget(key: string): void {
    this.buckets.delete(key)
  }
}

/**
 * The chat system: validates the session, rate-limits, echoes conversation
 * and runs the surf commands against the same SurfSystem and records seam
 * the rest of the game uses. It is deliberately a System so the handler
 * table sees `say`/`say_team` exactly once.
 */
export class ChatSystem implements System {
  readonly name = 'chat'
  private readonly limiter = new ChatRateLimiter()

  readonly handlers: HandlerMap = {
    say: (session, msg: ClientSay) => this.receive(session, msg.text, 'say'),
    say_team: (session, msg: ClientSayTeam) => this.receive(session, msg.text, 'say_team'),
  }

  constructor(private readonly ctx: ServerContext) {}

  onLeave(session: PlayerSession): void {
    this.limiter.forget(session.playerId)
  }

  private receive(session: PlayerSession, raw: string, channel: 'say' | 'say_team'): void {
    // Until welcome the client is not in the game: no chat, no commands, and
    // no rate-limit budget to spend.
    if (!session.welcomed) return
    if (!this.limiter.allow(session.playerId)) return
    const text = cleanChatText(raw)
    if (!text) return
    const parsed = parseChatCommand(text)
    if (parsed.command === null) {
      this.ctx.net.broadcastAll({
        t: 'say',
        channel,
        from: session.name,
        fromId: session.entityId,
        text,
      })
      return
    }
    void this.runCommand(session, parsed).catch((err: unknown) => {
      this.ctx.log.warn(`chat command failed: ${String(err)}`)
      this.reply(session, true, 'That command failed. Try again.')
    })
  }

  private async runCommand(session: PlayerSession, parsed: ParsedChat): Promise<void> {
    const command = canonicalChatCommand(parsed.command ?? '')
    const trigger = parsed.silent ? '/' : '!'
    if (!command) {
      this.reply(session, true, `Unknown command: ${trigger}${parsed.command ?? ''}`)
      return
    }
    switch (command) {
      case 'r':
        if (!session.surf) {
          this.reply(session, true, 'Surf is not active here.')
          return
        }
        this.ctx.systems.surf.restart(session)
        // `/r` is silent: the state reset is its whole reply. `!r` tells the
        // room, as a public Source command does.
        if (!parsed.silent) this.reply(session, false, `${session.name} restarted the run.`)
        return
      case 'practice':
        if (!session.surf) {
          this.reply(session, true, 'Surf is not active here.')
          return
        }
        if (session.surfPractice) {
          this.ctx.systems.surf.setPractice(session, false)
          this.reply(
            session,
            parsed.silent,
            `${session.name} left practice — runs are ranked again.`,
          )
        } else {
          this.ctx.systems.surf.setPractice(session, true)
          this.reply(
            session,
            parsed.silent,
            `${session.name} entered practice — runs are not ranked.`,
          )
        }
        return
      case 'stage':
        this.stage(session, parsed)
        return
      case 'top':
        await this.top(session, parsed)
        return
      case 'wr':
        await this.wr(session, parsed)
        return
      case 'pr':
        await this.pr(session, parsed)
        return
      case 'b':
        this.reply(session, parsed.silent, 'No bonuses on this map.')
        return
      case 'help':
        this.replyLines(session, parsed.silent, [
          'Commands: !r restart · !top · !wr · !pr · !practice · !stage <n> · !b',
          'Use / instead of ! to keep the reply to yourself.',
        ])
        return
    }
  }

  private stage(session: PlayerSession, parsed: ParsedChat): void {
    if (!session.surf) {
      this.reply(session, true, 'Surf is not active here.')
      return
    }
    if (!session.surfPractice) {
      // Refusal is always private: a failed command should not spam the room.
      this.reply(session, true, 'Practice mode is off. Type !practice first.')
      return
    }
    const stages = session.surf.map.stages
    const raw = parsed.args[0]
    const stage = raw === undefined ? Math.min(session.surf.reached + 1, stages) : Number(raw)
    if (!Number.isInteger(stage) || stage < 0 || stage > stages) {
      this.reply(session, true, `Stage must be a whole number from 0 to ${stages}.`)
      return
    }
    if (!this.ctx.systems.surf.goToStage(session, stage)) {
      this.reply(session, true, `There is no stage ${stage} on this map.`)
      return
    }
    this.reply(session, parsed.silent, `${session.name} moved to stage ${stage}.`)
  }

  private async top(session: PlayerSession, parsed: ParsedChat): Promise<void> {
    const mapId = session.surf?.map.id
    if (!mapId) return this.reply(session, true, 'Surf is not active here.')
    const records = this.ctx.integrations.surf
    if (!records) return this.reply(session, true, 'Surf records are unavailable.')
    const rows = (await records.topRuns(mapId, 10)).slice(0, 10)
    if (!rows.length) {
      this.reply(session, parsed.silent, `No times on ${mapId} yet.`)
      return
    }
    this.replyLines(session, parsed.silent, [
      `Top ${rows.length} — ${mapId}`,
      ...rows.map((row, i) => `${i + 1}. ${formatChatTime(row.timeMs)}  ${row.name}`),
    ])
  }

  private async wr(session: PlayerSession, parsed: ParsedChat): Promise<void> {
    const mapId = session.surf?.map.id
    if (!mapId) return this.reply(session, true, 'Surf is not active here.')
    const records = this.ctx.integrations.surf
    if (!records) return this.reply(session, true, 'Surf records are unavailable.')
    const wrMs = await records.wrMs(mapId)
    this.reply(
      session,
      parsed.silent,
      wrMs === null ? `No WR on ${mapId} yet.` : `${mapId} WR: ${formatChatTime(wrMs)}`,
    )
  }

  private async pr(session: PlayerSession, parsed: ParsedChat): Promise<void> {
    const mapId = session.surf?.map.id
    if (!mapId) return this.reply(session, true, 'Surf is not active here.')
    const records = this.ctx.integrations.surf
    if (!records) return this.reply(session, true, 'Surf records are unavailable.')
    const pb = await records.pbRun(mapId, session.subjectId ?? session.token)
    this.reply(
      session,
      parsed.silent,
      pb ? `Your PB on ${mapId}: ${formatChatTime(pb.timeMs)}` : `You have no PB on ${mapId} yet.`,
    )
  }

  /** One line to the room (`!`) or to the sender only (`/`). */
  private reply(session: PlayerSession, silent: boolean, text: string): void {
    const msg: ServerSay = { t: 'say', channel: 'system', text }
    if (silent) this.ctx.net.send(session, msg)
    else this.ctx.net.broadcastAll(msg)
  }

  private replyLines(session: PlayerSession, silent: boolean, lines: readonly string[]): void {
    for (const line of lines) this.reply(session, silent, line)
  }
}
