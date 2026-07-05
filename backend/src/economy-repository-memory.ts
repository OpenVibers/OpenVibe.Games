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

interface MemoryPlayer {
  displayName: string;
  bucks: number;
  xp: number;
}

/** In-memory economy repository — tests and offline dev. */
export class MemoryEconomyRepository implements EconomyRepository {
  private defs = new Map<string, EconDef>();
  private players = new Map<string, MemoryPlayer>();
  private econPlayers = new Map<string, EconPlayerState>();
  private inventories = new Map<string, Map<number, string>>();
  private counters = new Map<string, Record<string, number>>();
  private servers = new Map<string, string>();
  private listings = new Map<number, MarketListing>();
  private nextListingId = 1;
  private trades = new Map<number, TradeOffer>();
  private nextTradeId = 1;

  upsertPlayer(steamId: string, player: Partial<MemoryPlayer> = {}): void {
    const existing = this.players.get(steamId) ?? { displayName: `Player ${steamId}`, bucks: 50, xp: 0 };
    this.players.set(steamId, { ...existing, ...player });
  }

  registerServer(serverId: string, secret: string): void {
    this.servers.set(serverId, secret);
  }

  async upsertDefs(defs: EconDef[]): Promise<void> {
    for (const def of defs) this.defs.set(def.defId, def);
  }

  async listDefs(): Promise<EconDef[]> {
    return [...this.defs.values()].filter((def) => def.enabled);
  }

  async getDef(defId: string): Promise<EconDef | null> {
    return this.defs.get(defId) ?? null;
  }

  async playerExists(steamId: string): Promise<boolean> {
    return this.players.has(steamId);
  }

  async getPlayerCore(steamId: string): Promise<{ bucks: number; xp: number; displayName: string } | null> {
    const player = this.players.get(steamId);
    if (!player) return null;
    return { bucks: player.bucks, xp: player.xp, displayName: player.displayName };
  }

  async addBucks(steamId: string, delta: number): Promise<number> {
    const player = this.players.get(steamId);
    if (!player) throw new EconomyError("player_not_found", 404);
    if (player.bucks + delta < 0) throw new EconomyError("insufficient_bucks", 402);
    player.bucks += delta;
    return player.bucks;
  }

  async addXp(steamId: string, delta: number): Promise<number> {
    const player = this.players.get(steamId);
    if (!player) throw new EconomyError("player_not_found", 404);
    player.xp = Math.max(0, player.xp + delta);
    return player.xp;
  }

  async getEconPlayer(steamId: string): Promise<EconPlayerState> {
    const state = this.econPlayers.get(steamId) ?? { loadout: emptyLoadout(), stats: {} };
    return {
      loadout: normalizeLoadout(JSON.parse(JSON.stringify(state.loadout))),
      stats: { ...state.stats },
    };
  }

  async setEconPlayer(steamId: string, state: EconPlayerState): Promise<void> {
    this.econPlayers.set(steamId, {
      loadout: JSON.parse(JSON.stringify(state.loadout)),
      stats: { ...state.stats },
    });
  }

  async getInventory(steamId: string): Promise<InventorySlot[]> {
    const inventory = this.inventories.get(steamId);
    if (!inventory) return [];
    return [...inventory.entries()]
      .map(([slot, itemId]) => ({ slot, itemId }))
      .sort((a, b) => a.slot - b.slot);
  }

  async applySlotOps(steamId: string, ops: Array<{ slot: number; itemId: string | null }>): Promise<void> {
    let inventory = this.inventories.get(steamId);
    if (!inventory) {
      inventory = new Map();
      this.inventories.set(steamId, inventory);
    }
    for (const op of ops) {
      if (op.itemId === null) inventory.delete(op.slot);
      else inventory.set(op.slot, op.itemId);
    }
  }

  async getCounter(key: string): Promise<Record<string, number>> {
    return { ...(this.counters.get(key) ?? {}) };
  }

  async setCounter(key: string, data: Record<string, number>): Promise<void> {
    this.counters.set(key, { ...data });
  }

  async createListing(sellerSteamId: string, itemId: string, price: number): Promise<number> {
    const listingId = this.nextListingId++;
    this.listings.set(listingId, {
      listingId,
      sellerSteamId,
      itemId,
      price,
      status: "open",
      soldTo: null,
      createdAt: new Date().toISOString(),
    });
    return listingId;
  }

  async getListing(listingId: number): Promise<MarketListing | null> {
    const listing = this.listings.get(listingId);
    return listing ? { ...listing } : null;
  }

  async browseListings(query: MarketBrowseQuery): Promise<{ listings: MarketListing[]; total: number }> {
    let open = [...this.listings.values()].filter((listing) => listing.status === "open");
    if (query.q) {
      const needle = query.q.toLowerCase();
      open = open.filter((listing) => {
        const name = this.defs.get(listing.itemId)?.displayName ?? "";
        return listing.itemId.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
      });
    }
    if (query.kind) open = open.filter((listing) => this.defs.get(listing.itemId)?.kind === query.kind);
    switch (query.sort) {
      case "price_asc":
        open.sort((a, b) => a.price - b.price || a.listingId - b.listingId);
        break;
      case "price_desc":
        open.sort((a, b) => b.price - a.price || a.listingId - b.listingId);
        break;
      default:
        // newest: created_at DESC, listing_id DESC — ids are insertion-ordered.
        open.sort((a, b) => b.listingId - a.listingId);
    }
    return {
      listings: open.slice(query.offset, query.offset + query.limit).map((listing) => ({ ...listing })),
      total: open.length,
    };
  }

  async listOpenListingsBySeller(steamId: string): Promise<MarketListing[]> {
    return [...this.listings.values()]
      .filter((listing) => listing.status === "open" && listing.sellerSteamId === steamId)
      .sort((a, b) => b.listingId - a.listingId)
      .map((listing) => ({ ...listing }));
  }

  async resolveListing(listingId: number, status: "sold" | "cancelled", soldTo: string | null): Promise<boolean> {
    const listing = this.listings.get(listingId);
    if (!listing || listing.status !== "open") return false;
    listing.status = status;
    listing.soldTo = soldTo;
    return true;
  }

  async createTrade(trade: TradeOfferInput): Promise<number> {
    const tradeId = this.nextTradeId++;
    this.trades.set(tradeId, {
      tradeId,
      fromSteamId: trade.fromSteamId,
      toSteamId: trade.toSteamId,
      offerItemIds: [...trade.offerItemIds],
      offerBucks: trade.offerBucks,
      requestItemIds: [...trade.requestItemIds],
      requestBucks: trade.requestBucks,
      message: trade.message,
      status: "open",
      createdAt: new Date().toISOString(),
    });
    return tradeId;
  }

  async getTrade(tradeId: number): Promise<TradeOffer | null> {
    const trade = this.trades.get(tradeId);
    return trade ? { ...trade, offerItemIds: [...trade.offerItemIds], requestItemIds: [...trade.requestItemIds] } : null;
  }

  async listOpenTrades(steamId: string): Promise<{ incoming: TradeOffer[]; outgoing: TradeOffer[] }> {
    const open = [...this.trades.values()]
      .filter((trade) => trade.status === "open")
      .sort((a, b) => b.tradeId - a.tradeId)
      .map((trade) => ({ ...trade, offerItemIds: [...trade.offerItemIds], requestItemIds: [...trade.requestItemIds] }));
    return {
      incoming: open.filter((trade) => trade.toSteamId === steamId),
      outgoing: open.filter((trade) => trade.fromSteamId === steamId),
    };
  }

  async countOpenOutgoingTrades(steamId: string): Promise<number> {
    return [...this.trades.values()].filter((trade) => trade.status === "open" && trade.fromSteamId === steamId).length;
  }

  async resolveTrade(tradeId: number, status: "accepted" | "declined" | "cancelled"): Promise<boolean> {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.status !== "open") return false;
    trade.status = status;
    return true;
  }

  async validateServerSecret(serverId: string, serverSecret: string): Promise<boolean> {
    return this.servers.get(serverId) === serverSecret;
  }
}
