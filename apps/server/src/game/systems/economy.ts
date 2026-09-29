import { REP_DELTAS, addReputation, stanceToward } from '@openvibe/gameplay'
import type {
  ClientJobAccept,
  ClientJobTurnIn,
  ClientMarketBuy,
  ClientMarketOpen,
  ClientMarketSell,
} from '@openvibe/protocol'
import type { EntityId } from '@openvibe/shared'
import type { PlayerSession } from '../playerSession.js'
import type { ServerContext } from './context.js'
import type { HandlerMap, System } from './system.js'

export class EconomySystem implements System {
  readonly name = 'economy'

  readonly handlers: HandlerMap = {
    market_open: (session, msg: ClientMarketOpen, _conn) => this.handleMarket(session, msg),
    market_buy: (session, msg: ClientMarketBuy, _conn) => this.handleMarket(session, msg),
    market_sell: (session, msg: ClientMarketSell, _conn) => this.handleMarket(session, msg),
    job_accept: (session, msg: ClientJobAccept, _conn) => this.handleJob(session, msg),
    job_turnin: (session, msg: ClientJobTurnIn, _conn) => this.handleJob(session, msg),
  }

  constructor(private readonly ctx: ServerContext) {}

  /** Live sell-stock per market: item -> remaining + next restock time. */
  private readonly marketStock = new Map<string, Map<string, { stock: number; at: number }>>()

  /**
   * Reads the persisted market blobs. main.ts awaits this before starting the tick loop
   * (alongside the rest of the boot load).
   */
  async load(): Promise<void> {
    for (const { key, value } of await this.ctx.store.meta.list('market_')) {
      const market = new Map<string, { stock: number; at: number }>()
      if (value && typeof value === 'object') {
        for (const [item, state] of Object.entries(
          value as Record<string, { stock: number; at: number }>,
        )) {
          market.set(item, state)
        }
      }
      this.marketStock.set(key.slice('market_'.length), market)
    }
  }

  /** The market blobs a checkpoint rides along with (one `market_<id>` per live market). */
  marketMeta(): Record<string, unknown> {
    const meta: Record<string, unknown> = {}
    for (const [id, market] of this.marketStock) meta[`market_${id}`] = Object.fromEntries(market)
    return meta
  }

  /** Lazily restocked stock entry for one market sell line. */
  private stockOf(
    marketId: string,
    entry: { item: string; stock: number; restockSeconds: number },
    nowMs: number,
  ): { stock: number; at: number } {
    let market = this.marketStock.get(marketId)
    if (!market) {
      // Persisted market blobs are loaded at boot (GameServer.load); an unknown market starts fresh.
      market = new Map()
      this.marketStock.set(marketId, market)
    }
    let state = market.get(entry.item)
    if (!state) {
      state = { stock: entry.stock, at: nowMs + entry.restockSeconds * 1000 }
      market.set(entry.item, state)
    }
    if (nowMs >= state.at) {
      state.stock = entry.stock
      state.at = nowMs + entry.restockSeconds * 1000
    }
    return state
  }

  /**
   * Market interactions: open/buy/sell against the market a shop prop
   * references. Everything server-atomic: proximity, faction stance,
   * live stock, coins and space all validated here.
   */
  private handleMarket(
    session: PlayerSession,
    msg: ClientMarketOpen | ClientMarketBuy | ClientMarketSell,
  ): void {
    const deny = (error: string) =>
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: false, error })
    const entity = this.ctx.world.entities.get(msg.target as EntityId)
    const marketId = entity?.prop
      ? this.ctx.world.content.item(entity.prop.defId)?.shop?.market
      : undefined
    const market = marketId ? this.ctx.world.content.market(marketId) : undefined
    if (!entity || !market) return deny('no_merchant')
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 5) return deny('out_of_range')
    const faction = this.ctx.world.content.faction(market.faction)
    const stance = faction ? stanceToward(faction, session.reputation) : 'neutral'
    if (stance === 'hostile') return deny('they_hate_you')
    const nowMs = Date.now()

    if (msg.t === 'market_buy' && msg.item) {
      const entry = market.sells.find((s) => s.item === msg.item)
      if (!entry) return deny('no_such_trade')
      const state = this.stockOf(market.id, entry, nowMs)
      if (state.stock <= 0) return deny('out_of_stock')
      if (session.inventory.countOf('coin') < entry.price) return deny('missing_coins')
      if (!session.inventory.canFit(entry.item, entry.count)) return deny('inventory_full')
      const paid = session.inventory.consume([{ item: 'coin', count: entry.price }])
      if (!paid.ok) return deny('missing_coins')
      session.inventory.add(entry.item, entry.count)
      state.stock -= 1
      addReputation(session.reputation, market.faction, REP_DELTAS.trade)
      session.dirty = true
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: true })
      this.ctx.net.sendInventory(session)
      this.sendReputation(session)
    } else if (msg.t === 'market_sell' && msg.item) {
      const entry = market.buys.find((b) => b.item === msg.item)
      if (!entry) return deny('no_such_trade')
      if (session.inventory.countOf(entry.item) < entry.count) return deny('missing_items')
      if (!session.inventory.canFit('coin', entry.price)) return deny('inventory_full')
      const taken = session.inventory.consume([{ item: entry.item, count: entry.count }])
      if (!taken.ok) return deny('missing_items')
      session.inventory.add('coin', entry.price)
      addReputation(session.reputation, market.faction, REP_DELTAS.trade)
      session.dirty = true
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: true })
      this.ctx.net.sendInventory(session)
      this.sendReputation(session)
    }
    // Every path (including plain open) refreshes the market + contracts.
    this.sendJobs(session, market.id)
    this.ctx.net.send(session, {
      t: 'market',
      id: market.id,
      name: market.name,
      stance,
      sells: market.sells.map((s) => ({
        item: s.item,
        count: s.count,
        price: s.price,
        stock: this.stockOf(market.id, s, nowMs).stock,
      })),
      buys: market.buys.map((b) => ({ item: b.item, count: b.count, price: b.price })),
    })
  }

  /** Contract accept/turn-in at a trading post. */
  private handleJob(session: PlayerSession, msg: ClientJobAccept | ClientJobTurnIn): void {
    const deny = (error: string) =>
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: false, error })
    const entity = this.ctx.world.entities.get(msg.target as EntityId)
    const marketId = entity?.prop
      ? this.ctx.world.content.item(entity.prop.defId)?.shop?.market
      : undefined
    if (!entity || !marketId) return deny('no_merchant')
    const d = Math.hypot(
      entity.transform.pos.x - session.move.pos.x,
      entity.transform.pos.z - session.move.pos.z,
    )
    if (d > 5) return deny('out_of_range')

    if (msg.t === 'job_accept' && msg.job) {
      const job = this.ctx.world.content.job(msg.job)
      if (!job || job.market !== marketId) return deny('no_such_job')
      if (session.activeJob) return deny('job_in_progress')
      session.activeJob = { job: job.id, progress: 0 }
      session.dirty = true
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: true })
      this.ctx.net.send(session, { t: 'announce', text: `📋 Contract accepted: ${job.name}` })
    } else if (msg.t === 'job_turnin') {
      const job = session.activeJob ? this.ctx.world.content.job(session.activeJob.job) : undefined
      if (!session.activeJob || !job) return deny('no_active_job')
      if (job.market !== marketId) return deny('wrong_merchant')
      if (job.objective.kind === 'deliver') {
        const need = { item: job.objective.item, count: job.objective.count }
        if (session.inventory.countOf(need.item) < need.count) return deny('missing_items')
        const taken = session.inventory.consume([need])
        if (!taken.ok) return deny('missing_items')
      } else if (session.activeJob.progress < job.objective.count) {
        return deny('not_finished')
      }
      // Rewards: coins, reputation, items, XP — all atomic-enough (coins
      // and items overflow to the floor is prevented by canFit pre-check).
      if (job.reward.coins > 0 && !session.inventory.canFit('coin', job.reward.coins)) {
        return deny('inventory_full')
      }
      if (job.reward.coins > 0) session.inventory.add('coin', job.reward.coins)
      for (const it of job.reward.items) session.inventory.add(it.item, it.count)
      const market = this.ctx.world.content.market(marketId)
      if (job.reward.reputation !== 0 && market) {
        addReputation(session.reputation, market.faction, job.reward.reputation)
        this.sendReputation(session)
      }
      if (job.reward.xp) {
        const ups = session.skills.addXp(job.reward.xp.skill, job.reward.xp.amount)
        for (const up of ups)
          this.ctx.net.send(session, { t: 'levelup', skill: up.skill, level: up.level })
        this.ctx.net.sendSkills(session)
      }
      session.activeJob = null
      session.dirty = true
      this.ctx.net.send(session, { t: 'result', action: 'trade', ok: true })
      this.ctx.net.send(session, { t: 'announce', text: `✅ Contract complete: ${job.name}` })
      this.ctx.net.sendInventory(session)
    }
    this.sendJobs(session, marketId)
  }

  sendJobs(session: PlayerSession, marketId: string): void {
    const active = session.activeJob
      ? (() => {
          const job = this.ctx.world.content.job(session.activeJob!.job)
          if (!job) return null
          const goal = job.objective.count
          const progress =
            job.objective.kind === 'deliver'
              ? Math.min(goal, session.inventory.countOf(job.objective.item))
              : session.activeJob!.progress
          return {
            job: job.id,
            name: job.name,
            progress,
            goal,
            ready: progress >= goal,
          }
        })()
      : null
    this.ctx.net.send(session, {
      t: 'jobs',
      market: marketId,
      available: this.ctx.world.content.jobsForMarket(marketId).map((j) => ({
        id: j.id,
        name: j.name,
        description: j.description,
        done: false,
      })),
      active,
    })
  }

  sendReputation(session: PlayerSession): void {
    this.ctx.net.send(session, {
      t: 'reputation',
      factions: this.ctx.world.content.allFactions().map((f) => ({
        id: f.id,
        name: f.name,
        value: Math.round(session.reputation[f.id] ?? 0),
        stance: stanceToward(f, session.reputation),
      })),
    })
  }
}
