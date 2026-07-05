// Devolved economy — items, drag-and-drop inventory, crates/keys, crafting,
// redeem/loadout. Ported from devolvedttt (GMod Lua); mechanics kept faithful:
//   - inventory is a flat ordered list of item-id strings (no stacking; "stacks"
//     are distinct item types, exactly like the original),
//   - crate roll: visit drop entries in random order, win on
//     random(1, chance+2) == chance, else fall back to the least-chance entry
//     (random among ties); non-limited crates gain a bonus
//     "item_50 Scratch Cards" entry at chance 12,
//   - level-up threshold: xp >= 900 * (lvl * 0.8), xp is per-level.
// Def id conventions (devolved inventory ids preserved):
//   item_<Name>, crate_<Name>, bare <Name> for rares; non-inventory registries
//   use "<kind>:<Name>" (cade:, perma:, tier:, recipe:, ...).

export type EconKind =
  | "item"
  | "crate"
  | "rare"
  | "cade"
  | "perma"
  | "tier"
  | "roundbuy"
  | "specwep"
  | "taunt"
  | "mat"
  | "recipe"
  | "quest";

export interface EconDef {
  defId: string;
  kind: EconKind;
  displayName: string;
  icon: string;
  meta: Record<string, unknown>;
  enabled: boolean;
}

export interface InventorySlot {
  slot: number;
  itemId: string;
}

export type RareType = "cade" | "mat" | "specwep" | "jihadsound" | "taunt" | "wep" | "wepskin";

export interface Loadout {
  cades: Record<string, boolean>;
  mats: Record<string, string>;
  specweps: Record<string, boolean>;
  jihads: Record<string, string>;
  taunts: Record<string, boolean>;
  wepskins: Record<string, string>;
  weps: Record<string, { class: string; slot: number | null; equipped: boolean; mat?: string; bought?: boolean }>;
  permas: Record<string, boolean>;
  tiers: Record<string, boolean>;
  recipes: Record<string, boolean>;
  crosshairs: Record<string, boolean>;
  equipped: Record<string, string>;
  xp2xUntil: number;
}

export function emptyLoadout(): Loadout {
  return {
    cades: {},
    mats: {},
    specweps: {},
    jihads: {},
    taunts: {},
    wepskins: {},
    weps: {},
    permas: {},
    tiers: {},
    recipes: {},
    crosshairs: {},
    equipped: {},
    xp2xUntil: 0,
  };
}

export function normalizeLoadout(raw: unknown): Loadout {
  const base = emptyLoadout();
  if (raw && typeof raw === "object") Object.assign(base, raw as Partial<Loadout>);
  return base;
}

// XPCheck (player_data.lua:416): per-level xp, threshold 900*(lvl*0.8).
export function levelFromXp(xp: number): { lvl: number; xpInLevel: number; xpNext: number } {
  let lvl = 1;
  let rest = Math.max(0, xp);
  while (rest >= 900 * (lvl * 0.8)) {
    rest -= 900 * (lvl * 0.8);
    lvl += 1;
  }
  return { lvl, xpInLevel: Math.floor(rest), xpNext: Math.floor(900 * (lvl * 0.8)) };
}

export interface EconPlayerState {
  loadout: Loadout;
  stats: Record<string, number>;
}

// Trading & market (docs/ECONOMY_TRADE_MARKET_API.md).

export type MarketSort = "newest" | "price_asc" | "price_desc";
export type ListingStatus = "open" | "sold" | "cancelled";
export type TradeStatus = "open" | "accepted" | "declined" | "cancelled";

export interface MarketListing {
  listingId: number;
  sellerSteamId: string;
  itemId: string;
  price: number;
  status: ListingStatus;
  soldTo: string | null;
  createdAt: string;
}

export interface MarketBrowseQuery {
  q?: string;
  kind?: EconKind;
  sort: MarketSort;
  offset: number;
  limit: number;
}

export interface MarketListingView {
  listingId: number;
  sellerSteamId: string;
  sellerName: string;
  itemId: string;
  price: number;
  createdAt: string;
}

export interface TradeOffer {
  tradeId: number;
  fromSteamId: string;
  toSteamId: string;
  offerItemIds: string[];
  offerBucks: number;
  requestItemIds: string[];
  requestBucks: number;
  message: string;
  status: TradeStatus;
  createdAt: string;
}

export type TradeOfferInput = Omit<TradeOffer, "tradeId" | "status" | "createdAt">;

export interface TradeOfferView {
  tradeId: number;
  fromSteamId: string;
  fromName: string;
  toSteamId: string;
  toName: string;
  offerItemIds: string[];
  offerBucks: number;
  requestItemIds: string[];
  requestBucks: number;
  message: string;
  createdAt: string;
}

export interface EconomyRepository {
  upsertDefs(defs: EconDef[]): Promise<void>;
  listDefs(): Promise<EconDef[]>;
  getDef(defId: string): Promise<EconDef | null>;

  playerExists(steamId: string): Promise<boolean>;
  getPlayerCore(steamId: string): Promise<{ bucks: number; xp: number; displayName: string } | null>;
  addBucks(steamId: string, delta: number, reason: string): Promise<number>;
  addXp(steamId: string, delta: number): Promise<number>;

  getEconPlayer(steamId: string): Promise<EconPlayerState>;
  setEconPlayer(steamId: string, state: EconPlayerState): Promise<void>;

  getInventory(steamId: string): Promise<InventorySlot[]>;
  /** Atomic batch: itemId null clears a slot. */
  applySlotOps(steamId: string, ops: Array<{ slot: number; itemId: string | null }>): Promise<void>;

  getCounter(key: string): Promise<Record<string, number>>;
  setCounter(key: string, data: Record<string, number>): Promise<void>;

  // Market listings.
  createListing(sellerSteamId: string, itemId: string, price: number): Promise<number>;
  getListing(listingId: number): Promise<MarketListing | null>;
  browseListings(query: MarketBrowseQuery): Promise<{ listings: MarketListing[]; total: number }>;
  listOpenListingsBySeller(steamId: string): Promise<MarketListing[]>;
  /** Compare-and-set open → status; false when the listing was no longer open. */
  resolveListing(listingId: number, status: "sold" | "cancelled", soldTo: string | null): Promise<boolean>;

  // Trade offers.
  createTrade(trade: TradeOfferInput): Promise<number>;
  getTrade(tradeId: number): Promise<TradeOffer | null>;
  listOpenTrades(steamId: string): Promise<{ incoming: TradeOffer[]; outgoing: TradeOffer[] }>;
  countOpenOutgoingTrades(steamId: string): Promise<number>;
  /** Compare-and-set open → status; false when the offer was no longer open. */
  resolveTrade(tradeId: number, status: "accepted" | "declined" | "cancelled"): Promise<boolean>;

  /** True when serverId/serverSecret match a registered game_servers row. */
  validateServerSecret(serverId: string, serverSecret: string): Promise<boolean>;
}

export class EconomyError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(code);
  }
}

export interface EconomyStateView {
  player: { steamId: string; displayName: string; bucks: number; xp: number; lvl: number; xpInLevel: number; xpNext: number };
  inventory: InventorySlot[];
  loadout: Loadout;
  stats: Record<string, number>;
}

const MAX_SLOTS = 200;
const LIMITED_ITEMS_KEY = "limited_items";
const LIMITED_CRAFTED_KEY = "limited_crafted";

export type Rng = (minInclusive: number, maxInclusive: number) => number;

const defaultRng: Rng = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const MAX_OPEN_OUTGOING_TRADES = 10;

/** Numeric order for decimal steamId strings (shorter = smaller, then lexicographic). */
function steamIdOrder(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pick one inventory slot per requested itemId (multiset semantics: offering
 * two "Beer" needs two owned). Null when not all are owned.
 */
function pickSlotsFor(inventory: InventorySlot[], itemIds: string[]): number[] | null {
  const pool = [...inventory];
  const slots: number[] = [];
  for (const itemId of itemIds) {
    const index = pool.findIndex((entry) => entry.itemId === itemId);
    if (index === -1) return null;
    slots.push(pool[index].slot);
    pool.splice(index, 1);
  }
  return slots;
}

export class EconomyService {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: EconomyRepository,
    private readonly rng: Rng = defaultRng,
  ) {}

  /** Serialize mutations per player (single-instance backend). */
  private async withLock<T>(steamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(steamId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(steamId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(steamId) === next) this.locks.delete(steamId);
    }
  }

  async listDefs(): Promise<EconDef[]> {
    return this.repo.listDefs();
  }

  async getState(steamId: string): Promise<EconomyStateView> {
    const core = await this.repo.getPlayerCore(steamId);
    if (!core) throw new EconomyError("player_not_found", 404);
    const econ = await this.repo.getEconPlayer(steamId);
    const inventory = await this.repo.getInventory(steamId);
    const lvlInfo = levelFromXp(core.xp);
    return {
      player: { steamId, displayName: core.displayName, bucks: core.bucks, xp: core.xp, ...lvlInfo },
      inventory,
      loadout: econ.loadout,
      stats: econ.stats,
    };
  }

  private async requireDef(defId: string): Promise<EconDef> {
    const def = await this.repo.getDef(defId);
    if (!def || !def.enabled) throw new EconomyError("unknown_item", 404);
    return def;
  }

  private async requireSlot(steamId: string, slot: number): Promise<InventorySlot> {
    const inventory = await this.repo.getInventory(steamId);
    const found = inventory.find((entry) => entry.slot === slot);
    if (!found) throw new EconomyError("empty_slot", 404);
    return found;
  }

  private firstFreeSlots(inventory: InventorySlot[], count: number): number[] {
    const used = new Set(inventory.map((entry) => entry.slot));
    const free: number[] = [];
    for (let slot = 0; slot < MAX_SLOTS && free.length < count; slot++) {
      if (!used.has(slot)) free.push(slot);
    }
    if (free.length < count) throw new EconomyError("inventory_full", 409);
    return free;
  }

  async grantItems(steamId: string, itemIds: string[]): Promise<InventorySlot[]> {
    return this.withLock(steamId, async () => {
      for (const itemId of itemIds) await this.requireDef(itemId);
      const inventory = await this.repo.getInventory(steamId);
      const slots = this.firstFreeSlots(inventory, itemIds.length);
      await this.repo.applySlotOps(
        steamId,
        itemIds.map((itemId, index) => ({ slot: slots[index], itemId })),
      );
      return this.repo.getInventory(steamId);
    });
  }

  // Dev_Inv_Move: swap/move between two slots.
  async moveItem(steamId: string, from: number, to: number): Promise<InventorySlot[]> {
    if (from === to || from < 0 || to < 0 || from >= MAX_SLOTS || to >= MAX_SLOTS) {
      throw new EconomyError("bad_slot");
    }
    return this.withLock(steamId, async () => {
      const inventory = await this.repo.getInventory(steamId);
      const src = inventory.find((entry) => entry.slot === from);
      if (!src) throw new EconomyError("empty_slot", 404);
      const dst = inventory.find((entry) => entry.slot === to);
      const ops: Array<{ slot: number; itemId: string | null }> = [
        { slot: from, itemId: dst ? dst.itemId : null },
        { slot: to, itemId: src.itemId },
      ];
      await this.repo.applySlotOps(steamId, ops);
      return this.repo.getInventory(steamId);
    });
  }

  // Dev_SortInv modes.
  async sortInventory(steamId: string, mode: string): Promise<InventorySlot[]> {
    return this.withLock(steamId, async () => {
      const inventory = await this.repo.getInventory(steamId);
      const defs = new Map((await this.repo.listDefs()).map((def) => [def.defId, def]));
      const kindOf = (id: string) => defs.get(id)?.kind ?? "item";
      const nameOf = (id: string) => defs.get(id)?.displayName ?? id;
      const items = inventory.map((entry) => entry.itemId);
      const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b));
      switch (mode) {
        case "asc":
          items.sort(byName);
          break;
        case "desc":
          items.sort((a, b) => byName(b, a));
          break;
        case "crate_top":
          items.sort((a, b) => Number(kindOf(b) === "crate") - Number(kindOf(a) === "crate") || byName(a, b));
          break;
        case "crate_bot":
          items.sort((a, b) => Number(kindOf(a) === "crate") - Number(kindOf(b) === "crate") || byName(a, b));
          break;
        case "type_asc":
          items.sort((a, b) => kindOf(a).localeCompare(kindOf(b)) || byName(a, b));
          break;
        case "type_desc":
          items.sort((a, b) => kindOf(b).localeCompare(kindOf(a)) || byName(a, b));
          break;
        default:
          throw new EconomyError("bad_sort_mode");
      }
      const ops: Array<{ slot: number; itemId: string | null }> = [];
      for (const entry of inventory) ops.push({ slot: entry.slot, itemId: null });
      items.forEach((itemId, index) => ops.push({ slot: index, itemId }));
      await this.repo.applySlotOps(steamId, ops);
      return this.repo.getInventory(steamId);
    });
  }

  // Dev_Inv_Use — the menu-portable subset of item "use" effects.
  async useItem(steamId: string, slot: number): Promise<{ effect: string; state: EconomyStateView }> {
    return this.withLock(steamId, async () => {
      const entry = await this.requireSlot(steamId, slot);
      const def = await this.requireDef(entry.itemId);
      if (def.kind !== "item") throw new EconomyError("not_usable");
      const name = def.displayName;
      const econ = await this.repo.getEconPlayer(steamId);
      let effect: string | null = null;

      if (name.startsWith("Recipe: ")) {
        const recipe = name.slice("Recipe: ".length);
        econ.loadout.recipes[recipe] = true;
        effect = `recipe_unlocked:${recipe}`;
      } else if (name.startsWith("Crosshair: ")) {
        const crosshair = name.slice("Crosshair: ".length);
        econ.loadout.crosshairs[crosshair] = true;
        effect = `crosshair_unlocked:${crosshair}`;
      } else if (name.startsWith("Perma ")) {
        const perma = name.slice("Perma ".length);
        econ.loadout.permas[perma] = true;
        effect = `perma_unlocked:${perma}`;
      } else if (name === "Double XP 12 Hour") {
        const now = Math.floor(Date.now() / 1000);
        econ.loadout.xp2xUntil = Math.max(econ.loadout.xp2xUntil, now) + 12 * 3600;
        effect = "double_xp_12h";
      }

      if (!effect) throw new EconomyError("use_not_available_in_menu");
      const notake = Boolean(def.meta.notake);
      if (!notake) await this.repo.applySlotOps(steamId, [{ slot, itemId: null }]);
      await this.repo.setEconPlayer(steamId, econ);
      return { effect, state: await this.getState(steamId) };
    });
  }

  // Dev.RedeemItem — move a rare out of the inventory into the equipped collections.
  async redeemItem(steamId: string, slot: number): Promise<EconomyStateView> {
    return this.withLock(steamId, async () => {
      const entry = await this.requireSlot(steamId, slot);
      const def = await this.requireDef(entry.itemId);
      if (def.kind !== "rare") throw new EconomyError("not_redeemable");
      const rareType = String(def.meta.type ?? "") as RareType;
      const rawVar = def.meta.var;
      const vars = Array.isArray(rawVar) ? rawVar.map(String) : [String(rawVar ?? def.displayName)];
      const econ = await this.repo.getEconPlayer(steamId);
      const loadout = econ.loadout;

      switch (rareType) {
        case "cade":
          for (const cade of vars) loadout.cades[cade] = true;
          break;
        case "mat":
          loadout.mats[def.displayName] = vars[0];
          break;
        case "specwep":
          loadout.specweps[vars[0]] = true;
          break;
        case "jihadsound":
          loadout.jihads[def.displayName] = vars[0];
          break;
        case "taunt":
          loadout.taunts[vars[0]] = true;
          break;
        case "wep": {
          const permaName = vars[0];
          if (loadout.weps[permaName]) throw new EconomyError("already_owned", 409);
          const perma = await this.repo.getDef(`perma:${permaName}`);
          const wepClass = String(perma?.meta.class ?? "");
          loadout.weps[permaName] = { class: wepClass, slot: null, equipped: false };
          break;
        }
        case "wepskin":
          loadout.wepskins[def.displayName] = vars[0];
          break;
        default:
          throw new EconomyError("unknown_rare_type");
      }

      await this.repo.applySlotOps(steamId, [{ slot, itemId: null }]);
      await this.repo.setEconPlayer(steamId, econ);
      return this.getState(steamId);
    });
  }

  // Dev.UnredeemItem — reverse: back into the inventory as a tradable rare.
  async unredeemItem(steamId: string, rareType: RareType, key: string): Promise<EconomyStateView> {
    return this.withLock(steamId, async () => {
      const econ = await this.repo.getEconPlayer(steamId);
      const loadout = econ.loadout;
      const owned =
        (rareType === "cade" && loadout.cades[key]) ||
        (rareType === "mat" && loadout.mats[key]) ||
        (rareType === "specwep" && loadout.specweps[key]) ||
        (rareType === "jihadsound" && loadout.jihads[key]) ||
        (rareType === "taunt" && loadout.taunts[key]) ||
        (rareType === "wep" && loadout.weps[key]) ||
        (rareType === "wepskin" && loadout.wepskins[key]);
      if (!owned) throw new EconomyError("not_owned", 404);
      if (rareType === "wep" && loadout.weps[key]?.bought) throw new EconomyError("bought_not_unredeemable", 409);

      // Find the rare def this collection entry came from.
      const defs = await this.repo.listDefs();
      const rare = defs.find((def) => {
        if (def.kind !== "rare" || String(def.meta.type) !== rareType) return false;
        const rawVar = def.meta.var;
        const vars = Array.isArray(rawVar) ? rawVar.map(String) : [String(rawVar ?? def.displayName)];
        if (rareType === "mat" || rareType === "jihadsound" || rareType === "wepskin") {
          return def.displayName === key;
        }
        return vars.includes(key) || def.displayName === key;
      });
      if (!rare) throw new EconomyError("no_matching_rare", 409);

      const inventory = await this.repo.getInventory(steamId);
      const [freeSlot] = this.firstFreeSlots(inventory, 1);

      switch (rareType) {
        case "cade": {
          const rawVar = rare.meta.var;
          const vars = Array.isArray(rawVar) ? rawVar.map(String) : [String(rawVar ?? rare.displayName)];
          for (const cade of vars) delete loadout.cades[cade];
          break;
        }
        case "mat":
          delete loadout.mats[key];
          if (loadout.equipped.mat === key) delete loadout.equipped.mat;
          break;
        case "specwep":
          delete loadout.specweps[key];
          if (loadout.equipped.specwep === key) delete loadout.equipped.specwep;
          break;
        case "jihadsound":
          delete loadout.jihads[key];
          if (loadout.equipped.jihad === key) delete loadout.equipped.jihad;
          break;
        case "taunt":
          delete loadout.taunts[key];
          if (loadout.equipped.taunt === key) delete loadout.equipped.taunt;
          break;
        case "wep":
          delete loadout.weps[key];
          break;
        case "wepskin":
          delete loadout.wepskins[key];
          break;
      }

      await this.repo.applySlotOps(steamId, [{ slot: freeSlot, itemId: rare.defId }]);
      await this.repo.setEconPlayer(steamId, econ);
      return this.getState(steamId);
    });
  }

  // Dev.UnlockCrate (player_inventory.lua:1240) — faithful roll.
  rollCrate(crate: EconDef, crateId: string): string {
    const baseItems = (crate.meta.items as Array<{ name: string; chance: number }> | undefined) ?? [];
    const entries = baseItems.map((entry) => ({ ...entry }));
    const limited = crate.meta.limited != null;
    if (crateId !== "crate_Scratch Card Crate" && !limited) {
      entries.push({ name: "item_50 Scratch Cards", chance: 12 });
    }
    if (entries.length === 0) throw new EconomyError("empty_crate");

    const order = entries.map((_, index) => index);
    // Visit in random order; win on random(1, chance+2) == chance.
    while (order.length > 0) {
      const pick = this.rng(0, order.length - 1);
      const index = order.splice(pick, 1)[0];
      const entry = entries[index];
      if (this.rng(1, entry.chance + 2) === entry.chance) return entry.name;
    }

    // Nothing hit: least-chance entry, random among ties.
    let least = Infinity;
    for (const entry of entries) least = Math.min(least, entry.chance);
    const ties = entries.filter((entry) => entry.chance === least);
    return ties[this.rng(0, ties.length - 1)].name;
  }

  async openCrate(steamId: string, crateSlot: number): Promise<{ won: string; state: EconomyStateView }> {
    return this.withLock(steamId, async () => {
      const entry = await this.requireSlot(steamId, crateSlot);
      const crate = await this.requireDef(entry.itemId);
      if (crate.kind !== "crate") throw new EconomyError("not_a_crate");

      const keyName = crate.meta.key ? String(crate.meta.key) : null;
      const inventory = await this.repo.getInventory(steamId);
      let keySlot: number | null = null;
      if (keyName) {
        const keyId = `item_${keyName}`;
        const keyEntry = inventory.find((candidate) => candidate.itemId === keyId && candidate.slot !== crateSlot);
        if (!keyEntry) throw new EconomyError("missing_key", 409);
        keySlot = keyEntry.slot;
      }

      const won = this.rollCrate(crate, crate.defId);
      const wonDef = await this.repo.getDef(won);
      if (!wonDef) throw new EconomyError("drop_table_broken", 500);

      // Limited accounting (robby_tttlimited LmtItems equivalent).
      if (wonDef.kind === "rare" && wonDef.meta.limited != null) {
        const counters = await this.repo.getCounter(LIMITED_ITEMS_KEY);
        const cap = Number(wonDef.meta.limited);
        const current = counters[wonDef.defId] ?? 0;
        if (current >= cap) throw new EconomyError("limited_exhausted", 409);
        counters[wonDef.defId] = current + 1;
        await this.repo.setCounter(LIMITED_ITEMS_KEY, counters);
      }

      const ops: Array<{ slot: number; itemId: string | null }> = [{ slot: crateSlot, itemId: won }];
      if (keySlot != null) ops.push({ slot: keySlot, itemId: null });
      await this.repo.applySlotOps(steamId, ops);

      const econ = await this.repo.getEconPlayer(steamId);
      econ.stats.crateopen = (econ.stats.crateopen ?? 0) + 1;
      await this.repo.setEconPlayer(steamId, econ);

      return { won, state: await this.getState(steamId) };
    });
  }

  // Dev_SH.ReturnCraft — the economy-backbone subset of the crafting ladder.
  // (Meme/special combos from sh_items.lua:1227 not ported yet — documented in
  // docs/DEVOLVED_PORT_PLAN.md.)
  async resolveCraft(steamId: string, itemIds: string[]): Promise<string[] | null> {
    const defs: EconDef[] = [];
    for (const itemId of itemIds) {
      const def = await this.repo.getDef(itemId);
      if (!def) return null;
      // Limited items can never be craft inputs.
      if (def.meta.limited != null) return null;
      defs.push(def);
    }

    const names = defs.map((def) => def.displayName);
    const allSame = itemIds.every((id) => id === itemIds[0]);

    if (itemIds.length === 2) {
      const [a, b] = defs;
      // Metal ladder.
      if (allSame && names[0] === "Reclaimed Metal") return ["item_Refined Metal"];
      if (allSame && names[0] === "Refined Metal") return ["item_Refined Metal Stack"];
      if (allSame && names[0] === "Refined Metal Stack") return ["item_Metal Key"];
      // Rares → metals.
      if (a.kind === "rare" && b.kind === "rare") {
        if (allSame) return ["item_Refined Metal"];
        if (String(a.meta.type) === String(b.meta.type)) return ["item_Reclaimed Metal"];
      }
      // Crates → metals.
      if (a.kind === "crate" && b.kind === "crate") {
        return allSame ? ["item_Refined Metal"] : ["item_Reclaimed Metal"];
      }
    }

    // Data-driven recipes (require the "Recipe: X" unlock, multiset match on names).
    const econ = await this.repo.getEconPlayer(steamId);
    const allDefs = await this.repo.listDefs();
    for (const recipeDef of allDefs) {
      if (recipeDef.kind !== "recipe") continue;
      const recipeName = recipeDef.displayName;
      if (!econ.loadout.recipes[recipeName]) continue;
      const ingredients = ((recipeDef.meta.recipe as string[] | undefined) ?? []).slice();
      if (ingredients.length !== names.length) continue;
      const pool = names.slice();
      let matched = true;
      for (const ingredient of ingredients) {
        const index = pool.indexOf(ingredient);
        if (index === -1) {
          matched = false;
          break;
        }
        pool.splice(index, 1);
      }
      if (matched) return ((recipeDef.meta.gives as string[] | undefined) ?? []).slice();
    }

    return null;
  }

  async craft(steamId: string, slots: number[]): Promise<{ gives: string[]; state: EconomyStateView }> {
    if (slots.length < 1 || slots.length > 30) throw new EconomyError("bad_craft_input");
    if (new Set(slots).size !== slots.length) throw new EconomyError("bad_craft_input");
    return this.withLock(steamId, async () => {
      const inventory = await this.repo.getInventory(steamId);
      const inputs: string[] = [];
      for (const slot of slots) {
        const entry = inventory.find((candidate) => candidate.slot === slot);
        if (!entry) throw new EconomyError("empty_slot", 404);
        inputs.push(entry.itemId);
      }
      const gives = await this.resolveCraft(steamId, inputs);
      if (!gives || gives.length === 0) throw new EconomyError("no_recipe", 422);
      for (const result of gives) await this.requireDef(result);

      const ops: Array<{ slot: number; itemId: string | null }> = slots.map((slot) => ({ slot, itemId: null }));
      const remaining = inventory.filter((entry) => !slots.includes(entry.slot));
      const free = this.firstFreeSlots(remaining, gives.length);
      gives.forEach((result, index) => ops.push({ slot: free[index], itemId: result }));
      await this.repo.applySlotOps(steamId, ops);

      const counters = await this.repo.getCounter(LIMITED_CRAFTED_KEY);
      for (const result of gives) counters[result] = (counters[result] ?? 0) + 1;
      await this.repo.setCounter(LIMITED_CRAFTED_KEY, counters);

      return { gives, state: await this.getState(steamId) };
    });
  }

  // perma_buy / Dev_BuyTier / specwep_buy / buy_mat — bucks purchases into the loadout.
  async buyDef(steamId: string, defId: string): Promise<EconomyStateView> {
    return this.withLock(steamId, async () => {
      const def = await this.requireDef(defId);
      const core = await this.repo.getPlayerCore(steamId);
      if (!core) throw new EconomyError("player_not_found", 404);
      const { lvl } = levelFromXp(core.xp);
      const cost = Number(def.meta.cost ?? 0);
      const minLvl = Number(def.meta.lvl ?? 0);
      if (def.meta.hidden) throw new EconomyError("not_purchasable", 403);
      if (lvl < minLvl) throw new EconomyError("level_too_low", 403);

      const econ = await this.repo.getEconPlayer(steamId);
      const loadout = econ.loadout;
      const name = def.displayName;

      switch (def.kind) {
        case "perma": {
          if (loadout.weps[name] || loadout.permas[name]) throw new EconomyError("already_owned", 409);
          if (String(def.meta.type) === "wep") {
            loadout.weps[name] = { class: String(def.meta.class ?? ""), slot: null, equipped: false, bought: true };
          } else {
            loadout.permas[name] = true;
          }
          break;
        }
        case "tier":
          if (loadout.tiers[name]) throw new EconomyError("already_owned", 409);
          loadout.tiers[name] = true;
          break;
        case "specwep":
          if (loadout.specweps[name]) throw new EconomyError("already_owned", 409);
          loadout.specweps[name] = true;
          break;
        case "mat":
          if (loadout.mats[name]) throw new EconomyError("already_owned", 409);
          loadout.mats[name] = String(def.meta.path ?? def.meta.material ?? "");
          break;
        default:
          throw new EconomyError("not_purchasable", 403);
      }

      if (core.bucks < cost) throw new EconomyError("insufficient_bucks", 402);
      if (cost > 0) await this.repo.addBucks(steamId, -cost, `buy:${defId}`);
      await this.repo.setEconPlayer(steamId, econ);
      return this.getState(steamId);
    });
  }

  // LoadoutNet — equip/unequip owned things.
  async equip(
    steamId: string,
    type: "wep" | "mat" | "specwep" | "jihad" | "taunt" | "crosshair" | "wepskin",
    key: string,
    value?: string,
  ): Promise<EconomyStateView> {
    return this.withLock(steamId, async () => {
      const econ = await this.repo.getEconPlayer(steamId);
      const loadout = econ.loadout;
      switch (type) {
        case "wep": {
          const wep = loadout.weps[key];
          if (!wep) throw new EconomyError("not_owned", 404);
          wep.equipped = !wep.equipped;
          break;
        }
        case "wepskin": {
          const wep = loadout.weps[key];
          if (!wep) throw new EconomyError("not_owned", 404);
          if (value == null) {
            delete wep.mat;
          } else {
            const skin = loadout.wepskins[value];
            if (!skin) throw new EconomyError("not_owned", 404);
            wep.mat = skin;
          }
          break;
        }
        case "mat":
        case "specwep":
        case "jihad":
        case "taunt":
        case "crosshair": {
          const collection: Record<string, unknown> = {
            mat: loadout.mats,
            specwep: loadout.specweps,
            jihad: loadout.jihads,
            taunt: loadout.taunts,
            crosshair: loadout.crosshairs,
          }[type];
          if (loadout.equipped[type] === key) {
            delete loadout.equipped[type];
          } else {
            if (!collection[key]) throw new EconomyError("not_owned", 404);
            loadout.equipped[type] = key;
          }
          break;
        }
      }
      await this.repo.setEconPlayer(steamId, econ);
      return this.getState(steamId);
    });
  }

  /**
   * Serialize a two-player mutation (market buy, trade accept). Locks are
   * always acquired in ascending steamId order so two concurrent cross
   * mutations (A↔B vs B↔A) can never deadlock.
   */
  private async withTwoLocks<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
    if (a === b) return this.withLock(a, fn);
    const [first, second] = steamIdOrder(a, b) < 0 ? [a, b] : [b, a];
    return this.withLock(first, () => this.withLock(second, fn));
  }

  /** displayName for listing/trade views; falls back to the steamId for deleted players. */
  private async playerName(steamId: string, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(steamId);
    if (cached != null) return cached;
    const core = await this.repo.getPlayerCore(steamId);
    const name = core?.displayName ?? steamId;
    cache.set(steamId, name);
    return name;
  }

  private async listingViews(listings: MarketListing[], cache = new Map<string, string>()): Promise<MarketListingView[]> {
    const views: MarketListingView[] = [];
    for (const listing of listings) {
      views.push({
        listingId: listing.listingId,
        sellerSteamId: listing.sellerSteamId,
        sellerName: await this.playerName(listing.sellerSteamId, cache),
        itemId: listing.itemId,
        price: listing.price,
        createdAt: listing.createdAt,
      });
    }
    return views;
  }

  // GET /v1/economy/market — open listings, filter/sort/page.
  async marketBrowse(params: {
    q?: string;
    kind?: EconKind;
    sort?: MarketSort;
    page?: number;
    perPage?: number;
  }): Promise<{ listings: MarketListingView[]; total: number; page: number; perPage: number }> {
    const sort = params.sort ?? "newest";
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Math.floor(params.perPage ?? 50)));
    const { listings, total } = await this.repo.browseListings({
      q: params.q || undefined,
      kind: params.kind,
      sort,
      offset: (page - 1) * perPage,
      limit: perPage,
    });
    return { listings: await this.listingViews(listings), total, page, perPage };
  }

  async marketMine(steamId: string): Promise<{ listings: MarketListingView[] }> {
    const listings = await this.repo.listOpenListingsBySeller(steamId);
    return { listings: await this.listingViews(listings) };
  }

  // POST /v1/economy/market/list — item leaves the inventory into listing escrow.
  async marketList(steamId: string, slot: number, price: number): Promise<{ listingId: number; state: EconomyStateView }> {
    if (!Number.isInteger(price) || price < 1 || price > 1_000_000) throw new EconomyError("invalid_price");
    return this.withLock(steamId, async () => {
      const entry = await this.requireSlot(steamId, slot);
      const listingId = await this.repo.createListing(steamId, entry.itemId, price);
      await this.repo.applySlotOps(steamId, [{ slot, itemId: null }]);
      return { listingId, state: await this.getState(steamId) };
    });
  }

  // POST /v1/economy/market/buy — atomic debit/credit/deliver under both locks.
  async marketBuy(steamId: string, listingId: number): Promise<{ state: EconomyStateView }> {
    const listing = await this.repo.getListing(listingId);
    if (!listing || listing.status !== "open") throw new EconomyError("listing_not_found", 404);
    if (listing.sellerSteamId === steamId) throw new EconomyError("cannot_buy_own");
    return this.withTwoLocks(steamId, listing.sellerSteamId, async () => {
      const current = await this.repo.getListing(listingId);
      if (!current || current.status !== "open") throw new EconomyError("listing_not_found", 404);
      const core = await this.repo.getPlayerCore(steamId);
      if (!core) throw new EconomyError("player_not_found", 404);
      if (core.bucks < current.price) throw new EconomyError("insufficient_bucks", 402);
      const inventory = await this.repo.getInventory(steamId);
      const [freeSlot] = this.firstFreeSlots(inventory, 1);
      // CAS guards against a concurrent buy that slipped in ahead of us.
      const claimed = await this.repo.resolveListing(listingId, "sold", steamId);
      if (!claimed) throw new EconomyError("listing_not_found", 404);
      await this.repo.addBucks(steamId, -current.price, `market:buy:${current.itemId}`);
      await this.repo.addBucks(current.sellerSteamId, current.price, `market:sale:${current.itemId}`);
      await this.repo.applySlotOps(steamId, [{ slot: freeSlot, itemId: current.itemId }]);
      return { state: await this.getState(steamId) };
    });
  }

  // POST /v1/economy/market/cancel — seller pulls the item back.
  async marketCancel(steamId: string, listingId: number): Promise<{ state: EconomyStateView }> {
    return this.withLock(steamId, async () => {
      const listing = await this.repo.getListing(listingId);
      if (!listing) throw new EconomyError("listing_not_found", 404);
      if (listing.sellerSteamId !== steamId) throw new EconomyError("not_your_listing", 403);
      if (listing.status !== "open") throw new EconomyError("listing_not_found", 404);
      const inventory = await this.repo.getInventory(steamId);
      const [freeSlot] = this.firstFreeSlots(inventory, 1);
      const claimed = await this.repo.resolveListing(listingId, "cancelled", null);
      if (!claimed) throw new EconomyError("listing_not_found", 404);
      await this.repo.applySlotOps(steamId, [{ slot: freeSlot, itemId: listing.itemId }]);
      return { state: await this.getState(steamId) };
    });
  }

  // POST /v1/economy/trade/offer — nothing escrowed; sender side validated now,
  // everything re-validated at accept time.
  async tradeOffer(
    fromSteamId: string,
    input: {
      toSteamId: string;
      offerItemIds: string[];
      offerBucks: number;
      requestItemIds: string[];
      requestBucks: number;
      message?: string;
    },
  ): Promise<{ tradeId: number }> {
    const { toSteamId, offerItemIds, offerBucks, requestItemIds, requestBucks } = input;
    if (offerItemIds.length === 0 && requestItemIds.length === 0 && offerBucks <= 0 && requestBucks <= 0) {
      throw new EconomyError("empty_trade");
    }
    if (toSteamId === fromSteamId) throw new EconomyError("self_trade");
    if (!(await this.repo.playerExists(toSteamId))) throw new EconomyError("player_not_found", 404);
    const core = await this.repo.getPlayerCore(fromSteamId);
    if (!core) throw new EconomyError("player_not_found", 404);
    if ((await this.repo.countOpenOutgoingTrades(fromSteamId)) >= MAX_OPEN_OUTGOING_TRADES) {
      throw new EconomyError("too_many_trades", 429);
    }
    const inventory = await this.repo.getInventory(fromSteamId);
    if (!pickSlotsFor(inventory, offerItemIds)) throw new EconomyError("not_owned");
    if (core.bucks < offerBucks) throw new EconomyError("insufficient_bucks", 402);
    const tradeId = await this.repo.createTrade({
      fromSteamId,
      toSteamId,
      offerItemIds,
      offerBucks,
      requestItemIds,
      requestBucks,
      message: input.message ?? "",
    });
    return { tradeId };
  }

  private async tradeViews(trades: TradeOffer[], cache: Map<string, string>): Promise<TradeOfferView[]> {
    const views: TradeOfferView[] = [];
    for (const trade of trades) {
      views.push({
        tradeId: trade.tradeId,
        fromSteamId: trade.fromSteamId,
        fromName: await this.playerName(trade.fromSteamId, cache),
        toSteamId: trade.toSteamId,
        toName: await this.playerName(trade.toSteamId, cache),
        offerItemIds: trade.offerItemIds,
        offerBucks: trade.offerBucks,
        requestItemIds: trade.requestItemIds,
        requestBucks: trade.requestBucks,
        message: trade.message,
        createdAt: trade.createdAt,
      });
    }
    return views;
  }

  // GET /v1/economy/trade — open offers touching the caller.
  async tradeList(steamId: string): Promise<{ incoming: TradeOfferView[]; outgoing: TradeOfferView[] }> {
    const { incoming, outgoing } = await this.repo.listOpenTrades(steamId);
    const cache = new Map<string, string>();
    return { incoming: await this.tradeViews(incoming, cache), outgoing: await this.tradeViews(outgoing, cache) };
  }

  // POST /v1/economy/trade/accept — recipient only; atomic under both locks.
  async tradeAccept(steamId: string, tradeId: number): Promise<{ state: EconomyStateView }> {
    const trade = await this.repo.getTrade(tradeId);
    if (!trade) throw new EconomyError("trade_not_found", 404);
    if (trade.toSteamId !== steamId) throw new EconomyError("not_your_trade", 403);
    if (trade.status !== "open") throw new EconomyError("trade_not_found", 404);
    return this.withTwoLocks(trade.fromSteamId, trade.toSteamId, async () => {
      const current = await this.repo.getTrade(tradeId);
      if (!current || current.status !== "open") throw new EconomyError("trade_not_found", 404);
      const from = current.fromSteamId;
      const to = current.toSteamId;
      const fromCore = await this.repo.getPlayerCore(from);
      const toCore = await this.repo.getPlayerCore(to);
      if (!toCore) throw new EconomyError("player_not_found", 404);

      const fromInv = await this.repo.getInventory(from);
      const toInv = await this.repo.getInventory(to);
      const fromGiveSlots = pickSlotsFor(fromInv, current.offerItemIds);
      const toGiveSlots = pickSlotsFor(toInv, current.requestItemIds);
      if (!fromCore || !fromGiveSlots || !toGiveSlots) {
        // Either side no longer has the goods — auto-cancel the stale offer.
        await this.repo.resolveTrade(tradeId, "cancelled");
        throw new EconomyError("missing_items", 409);
      }
      if (fromCore.bucks < current.offerBucks || toCore.bucks < current.requestBucks) {
        throw new EconomyError("insufficient_bucks", 402);
      }

      // Incoming items land in each side's lowest free slots after their own
      // outgoing items vacate (throws inventory_full 409 when there's no room).
      const fromAfter = fromInv.filter((entry) => !fromGiveSlots.includes(entry.slot));
      const toAfter = toInv.filter((entry) => !toGiveSlots.includes(entry.slot));
      const fromFree = this.firstFreeSlots(fromAfter, current.requestItemIds.length);
      const toFree = this.firstFreeSlots(toAfter, current.offerItemIds.length);

      const claimed = await this.repo.resolveTrade(tradeId, "accepted");
      if (!claimed) throw new EconomyError("trade_not_found", 404);

      const fromOps: Array<{ slot: number; itemId: string | null }> = [
        ...fromGiveSlots.map((slot) => ({ slot, itemId: null })),
        ...current.requestItemIds.map((itemId, index) => ({ slot: fromFree[index], itemId })),
      ];
      const toOps: Array<{ slot: number; itemId: string | null }> = [
        ...toGiveSlots.map((slot) => ({ slot, itemId: null })),
        ...current.offerItemIds.map((itemId, index) => ({ slot: toFree[index], itemId })),
      ];
      await this.repo.applySlotOps(from, fromOps);
      await this.repo.applySlotOps(to, toOps);
      if (current.offerBucks > 0) {
        await this.repo.addBucks(from, -current.offerBucks, `trade:${tradeId}:send`);
        await this.repo.addBucks(to, current.offerBucks, `trade:${tradeId}:receive`);
      }
      if (current.requestBucks > 0) {
        await this.repo.addBucks(to, -current.requestBucks, `trade:${tradeId}:send`);
        await this.repo.addBucks(from, current.requestBucks, `trade:${tradeId}:receive`);
      }
      return { state: await this.getState(to) };
    });
  }

  private async closeTrade(
    steamId: string,
    tradeId: number,
    role: "from" | "to",
    status: "declined" | "cancelled",
  ): Promise<{ ok: true }> {
    const trade = await this.repo.getTrade(tradeId);
    if (!trade) throw new EconomyError("trade_not_found", 404);
    const owner = role === "to" ? trade.toSteamId : trade.fromSteamId;
    if (owner !== steamId) throw new EconomyError("not_your_trade", 403);
    if (trade.status !== "open") throw new EconomyError("trade_not_found", 404);
    const claimed = await this.repo.resolveTrade(tradeId, status);
    if (!claimed) throw new EconomyError("trade_not_found", 404);
    return { ok: true };
  }

  // POST /v1/economy/trade/decline — recipient only.
  async tradeDecline(steamId: string, tradeId: number): Promise<{ ok: true }> {
    return this.closeTrade(steamId, tradeId, "to", "declined");
  }

  // POST /v1/economy/trade/cancel — sender only.
  async tradeCancel(steamId: string, tradeId: number): Promise<{ ok: true }> {
    return this.closeTrade(steamId, tradeId, "from", "cancelled");
  }

  private async requireServerSecret(serverId: string, serverSecret: string): Promise<void> {
    const valid = await this.repo.validateServerSecret(serverId, serverSecret);
    if (!valid) throw new EconomyError("invalid_server_secret", 403);
  }

  // Server-authenticated debit (in-round spends like cade placement). The
  // ledger reason is namespaced game:<serverId>:<reason> so game-server
  // charges are distinguishable from shop buys (buy:<defId>).
  async chargeFromServer(
    serverId: string,
    serverSecret: string,
    steamId: string,
    amount: number,
    reason: string,
  ): Promise<{ bucks: number }> {
    await this.requireServerSecret(serverId, serverSecret);
    return this.withLock(steamId, async () => {
      const core = await this.repo.getPlayerCore(steamId);
      if (!core) throw new EconomyError("player_not_found", 404);
      if (core.bucks < amount) throw new EconomyError("insufficient_bucks", 402);
      const bucks = await this.repo.addBucks(steamId, -amount, `game:${serverId}:${reason}`);
      return { bucks };
    });
  }

  // Server-authenticated credit (kill rewards etc.) — bucks and/or xp.
  async rewardFromServer(
    serverId: string,
    serverSecret: string,
    steamId: string,
    bucksDelta: number,
    xpDelta: number,
    reason: string,
  ): Promise<{ bucks: number; xp: number; lvl: number }> {
    await this.requireServerSecret(serverId, serverSecret);
    return this.withLock(steamId, async () => {
      const core = await this.repo.getPlayerCore(steamId);
      if (!core) throw new EconomyError("player_not_found", 404);
      let bucks = core.bucks;
      let xp = core.xp;
      if (bucksDelta > 0) bucks = await this.repo.addBucks(steamId, bucksDelta, `game:${serverId}:${reason}`);
      if (xpDelta > 0) xp = await this.repo.addXp(steamId, xpDelta);
      return { bucks, xp, lvl: levelFromXp(xp).lvl };
    });
  }
}
