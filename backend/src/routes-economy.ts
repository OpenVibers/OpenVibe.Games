import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { EconomyError, EconomyService } from "./economy.js";
import { OpenVibeSessionStore } from "./sessions.js";

export interface EconomyRouteOptions {
  economy: EconomyService;
  sessionStore?: OpenVibeSessionStore;
  devAuthEnabled?: boolean;
  adminSecret?: string;
}

const moveSchema = z.object({ from: z.number().int().min(0), to: z.number().int().min(0) });
const sortSchema = z.object({
  mode: z.enum(["asc", "desc", "crate_top", "crate_bot", "type_asc", "type_desc"]),
});
const slotSchema = z.object({ slot: z.number().int().min(0) });
const craftSchema = z.object({ slots: z.array(z.number().int().min(0)).min(1).max(30) });
const unredeemSchema = z.object({
  type: z.enum(["cade", "mat", "specwep", "jihadsound", "taunt", "wep", "wepskin"]),
  key: z.string().min(1),
});
const buySchema = z.object({ defId: z.string().min(1) });
const equipSchema = z.object({
  type: z.enum(["wep", "mat", "specwep", "jihad", "taunt", "crosshair", "wepskin"]),
  key: z.string().min(1),
  value: z.string().optional(),
});
const grantSchema = z.object({
  steamId: z.string().regex(/^\d{5,20}$/),
  items: z.array(z.string().min(1)).min(1).max(50),
});
const serverChargeSchema = z.object({
  serverId: z.string().min(1),
  serverSecret: z.string().min(1),
  steamId: z.string().regex(/^\d{5,20}$/),
  amount: z.number().int().positive(),
  reason: z.string().min(1).max(120),
});
const econKinds = [
  "item",
  "crate",
  "rare",
  "cade",
  "perma",
  "tier",
  "roundbuy",
  "specwep",
  "taunt",
  "mat",
  "recipe",
  "quest",
] as const;
const marketBrowseSchema = z.object({
  q: z.string().optional(),
  kind: z.enum(econKinds).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});
const marketListSchema = z.object({ slot: z.number().int().min(0), price: z.number() });
const listingIdSchema = z.object({ listingId: z.number().int().positive() });
const tradeOfferSchema = z.object({
  toSteamId: z.string().regex(/^\d{5,20}$/),
  offerItemIds: z.array(z.string().min(1)).max(8).default([]),
  offerBucks: z.number().int().min(0).default(0),
  requestItemIds: z.array(z.string().min(1)).max(8).default([]),
  requestBucks: z.number().int().min(0).default(0),
  message: z.string().max(200).optional(),
});
const tradeIdSchema = z.object({ tradeId: z.number().int().positive() });
const serverRewardSchema = z.object({
  serverId: z.string().min(1),
  serverSecret: z.string().min(1),
  steamId: z.string().regex(/^\d{5,20}$/),
  bucks: z.number().int().min(0),
  xp: z.number().int().min(0),
  reason: z.string().min(1).max(120),
});

export function registerEconomyRoutes(app: FastifyInstance, options: EconomyRouteOptions): void {
  // Identity comes from the Bearer session token (dev or steam). In dev-auth
  // mode a plain ?steamId=/body.steamId is also accepted so the menu and curl
  // stay usable without a Steam key.
  async function resolveSteamId(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const authHeader = (request.headers["authorization"] ?? "") as string;
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (options.sessionStore?.getSession) {
        const session = await options.sessionStore.getSession(token);
        if (session) return session.steamId;
      } else {
        const parts = token.split(".");
        if (parts.length >= 3 && (parts[0] === "dev" || parts[0] === "steam")) return parts[1];
      }
      await reply.code(401).send({ error: "invalid_token" });
      return null;
    }

    if (options.devAuthEnabled) {
      const fromQuery = (request.query as Record<string, string | undefined>)?.steamId;
      const fromBody = (request.body as Record<string, string | undefined> | null)?.steamId;
      const steamId = fromQuery ?? fromBody;
      if (steamId && /^\d{5,20}$/.test(steamId)) return steamId;
    }

    await reply.code(401).send({ error: "missing_token" });
    return null;
  }

  function sendEconomyError(reply: FastifyReply, error: unknown): void {
    if (error instanceof EconomyError) {
      void reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    throw error;
  }

  app.get("/v1/economy/defs", async () => {
    const defs = await options.economy.listDefs();
    return {
      defs: defs.map((def) => ({
        id: def.defId,
        kind: def.kind,
        name: def.displayName,
        icon: def.icon,
        // luaUse/luaCheck are un-ported Lua source archived in the seed; never serve them.
        meta: Object.fromEntries(
          Object.entries(def.meta).filter(([key]) => key !== "luaUse" && key !== "luaCheck"),
        ),
      })),
    };
  });

  app.get("/v1/economy/state", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    try {
      return await options.economy.getState(steamId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/move", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = moveSchema.parse(request.body);
    try {
      return { inventory: await options.economy.moveItem(steamId, body.from, body.to) };
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/sort", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = sortSchema.parse(request.body);
    try {
      return { inventory: await options.economy.sortInventory(steamId, body.mode) };
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/use", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = slotSchema.parse(request.body);
    try {
      return await options.economy.useItem(steamId, body.slot);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/redeem", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = slotSchema.parse(request.body);
    try {
      return await options.economy.redeemItem(steamId, body.slot);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/unredeem", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = unredeemSchema.parse(request.body);
    try {
      return await options.economy.unredeemItem(steamId, body.type, body.key);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/crates/open", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = slotSchema.parse(request.body);
    try {
      return await options.economy.openCrate(steamId, body.slot);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/craft", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = craftSchema.parse(request.body);
    try {
      return await options.economy.craft(steamId, body.slots);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/buy", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = buySchema.parse(request.body);
    try {
      return await options.economy.buyDef(steamId, body.defId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/equip", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = equipSchema.parse(request.body);
    try {
      return await options.economy.equip(steamId, body.type, body.key, body.value);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  // Market — docs/ECONOMY_TRADE_MARKET_API.md.
  app.get("/v1/economy/market", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const query = marketBrowseSchema.parse(request.query ?? {});
    try {
      return await options.economy.marketBrowse(query);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.get("/v1/economy/market/mine", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    try {
      return await options.economy.marketMine(steamId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/market/list", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = marketListSchema.parse(request.body);
    try {
      return await options.economy.marketList(steamId, body.slot, body.price);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/market/buy", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = listingIdSchema.parse(request.body);
    try {
      return await options.economy.marketBuy(steamId, body.listingId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/market/cancel", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = listingIdSchema.parse(request.body);
    try {
      return await options.economy.marketCancel(steamId, body.listingId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  // Trading — docs/ECONOMY_TRADE_MARKET_API.md.
  app.get("/v1/economy/trade", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    try {
      return await options.economy.tradeList(steamId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/trade/offer", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = tradeOfferSchema.parse(request.body);
    try {
      return await options.economy.tradeOffer(steamId, body);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/trade/accept", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = tradeIdSchema.parse(request.body);
    try {
      return await options.economy.tradeAccept(steamId, body.tradeId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/trade/decline", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = tradeIdSchema.parse(request.body);
    try {
      return await options.economy.tradeDecline(steamId, body.tradeId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/trade/cancel", async (request, reply) => {
    const steamId = await resolveSteamId(request, reply);
    if (!steamId) return;
    const body = tradeIdSchema.parse(request.body);
    try {
      return await options.economy.tradeCancel(steamId, body.tradeId);
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  // Server-authenticated economy mutations: game servers (not players) call
  // these — identity comes from the body steamId plus the server secret, so
  // resolveSteamId/session tokens are deliberately not involved.
  app.post("/v1/economy/server/charge", async (request, reply) => {
    const body = serverChargeSchema.parse(request.body);
    try {
      return await options.economy.chargeFromServer(
        body.serverId,
        body.serverSecret,
        body.steamId,
        body.amount,
        body.reason,
      );
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  app.post("/v1/economy/server/reward", async (request, reply) => {
    const body = serverRewardSchema.parse(request.body);
    try {
      return await options.economy.rewardFromServer(
        body.serverId,
        body.serverSecret,
        body.steamId,
        body.bucks,
        body.xp,
        body.reason,
      );
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });

  // Admin/testing: grant items (crate drops come later via the drop scheduler).
  app.post("/v1/admin/economy/grant", async (request, reply) => {
    const secret = options.adminSecret ?? process.env.OPENVIBE_ADMIN_SECRET;
    const devGrant = options.devAuthEnabled && !secret;
    if (!devGrant) {
      if (!secret) return reply.code(501).send({ error: "admin_not_configured" });
      if (request.headers["x-admin-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
    }
    const body = grantSchema.parse(request.body);
    try {
      return { inventory: await options.economy.grantItems(body.steamId, body.items) };
    } catch (error) {
      sendEconomyError(reply, error);
    }
  });
}
