import { Pool } from "pg";
import { nanoid } from "nanoid";
import {
  EconDef,
  EconomyError,
  EconomyRepository,
  EconPlayerState,
  emptyLoadout,
  InventorySlot,
  MarketBrowseQuery,
  MarketListing,
  normalizeLoadout,
  TradeOffer,
  TradeOfferInput,
} from "./economy.js";

export class PgEconomyRepository implements EconomyRepository {
  constructor(private readonly pool: Pool) {}

  async upsertDefs(defs: EconDef[]): Promise<void> {
    const chunkSize = 200;
    for (let offset = 0; offset < defs.length; offset += chunkSize) {
      const chunk = defs.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const rows = chunk.map((def, index) => {
        const base = index * 5;
        values.push(def.defId, def.kind, def.displayName, def.icon, JSON.stringify(def.meta));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
      });
      await this.pool.query(
        `
        INSERT INTO econ_defs (def_id, kind, display_name, icon, meta)
        VALUES ${rows.join(", ")}
        ON CONFLICT (def_id)
        DO UPDATE SET kind = EXCLUDED.kind,
                      display_name = EXCLUDED.display_name,
                      icon = EXCLUDED.icon,
                      meta = EXCLUDED.meta,
                      updated_at = now()
        `,
        values,
      );
    }
  }

  async listDefs(): Promise<EconDef[]> {
    const result = await this.pool.query(
      `SELECT def_id, kind, display_name, icon, meta, enabled FROM econ_defs WHERE enabled`,
    );
    return result.rows.map(rowToDef);
  }

  async getDef(defId: string): Promise<EconDef | null> {
    const result = await this.pool.query(
      `SELECT def_id, kind, display_name, icon, meta, enabled FROM econ_defs WHERE def_id = $1`,
      [defId],
    );
    if (result.rowCount !== 1) return null;
    return rowToDef(result.rows[0]);
  }

  async playerExists(steamId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM players WHERE steam_id = $1`, [steamId]);
    return result.rowCount === 1;
  }

  async getPlayerCore(steamId: string): Promise<{ bucks: number; xp: number; displayName: string } | null> {
    const result = await this.pool.query(
      `SELECT display_name, currency_balance, xp FROM players WHERE steam_id = $1`,
      [steamId],
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return { displayName: row.display_name, bucks: row.currency_balance, xp: row.xp };
  }

  async addBucks(steamId: string, delta: number, reason: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const update = await client.query(
        `UPDATE players SET currency_balance = currency_balance + $2, updated_at = now()
         WHERE steam_id = $1
         RETURNING currency_balance`,
        [steamId, delta],
      );
      if (update.rowCount !== 1) throw new EconomyError("player_not_found", 404);
      await client.query(
        `INSERT INTO currency_ledger (steam_id, delta, reason, idempotency_key)
         VALUES ($1, $2, $3, $4)`,
        [steamId, delta, reason, `econ:${nanoid(16)}`],
      );
      await client.query("COMMIT");
      return update.rows[0].currency_balance;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23514") {
        throw new EconomyError("insufficient_bucks", 402);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async addXp(steamId: string, delta: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE players SET xp = GREATEST(0, xp + $2), updated_at = now()
       WHERE steam_id = $1
       RETURNING xp`,
      [steamId, delta],
    );
    if (result.rowCount !== 1) throw new EconomyError("player_not_found", 404);
    return result.rows[0].xp;
  }

  async getEconPlayer(steamId: string): Promise<EconPlayerState> {
    const result = await this.pool.query(
      `SELECT loadout, stats FROM econ_players WHERE steam_id = $1`,
      [steamId],
    );
    if (result.rowCount !== 1) return { loadout: emptyLoadout(), stats: {} };
    return {
      loadout: normalizeLoadout(result.rows[0].loadout),
      stats: (result.rows[0].stats ?? {}) as Record<string, number>,
    };
  }

  async setEconPlayer(steamId: string, state: EconPlayerState): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO econ_players (steam_id, loadout, stats)
      VALUES ($1, $2::jsonb, $3::jsonb)
      ON CONFLICT (steam_id)
      DO UPDATE SET loadout = EXCLUDED.loadout,
                    stats = EXCLUDED.stats,
                    updated_at = now()
      `,
      [steamId, JSON.stringify(state.loadout), JSON.stringify(state.stats)],
    );
  }

  async getInventory(steamId: string): Promise<InventorySlot[]> {
    const result = await this.pool.query(
      `SELECT slot, item_id FROM econ_inventory WHERE steam_id = $1 ORDER BY slot`,
      [steamId],
    );
    return result.rows.map((row) => ({ slot: row.slot, itemId: row.item_id }));
  }

  async applySlotOps(steamId: string, ops: Array<{ slot: number; itemId: string | null }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Clear all touched slots first so swaps/sorts never trip the PK.
      const touched = [...new Set(ops.map((op) => op.slot))];
      await client.query(`DELETE FROM econ_inventory WHERE steam_id = $1 AND slot = ANY($2::int[])`, [
        steamId,
        touched,
      ]);
      for (const op of ops) {
        if (op.itemId === null) continue;
        await client.query(
          `INSERT INTO econ_inventory (steam_id, slot, item_id) VALUES ($1, $2, $3)
           ON CONFLICT (steam_id, slot) DO UPDATE SET item_id = EXCLUDED.item_id`,
          [steamId, op.slot, op.itemId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCounter(key: string): Promise<Record<string, number>> {
    const result = await this.pool.query(`SELECT data FROM econ_counters WHERE counter_key = $1`, [key]);
    if (result.rowCount !== 1) return {};
    return result.rows[0].data as Record<string, number>;
  }

  async setCounter(key: string, data: Record<string, number>): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO econ_counters (counter_key, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (counter_key)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `,
      [key, JSON.stringify(data)],
    );
  }

  async createListing(sellerSteamId: string, itemId: string, price: number): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO market_listings (seller_steam_id, item_id, price)
       VALUES ($1, $2, $3)
       RETURNING listing_id`,
      [sellerSteamId, itemId, price],
    );
    return Number(result.rows[0].listing_id);
  }

  async getListing(listingId: number): Promise<MarketListing | null> {
    const result = await this.pool.query(
      `SELECT listing_id, seller_steam_id, item_id, price, status, sold_to, created_at
       FROM market_listings WHERE listing_id = $1`,
      [listingId],
    );
    if (result.rowCount !== 1) return null;
    return rowToListing(result.rows[0]);
  }

  async browseListings(query: MarketBrowseQuery): Promise<{ listings: MarketListing[]; total: number }> {
    const where = `
      l.status = 'open'
      AND ($1::text IS NULL OR l.item_id ILIKE '%' || $1 || '%' OR d.display_name ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR d.kind = $2)`;
    const orderBy = {
      newest: "l.created_at DESC, l.listing_id DESC",
      price_asc: "l.price ASC, l.listing_id ASC",
      price_desc: "l.price DESC, l.listing_id ASC",
    }[query.sort];
    const params = [query.q ?? null, query.kind ?? null];
    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS total
       FROM market_listings l JOIN econ_defs d ON d.def_id = l.item_id
       WHERE ${where}`,
      params,
    );
    const result = await this.pool.query(
      `SELECT l.listing_id, l.seller_steam_id, l.item_id, l.price, l.status, l.sold_to, l.created_at
       FROM market_listings l JOIN econ_defs d ON d.def_id = l.item_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $3 OFFSET $4`,
      [...params, query.limit, query.offset],
    );
    return { listings: result.rows.map(rowToListing), total: count.rows[0].total };
  }

  async listOpenListingsBySeller(steamId: string): Promise<MarketListing[]> {
    const result = await this.pool.query(
      `SELECT listing_id, seller_steam_id, item_id, price, status, sold_to, created_at
       FROM market_listings
       WHERE seller_steam_id = $1 AND status = 'open'
       ORDER BY created_at DESC, listing_id DESC`,
      [steamId],
    );
    return result.rows.map(rowToListing);
  }

  async resolveListing(listingId: number, status: "sold" | "cancelled", soldTo: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE market_listings
       SET status = $2, sold_to = $3, resolved_at = now()
       WHERE listing_id = $1 AND status = 'open'`,
      [listingId, status, soldTo],
    );
    return result.rowCount === 1;
  }

  async createTrade(trade: TradeOfferInput): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO trade_offers
         (from_steam_id, to_steam_id, offer_item_ids, offer_bucks, request_item_ids, request_bucks, message)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
       RETURNING trade_id`,
      [
        trade.fromSteamId,
        trade.toSteamId,
        JSON.stringify(trade.offerItemIds),
        trade.offerBucks,
        JSON.stringify(trade.requestItemIds),
        trade.requestBucks,
        trade.message,
      ],
    );
    return Number(result.rows[0].trade_id);
  }

  async getTrade(tradeId: number): Promise<TradeOffer | null> {
    const result = await this.pool.query(`SELECT * FROM trade_offers WHERE trade_id = $1`, [tradeId]);
    if (result.rowCount !== 1) return null;
    return rowToTrade(result.rows[0]);
  }

  async listOpenTrades(steamId: string): Promise<{ incoming: TradeOffer[]; outgoing: TradeOffer[] }> {
    const result = await this.pool.query(
      `SELECT * FROM trade_offers
       WHERE status = 'open' AND (to_steam_id = $1 OR from_steam_id = $1)
       ORDER BY trade_id DESC`,
      [steamId],
    );
    const trades = result.rows.map(rowToTrade);
    return {
      incoming: trades.filter((trade) => trade.toSteamId === steamId),
      outgoing: trades.filter((trade) => trade.fromSteamId === steamId),
    };
  }

  async countOpenOutgoingTrades(steamId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM trade_offers WHERE from_steam_id = $1 AND status = 'open'`,
      [steamId],
    );
    return result.rows[0].total;
  }

  async resolveTrade(tradeId: number, status: "accepted" | "declined" | "cancelled"): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE trade_offers
       SET status = $2, resolved_at = now()
       WHERE trade_id = $1 AND status = 'open'`,
      [tradeId, status],
    );
    return result.rowCount === 1;
  }

  async validateServerSecret(serverId: string, serverSecret: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM game_servers WHERE server_id = $1 AND server_secret = $2`,
      [serverId, serverSecret],
    );
    return result.rowCount === 1;
  }
}

function isoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToListing(row: {
  listing_id: string | number;
  seller_steam_id: string | number;
  item_id: string;
  price: number;
  status: string;
  sold_to: string | number | null;
  created_at: Date | string;
}): MarketListing {
  return {
    listingId: Number(row.listing_id),
    sellerSteamId: String(row.seller_steam_id),
    itemId: row.item_id,
    price: row.price,
    status: row.status as MarketListing["status"],
    soldTo: row.sold_to == null ? null : String(row.sold_to),
    createdAt: isoTimestamp(row.created_at),
  };
}

function rowToTrade(row: {
  trade_id: string | number;
  from_steam_id: string | number;
  to_steam_id: string | number;
  offer_item_ids: unknown;
  offer_bucks: number;
  request_item_ids: unknown;
  request_bucks: number;
  message: string;
  status: string;
  created_at: Date | string;
}): TradeOffer {
  return {
    tradeId: Number(row.trade_id),
    fromSteamId: String(row.from_steam_id),
    toSteamId: String(row.to_steam_id),
    offerItemIds: (row.offer_item_ids as string[] | null) ?? [],
    offerBucks: row.offer_bucks,
    requestItemIds: (row.request_item_ids as string[] | null) ?? [],
    requestBucks: row.request_bucks,
    message: row.message,
    status: row.status as TradeOffer["status"],
    createdAt: isoTimestamp(row.created_at),
  };
}

function rowToDef(row: {
  def_id: string;
  kind: string;
  display_name: string;
  icon: string;
  meta: Record<string, unknown>;
  enabled: boolean;
}): EconDef {
  return {
    defId: row.def_id,
    kind: row.kind as EconDef["kind"],
    displayName: row.display_name,
    icon: row.icon,
    meta: row.meta ?? {},
    enabled: row.enabled,
  };
}
