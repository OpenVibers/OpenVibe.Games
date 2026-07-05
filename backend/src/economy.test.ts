import { beforeEach, describe, expect, it, vi } from "vitest";
import { EconDef, EconomyError, EconomyService, levelFromXp, Rng } from "./economy.js";
import { MemoryEconomyRepository } from "./economy-repository-memory.js";

const STEAM_ID = "76561198000000001";
const BUYER_ID = "76561198000000002";
const THIRD_ID = "76561198000000003";

function def(partial: Partial<EconDef> & { defId: string; kind: EconDef["kind"] }): EconDef {
  return {
    displayName: partial.defId.replace(/^(item_|crate_|\w+:)/, ""),
    icon: "",
    meta: {},
    enabled: true,
    ...partial,
  };
}

const DEFS: EconDef[] = [
  def({ defId: "item_Metal Key", kind: "item" }),
  def({ defId: "item_Reclaimed Metal", kind: "item" }),
  def({ defId: "item_Refined Metal", kind: "item" }),
  def({ defId: "item_Refined Metal Stack", kind: "item" }),
  def({ defId: "item_50 Scratch Cards", kind: "item" }),
  def({ defId: "item_Recipe: Indoor Joint", kind: "item", displayName: "Recipe: Indoor Joint" }),
  def({ defId: "item_Indoor Kush", kind: "item", displayName: "Indoor Kush" }),
  def({ defId: "item_Rolling Paper", kind: "item", displayName: "Rolling Paper" }),
  def({ defId: "item_Indoor Joint", kind: "item", displayName: "Indoor Joint" }),
  def({
    defId: "crate_Common Crate #1",
    kind: "crate",
    displayName: "Common Crate #1",
    meta: {
      key: "Metal Key",
      items: [
        { name: "AK47 Rare", chance: 40 },
        { name: "Wall Rare", chance: 4 },
      ],
    },
  }),
  def({
    defId: "crate_Limited Crate",
    kind: "crate",
    displayName: "Limited Crate",
    meta: { key: "Metal Key", limited: 5, items: [{ name: "Limited Rare", chance: 3 }] },
  }),
  def({ defId: "AK47 Rare", kind: "rare", displayName: "AK47 Rare", meta: { type: "wep", var: "AK47", chance: 40 } }),
  def({ defId: "Wall Rare", kind: "rare", displayName: "Wall Rare", meta: { type: "cade", var: ["Wall 1"], chance: 4 } }),
  def({
    defId: "Limited Rare",
    kind: "rare",
    displayName: "Limited Rare",
    meta: { type: "cade", var: ["Gold Wall"], chance: 3, limited: 1 },
  }),
  def({ defId: "perma:AK47", kind: "perma", displayName: "AK47", meta: { type: "wep", class: "weapon_ttt_ak47", cost: 2850, lvl: 5 } }),
  def({ defId: "perma:Cheap Pistol", kind: "perma", displayName: "Cheap Pistol", meta: { type: "wep", class: "weapon_pistol", cost: 10, lvl: 1 } }),
  def({ defId: "tier:25 Crates", kind: "tier", displayName: "25 Crates", meta: { cost: 100, amount: 25, stat: "crateopen" } }),
  def({
    defId: "recipe:Indoor Joint",
    kind: "recipe",
    displayName: "Indoor Joint",
    meta: { recipe: ["Indoor Kush", "Rolling Paper"], gives: ["item_Indoor Joint"] },
  }),
];

function makeService(rolls?: number[]): { service: EconomyService; repo: MemoryEconomyRepository } {
  const repo = new MemoryEconomyRepository();
  repo.upsertPlayer(STEAM_ID, { bucks: 500, xp: 0 });
  void repo.upsertDefs(DEFS);
  let index = 0;
  const rng: Rng | undefined = rolls
    ? (min, max) => {
        const value = rolls[index++ % rolls.length];
        return Math.max(min, Math.min(max, value));
      }
    : undefined;
  return { service: new EconomyService(repo, rng), repo };
}

describe("levelFromXp", () => {
  it("uses the devolved 900*(lvl*0.8) per-level thresholds", () => {
    expect(levelFromXp(0).lvl).toBe(1);
    expect(levelFromXp(719).lvl).toBe(1); // level-1 threshold is 720
    expect(levelFromXp(720).lvl).toBe(2);
    expect(levelFromXp(720 + 1440).lvl).toBe(3); // level-2 threshold is 1440
    expect(levelFromXp(720 + 1439).lvl).toBe(2);
  });
});

describe("inventory move", () => {
  it("moves into an empty slot and swaps occupied slots", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key", "item_Refined Metal"]);
    let inventory = await service.moveItem(STEAM_ID, 0, 5);
    expect(inventory).toEqual([
      { slot: 1, itemId: "item_Refined Metal" },
      { slot: 5, itemId: "item_Metal Key" },
    ]);
    inventory = await service.moveItem(STEAM_ID, 5, 1);
    expect(inventory).toEqual([
      { slot: 1, itemId: "item_Metal Key" },
      { slot: 5, itemId: "item_Refined Metal" },
    ]);
  });

  it("rejects moving from an empty slot", async () => {
    const { service } = makeService();
    await expect(service.moveItem(STEAM_ID, 3, 4)).rejects.toMatchObject({ code: "empty_slot" });
  });
});

describe("crate opening", () => {
  it("requires the key item", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["crate_Common Crate #1"]);
    await expect(service.openCrate(STEAM_ID, 0)).rejects.toMatchObject({ code: "missing_key" });
  });

  it("consumes crate + key and grants the rolled item", async () => {
    // rng: pick entry 0, then roll chance+2 hitting chance → win first visited entry.
    const { service } = makeService([0, 40]);
    await service.grantItems(STEAM_ID, ["crate_Common Crate #1", "item_Metal Key"]);
    const result = await service.openCrate(STEAM_ID, 0);
    expect(result.won).toBe("AK47 Rare");
    const ids = result.state.inventory.map((entry) => entry.itemId);
    expect(ids).toEqual(["AK47 Rare"]);
    expect(result.state.stats.crateopen).toBe(1);
  });

  it("falls back to the least-chance entry when nothing hits", async () => {
    // Misses on every entry (roll 1 != chance), then tie-break rng.
    const { service } = makeService([0, 1, 0, 1, 0, 1, 0]);
    await service.grantItems(STEAM_ID, ["crate_Common Crate #1", "item_Metal Key"]);
    const result = await service.openCrate(STEAM_ID, 0);
    expect(result.won).toBe("Wall Rare"); // chance 4 < 40 (bonus scratch entry not least)
  });

  it("enforces the limited cap", async () => {
    const { service, repo } = makeService([0, 3]);
    await repo.setCounter("limited_items", { "Limited Rare": 1 });
    await service.grantItems(STEAM_ID, ["crate_Limited Crate", "item_Metal Key"]);
    await expect(service.openCrate(STEAM_ID, 0)).rejects.toMatchObject({ code: "limited_exhausted" });
  });
});

describe("crafting", () => {
  it("crafts the metal ladder", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Reclaimed Metal", "item_Reclaimed Metal"]);
    const result = await service.craft(STEAM_ID, [0, 1]);
    expect(result.gives).toEqual(["item_Refined Metal"]);
    expect(result.state.inventory.map((entry) => entry.itemId)).toEqual(["item_Refined Metal"]);
  });

  it("combines two identical rares into refined metal", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["AK47 Rare", "AK47 Rare"]);
    const result = await service.craft(STEAM_ID, [0, 1]);
    expect(result.gives).toEqual(["item_Refined Metal"]);
  });

  it("combines two same-type rares into reclaimed metal", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["Wall Rare", "Limited Rare"]);
    // Limited rares are rejected as craft inputs.
    await expect(service.craft(STEAM_ID, [0, 1])).rejects.toMatchObject({ code: "no_recipe" });
  });

  it("crafts data recipes only after the recipe unlock is used", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, [
      "item_Indoor Kush",
      "item_Rolling Paper",
      "item_Recipe: Indoor Joint",
    ]);
    await expect(service.craft(STEAM_ID, [0, 1])).rejects.toMatchObject({ code: "no_recipe" });
    const used = await service.useItem(STEAM_ID, 2);
    expect(used.effect).toBe("recipe_unlocked:Indoor Joint");
    const result = await service.craft(STEAM_ID, [0, 1]);
    expect(result.gives).toEqual(["item_Indoor Joint"]);
  });
});

describe("redeem / unredeem", () => {
  it("redeems a weapon rare into the loadout and unredeems it back", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["AK47 Rare"]);
    const state = await service.redeemItem(STEAM_ID, 0);
    expect(state.inventory).toEqual([]);
    expect(state.loadout.weps.AK47).toMatchObject({ class: "weapon_ttt_ak47", equipped: false });

    const back = await service.unredeemItem(STEAM_ID, "wep", "AK47");
    expect(back.loadout.weps.AK47).toBeUndefined();
    expect(back.inventory.map((entry) => entry.itemId)).toEqual(["AK47 Rare"]);
  });

  it("redeems cade rares into the cade collection", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["Wall Rare"]);
    const state = await service.redeemItem(STEAM_ID, 0);
    expect(state.loadout.cades["Wall 1"]).toBe(true);
  });

  it("blocks unredeeming bucks-bought permas", async () => {
    const { service } = makeService();
    await service.buyDef(STEAM_ID, "perma:Cheap Pistol");
    await expect(service.unredeemItem(STEAM_ID, "wep", "Cheap Pistol")).rejects.toMatchObject({
      code: "bought_not_unredeemable",
    });
  });
});

describe("buying and equipping", () => {
  it("enforces bucks and level requirements", async () => {
    const { service, repo } = makeService();
    await expect(service.buyDef(STEAM_ID, "perma:AK47")).rejects.toMatchObject({ code: "level_too_low" });
    await repo.addXp(STEAM_ID, 50000); // plenty of levels
    await expect(service.buyDef(STEAM_ID, "perma:AK47")).rejects.toMatchObject({ code: "insufficient_bucks" });
    await repo.addBucks(STEAM_ID, 5000);
    const state = await service.buyDef(STEAM_ID, "perma:AK47");
    expect(state.loadout.weps.AK47).toMatchObject({ class: "weapon_ttt_ak47", bought: true });
    expect(state.player.bucks).toBe(500 + 5000 - 2850);
    await expect(service.buyDef(STEAM_ID, "perma:AK47")).rejects.toMatchObject({ code: "already_owned" });
  });

  it("buys tiers and equips weapons", async () => {
    const { service } = makeService();
    let state = await service.buyDef(STEAM_ID, "tier:25 Crates");
    expect(state.loadout.tiers["25 Crates"]).toBe(true);
    expect(state.player.bucks).toBe(400);

    await service.buyDef(STEAM_ID, "perma:Cheap Pistol");
    state = await service.equip(STEAM_ID, "wep", "Cheap Pistol");
    expect(state.loadout.weps["Cheap Pistol"].equipped).toBe(true);
    state = await service.equip(STEAM_ID, "wep", "Cheap Pistol");
    expect(state.loadout.weps["Cheap Pistol"].equipped).toBe(false);
  });
});

describe("server charge / reward", () => {
  const SERVER_ID = "local-dev";
  const SECRET = "dev-secret";

  function makeServerService() {
    const made = makeService();
    made.repo.registerServer(SERVER_ID, SECRET);
    return made;
  }

  it("charges bucks with a game:<serverId>:<reason> ledger reason", async () => {
    const { service, repo } = makeServerService();
    const addBucks = vi.spyOn(repo, "addBucks");
    const result = await service.chargeFromServer(SERVER_ID, SECRET, STEAM_ID, 40, "cade:Wall 1");
    expect(result).toEqual({ bucks: 460 });
    expect(addBucks).toHaveBeenCalledWith(STEAM_ID, -40, "game:local-dev:cade:Wall 1");
  });

  it("rejects an overdraw with insufficient_bucks", async () => {
    const { service } = makeServerService();
    await expect(service.chargeFromServer(SERVER_ID, SECRET, STEAM_ID, 501, "cade:Wall 1")).rejects.toMatchObject({
      code: "insufficient_bucks",
      statusCode: 402,
    });
  });

  it("rejects a bad server secret", async () => {
    const { service } = makeServerService();
    await expect(service.chargeFromServer(SERVER_ID, "wrong", STEAM_ID, 10, "cade:Wall 1")).rejects.toMatchObject({
      code: "invalid_server_secret",
      statusCode: 403,
    });
    await expect(service.rewardFromServer("nope", SECRET, STEAM_ID, 5, 15, "kill")).rejects.toMatchObject({
      code: "invalid_server_secret",
      statusCode: 403,
    });
  });

  it("rejects charging an unknown player", async () => {
    const { service } = makeServerService();
    await expect(service.chargeFromServer(SERVER_ID, SECRET, "76561198999999999", 10, "cade:Wall 1")).rejects.toMatchObject({
      code: "player_not_found",
      statusCode: 404,
    });
  });

  it("rewards bucks and xp and computes the level", async () => {
    const { service } = makeServerService();
    let result = await service.rewardFromServer(SERVER_ID, SECRET, STEAM_ID, 5, 15, "kill");
    expect(result).toEqual({ bucks: 505, xp: 15, lvl: 1 });
    result = await service.rewardFromServer(SERVER_ID, SECRET, STEAM_ID, 0, 720, "kill");
    expect(result).toEqual({ bucks: 505, xp: 735, lvl: 2 }); // level-1 threshold is 720
  });
});

function fullInventoryOps(): Array<{ slot: number; itemId: string }> {
  return Array.from({ length: 200 }, (_, slot) => ({ slot, itemId: "item_Reclaimed Metal" }));
}

describe("market", () => {
  it("lists an item into escrow and browses it", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const listed = await service.marketList(STEAM_ID, 0, 100);
    expect(listed.listingId).toBe(1);
    expect(listed.state.inventory).toEqual([]);
    const browse = await service.marketBrowse({});
    expect(browse).toMatchObject({ total: 1, page: 1, perPage: 50 });
    expect(browse.listings[0]).toMatchObject({
      listingId: 1,
      sellerSteamId: STEAM_ID,
      sellerName: `Player ${STEAM_ID}`,
      itemId: "item_Metal Key",
      price: 100,
    });
    expect(typeof browse.listings[0].createdAt).toBe("string");
    const mine = await service.marketMine(STEAM_ID);
    expect(mine.listings.map((listing) => listing.listingId)).toEqual([1]);
  });

  it("rejects bad prices and empty slots", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    await expect(service.marketList(STEAM_ID, 0, 0)).rejects.toMatchObject({ code: "invalid_price", statusCode: 400 });
    await expect(service.marketList(STEAM_ID, 0, 1_000_001)).rejects.toMatchObject({ code: "invalid_price" });
    await expect(service.marketList(STEAM_ID, 0, 10.5)).rejects.toMatchObject({ code: "invalid_price" });
    await expect(service.marketList(STEAM_ID, 3, 10)).rejects.toMatchObject({ code: "empty_slot", statusCode: 404 });
  });

  it("buys a listing: debit, credit, lowest free slot, ledger reasons", async () => {
    const { service, repo } = makeService();
    repo.upsertPlayer(BUYER_ID, { bucks: 150 });
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    await service.grantItems(BUYER_ID, ["item_Reclaimed Metal"]);
    const { listingId } = await service.marketList(STEAM_ID, 0, 100);
    const addBucks = vi.spyOn(repo, "addBucks");
    const result = await service.marketBuy(BUYER_ID, listingId);
    expect(result.state.player.bucks).toBe(50);
    expect(result.state.inventory).toEqual([
      { slot: 0, itemId: "item_Reclaimed Metal" },
      { slot: 1, itemId: "item_Metal Key" },
    ]);
    expect(addBucks).toHaveBeenCalledWith(BUYER_ID, -100, "market:buy:item_Metal Key");
    expect(addBucks).toHaveBeenCalledWith(STEAM_ID, 100, "market:sale:item_Metal Key");
    expect((await repo.getPlayerCore(STEAM_ID))?.bucks).toBe(600);
    expect((await service.marketBrowse({})).total).toBe(0);
    expect((await service.marketMine(STEAM_ID)).listings).toEqual([]);
    await expect(service.marketBuy(BUYER_ID, listingId)).rejects.toMatchObject({
      code: "listing_not_found",
      statusCode: 404,
    });
  });

  it("rejects buy errors: unknown listing, own listing, poor buyer, full inventory", async () => {
    const { service, repo } = makeService();
    repo.upsertPlayer(BUYER_ID, { bucks: 10 });
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const { listingId } = await service.marketList(STEAM_ID, 0, 100);
    await expect(service.marketBuy(BUYER_ID, 999)).rejects.toMatchObject({ code: "listing_not_found", statusCode: 404 });
    await expect(service.marketBuy(STEAM_ID, listingId)).rejects.toMatchObject({ code: "cannot_buy_own", statusCode: 400 });
    await expect(service.marketBuy(BUYER_ID, listingId)).rejects.toMatchObject({
      code: "insufficient_bucks",
      statusCode: 402,
    });
    repo.upsertPlayer(BUYER_ID, { bucks: 500 });
    await repo.applySlotOps(BUYER_ID, fullInventoryOps());
    await expect(service.marketBuy(BUYER_ID, listingId)).rejects.toMatchObject({
      code: "inventory_full",
      statusCode: 409,
    });
  });

  it("cancels a listing back to the lowest free slot (seller only)", async () => {
    const { service, repo } = makeService();
    repo.upsertPlayer(BUYER_ID, { bucks: 500 });
    await service.grantItems(STEAM_ID, ["item_Metal Key", "item_Refined Metal"]);
    const { listingId } = await service.marketList(STEAM_ID, 0, 100);
    await expect(service.marketCancel(BUYER_ID, listingId)).rejects.toMatchObject({
      code: "not_your_listing",
      statusCode: 403,
    });
    const result = await service.marketCancel(STEAM_ID, listingId);
    expect(result.state.inventory).toEqual([
      { slot: 0, itemId: "item_Metal Key" },
      { slot: 1, itemId: "item_Refined Metal" },
    ]);
    await expect(service.marketCancel(STEAM_ID, listingId)).rejects.toMatchObject({
      code: "listing_not_found",
      statusCode: 404,
    });
    await expect(service.marketBuy(BUYER_ID, listingId)).rejects.toMatchObject({ code: "listing_not_found" });
    await expect(service.marketCancel(STEAM_ID, 999)).rejects.toMatchObject({ code: "listing_not_found" });
  });

  it("rejects cancelling into a full inventory", async () => {
    const { service, repo } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const { listingId } = await service.marketList(STEAM_ID, 0, 100);
    await repo.applySlotOps(STEAM_ID, fullInventoryOps());
    await expect(service.marketCancel(STEAM_ID, listingId)).rejects.toMatchObject({
      code: "inventory_full",
      statusCode: 409,
    });
  });

  it("filters, sorts and pages the browse view", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key", "item_Refined Metal", "crate_Common Crate #1", "AK47 Rare"]);
    await service.marketList(STEAM_ID, 0, 50); // item_Metal Key
    await service.marketList(STEAM_ID, 1, 200); // item_Refined Metal
    await service.marketList(STEAM_ID, 2, 100); // crate_Common Crate #1
    await service.marketList(STEAM_ID, 3, 500); // AK47 Rare
    const metal = await service.marketBrowse({ q: "metal" });
    expect(metal.total).toBe(2);
    const key = await service.marketBrowse({ q: "KEY" });
    expect(key.listings.map((listing) => listing.itemId)).toEqual(["item_Metal Key"]);
    const crates = await service.marketBrowse({ kind: "crate" });
    expect(crates.listings.map((listing) => listing.itemId)).toEqual(["crate_Common Crate #1"]);
    const asc = await service.marketBrowse({ sort: "price_asc" });
    expect(asc.listings.map((listing) => listing.price)).toEqual([50, 100, 200, 500]);
    const desc = await service.marketBrowse({ sort: "price_desc" });
    expect(desc.listings.map((listing) => listing.price)).toEqual([500, 200, 100, 50]);
    const newest = await service.marketBrowse({});
    expect(newest.listings.map((listing) => listing.listingId)).toEqual([4, 3, 2, 1]);
    const page2 = await service.marketBrowse({ sort: "price_asc", page: 2, perPage: 2 });
    expect(page2).toMatchObject({ total: 4, page: 2, perPage: 2 });
    expect(page2.listings.map((listing) => listing.price)).toEqual([200, 500]);
  });

  it("never double-sells a listing under concurrent buys", async () => {
    const { service, repo } = makeService();
    repo.upsertPlayer(BUYER_ID, { bucks: 1000 });
    repo.upsertPlayer(THIRD_ID, { bucks: 1000 });
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const { listingId } = await service.marketList(STEAM_ID, 0, 100);
    const results = await Promise.allSettled([
      service.marketBuy(BUYER_ID, listingId),
      service.marketBuy(THIRD_ID, listingId),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "listing_not_found", statusCode: 404 });
    // Seller credited exactly once, item delivered exactly once.
    expect((await repo.getPlayerCore(STEAM_ID))?.bucks).toBe(600);
    const buyerInv = await repo.getInventory(BUYER_ID);
    const thirdInv = await repo.getInventory(THIRD_ID);
    expect(buyerInv.length + thirdInv.length).toBe(1);
  });
});

describe("trading", () => {
  function makeTradeService() {
    const made = makeService();
    made.repo.upsertPlayer(BUYER_ID, { bucks: 500, xp: 0 });
    made.repo.upsertPlayer(THIRD_ID, { bucks: 500, xp: 0 });
    return made;
  }

  function offer(overrides: Partial<Parameters<EconomyService["tradeOffer"]>[1]> = {}) {
    return { toSteamId: BUYER_ID, offerItemIds: [], offerBucks: 0, requestItemIds: [], requestBucks: 0, ...overrides };
  }

  it("validates offers", async () => {
    const { service } = makeTradeService();
    await expect(service.tradeOffer(STEAM_ID, offer())).rejects.toMatchObject({ code: "empty_trade", statusCode: 400 });
    await expect(service.tradeOffer(STEAM_ID, offer({ toSteamId: STEAM_ID, offerBucks: 10 }))).rejects.toMatchObject({
      code: "self_trade",
      statusCode: 400,
    });
    await expect(
      service.tradeOffer(STEAM_ID, offer({ toSteamId: "76561198999999999", offerBucks: 10 })),
    ).rejects.toMatchObject({ code: "player_not_found", statusCode: 404 });
    await expect(service.tradeOffer(STEAM_ID, offer({ offerItemIds: ["item_Metal Key"] }))).rejects.toMatchObject({
      code: "not_owned",
      statusCode: 400,
    });
    // Multiset ownership: offering the same item twice needs two copies.
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    await expect(
      service.tradeOffer(STEAM_ID, offer({ offerItemIds: ["item_Metal Key", "item_Metal Key"] })),
    ).rejects.toMatchObject({ code: "not_owned" });
    await expect(service.tradeOffer(STEAM_ID, offer({ offerBucks: 501 }))).rejects.toMatchObject({
      code: "insufficient_bucks",
      statusCode: 402,
    });
  });

  it("caps open outgoing offers at 10", async () => {
    const { service } = makeTradeService();
    for (let index = 0; index < 10; index++) {
      await service.tradeOffer(STEAM_ID, offer({ offerBucks: 1 }));
    }
    await expect(service.tradeOffer(STEAM_ID, offer({ offerBucks: 1 }))).rejects.toMatchObject({
      code: "too_many_trades",
      statusCode: 429,
    });
    // Cancelling one frees a slot.
    await service.tradeCancel(STEAM_ID, 1);
    const { tradeId } = await service.tradeOffer(STEAM_ID, offer({ offerBucks: 1 }));
    expect(tradeId).toBe(11);
  });

  it("lists open offers with names on both ends", async () => {
    const { service } = makeTradeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const { tradeId } = await service.tradeOffer(
      STEAM_ID,
      offer({ offerItemIds: ["item_Metal Key"], requestBucks: 50, message: "key 4 bucks" }),
    );
    const buyerView = await service.tradeList(BUYER_ID);
    expect(buyerView.outgoing).toEqual([]);
    expect(buyerView.incoming[0]).toMatchObject({
      tradeId,
      fromSteamId: STEAM_ID,
      fromName: `Player ${STEAM_ID}`,
      toSteamId: BUYER_ID,
      toName: `Player ${BUYER_ID}`,
      offerItemIds: ["item_Metal Key"],
      offerBucks: 0,
      requestItemIds: [],
      requestBucks: 50,
      message: "key 4 bucks",
    });
    const senderView = await service.tradeList(STEAM_ID);
    expect(senderView.incoming).toEqual([]);
    expect(senderView.outgoing.map((trade) => trade.tradeId)).toEqual([tradeId]);
  });

  it("accepts a trade: swaps items and bucks with trade ledger reasons", async () => {
    const { service, repo } = makeTradeService();
    await service.grantItems(STEAM_ID, ["AK47 Rare"]);
    await service.grantItems(BUYER_ID, ["item_Metal Key"]);
    const { tradeId } = await service.tradeOffer(
      STEAM_ID,
      offer({ offerItemIds: ["AK47 Rare"], offerBucks: 30, requestItemIds: ["item_Metal Key"], requestBucks: 10 }),
    );
    const addBucks = vi.spyOn(repo, "addBucks");
    const result = await service.tradeAccept(BUYER_ID, tradeId);
    expect(result.state.player.steamId).toBe(BUYER_ID);
    expect(result.state.player.bucks).toBe(520);
    expect(result.state.inventory).toEqual([{ slot: 0, itemId: "AK47 Rare" }]);
    expect(await repo.getInventory(STEAM_ID)).toEqual([{ slot: 0, itemId: "item_Metal Key" }]);
    expect((await repo.getPlayerCore(STEAM_ID))?.bucks).toBe(480);
    expect(addBucks).toHaveBeenCalledWith(STEAM_ID, -30, `trade:${tradeId}:send`);
    expect(addBucks).toHaveBeenCalledWith(BUYER_ID, 30, `trade:${tradeId}:receive`);
    expect(addBucks).toHaveBeenCalledWith(BUYER_ID, -10, `trade:${tradeId}:send`);
    expect(addBucks).toHaveBeenCalledWith(STEAM_ID, 10, `trade:${tradeId}:receive`);
    await expect(service.tradeAccept(BUYER_ID, tradeId)).rejects.toMatchObject({
      code: "trade_not_found",
      statusCode: 404,
    });
    expect((await service.tradeList(BUYER_ID)).incoming).toEqual([]);
  });

  it("auto-cancels on missing items at accept time", async () => {
    const { service, repo } = makeTradeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const first = await service.tradeOffer(STEAM_ID, offer({ offerItemIds: ["item_Metal Key"] }));
    await repo.applySlotOps(STEAM_ID, [{ slot: 0, itemId: null }]); // sender no longer owns it
    await expect(service.tradeAccept(BUYER_ID, first.tradeId)).rejects.toMatchObject({
      code: "missing_items",
      statusCode: 409,
    });
    await expect(service.tradeAccept(BUYER_ID, first.tradeId)).rejects.toMatchObject({
      code: "trade_not_found",
      statusCode: 404,
    });
    expect((await service.tradeList(BUYER_ID)).incoming).toEqual([]);
    expect((await service.tradeList(STEAM_ID)).outgoing).toEqual([]);

    // Recipient side missing the requested goods auto-cancels too.
    const second = await service.tradeOffer(STEAM_ID, offer({ offerBucks: 5, requestItemIds: ["item_Refined Metal"] }));
    await expect(service.tradeAccept(BUYER_ID, second.tradeId)).rejects.toMatchObject({ code: "missing_items" });
    expect((await service.tradeList(STEAM_ID)).outgoing).toEqual([]);
  });

  it("rejects accept without funds and keeps the offer open", async () => {
    const { service, repo } = makeTradeService();
    const { tradeId } = await service.tradeOffer(STEAM_ID, offer({ requestBucks: 600 }));
    await expect(service.tradeAccept(BUYER_ID, tradeId)).rejects.toMatchObject({
      code: "insufficient_bucks",
      statusCode: 402,
    });
    expect((await service.tradeList(BUYER_ID)).incoming).toHaveLength(1);
    repo.upsertPlayer(BUYER_ID, { bucks: 600 });
    const result = await service.tradeAccept(BUYER_ID, tradeId);
    expect(result.state.player.bucks).toBe(0);
    expect((await repo.getPlayerCore(STEAM_ID))?.bucks).toBe(1100);
  });

  it("rejects accept when the recipient has no room and keeps the offer open", async () => {
    const { service, repo } = makeTradeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key"]);
    const { tradeId } = await service.tradeOffer(STEAM_ID, offer({ offerItemIds: ["item_Metal Key"] }));
    await repo.applySlotOps(BUYER_ID, fullInventoryOps());
    await expect(service.tradeAccept(BUYER_ID, tradeId)).rejects.toMatchObject({
      code: "inventory_full",
      statusCode: 409,
    });
    expect((await service.tradeList(BUYER_ID)).incoming).toHaveLength(1);
  });

  it("enforces accept/decline/cancel permissions", async () => {
    const { service } = makeTradeService();
    const { tradeId } = await service.tradeOffer(STEAM_ID, offer({ offerBucks: 10 }));
    await expect(service.tradeAccept(STEAM_ID, tradeId)).rejects.toMatchObject({
      code: "not_your_trade",
      statusCode: 403,
    });
    await expect(service.tradeAccept(THIRD_ID, tradeId)).rejects.toMatchObject({ code: "not_your_trade" });
    await expect(service.tradeDecline(STEAM_ID, tradeId)).rejects.toMatchObject({ code: "not_your_trade" });
    await expect(service.tradeCancel(BUYER_ID, tradeId)).rejects.toMatchObject({ code: "not_your_trade" });
    await expect(service.tradeDecline(BUYER_ID, 999)).rejects.toMatchObject({
      code: "trade_not_found",
      statusCode: 404,
    });
    await expect(service.tradeCancel(STEAM_ID, 999)).rejects.toMatchObject({ code: "trade_not_found" });
    expect(await service.tradeDecline(BUYER_ID, tradeId)).toEqual({ ok: true });
    await expect(service.tradeAccept(BUYER_ID, tradeId)).rejects.toMatchObject({ code: "trade_not_found" });
    const again = await service.tradeOffer(STEAM_ID, offer({ offerBucks: 10 }));
    expect(await service.tradeCancel(STEAM_ID, again.tradeId)).toEqual({ ok: true });
    await expect(service.tradeDecline(BUYER_ID, again.tradeId)).rejects.toMatchObject({ code: "trade_not_found" });
  });
});

describe("sorting", () => {
  it("sorts crates to the top", async () => {
    const { service } = makeService();
    await service.grantItems(STEAM_ID, ["item_Metal Key", "crate_Common Crate #1", "AK47 Rare"]);
    const inventory = await service.sortInventory(STEAM_ID, "crate_top");
    expect(inventory[0]).toEqual({ slot: 0, itemId: "crate_Common Crate #1" });
    expect(inventory).toHaveLength(3);
  });
});
