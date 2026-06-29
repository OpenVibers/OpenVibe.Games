import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { OpenVibeRepository } from "./domain.js";
import {
  authDevSchema,
  authSteamSchema,
  acceptPartyInviteSchema,
  auditEventSchema,
  auditQuerySchema,
  buyItemSchema,
  createPartySchema,
  equipItemSchema,
  getPartyQuerySchema,
  getMeQuerySchema,
  heartbeatSchema,
  leaderboardQuerySchema,
  listServersQuerySchema,
  matchEndSchema,
  partyInviteSchema,
  partyTravelSchema,
  registerServerSchema,
  travelRequestSchema,
  upsertShopItemSchema,
  validateJoinTokenSchema,
} from "./schemas.js";
import { RepositoryError } from "./repository-memory.js";
import { createSessionToken, OpenVibeSessionStore } from "./sessions.js";

export interface AppOptions {
  repository: OpenVibeRepository;
  devAuthEnabled?: boolean;
  adminSecret?: string;
  sessionStore?: OpenVibeSessionStore;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: error.issues,
      });
    }

    if (error instanceof RepositoryError) {
      return reply.code(error.statusCode).send({
        error: error.code,
      });
    }

    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  // Admin auth helper — checks X-Admin-Secret header
  function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
    const secret = options.adminSecret ?? process.env.OPENVIBE_ADMIN_SECRET;
    if (!secret) {
      void reply.code(501).send({ error: "admin_not_configured" });
      return false;
    }
    const provided = request.headers["x-admin-secret"];
    if (provided !== secret) {
      void reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  }

  app.get("/health", async () => ({
    ok: true,
    service: "openvibe-source-api",
    game: "OpenVibe: Source",
    domain: "openvibe.games",
  }));

  app.post("/v1/auth/dev", async (request, reply) => {
    if (!options.devAuthEnabled) {
      return reply.code(404).send({ error: "dev_auth_disabled" });
    }

    const body = authDevSchema.parse(request.body ?? {});
    const profile = await options.repository.upsertDevPlayer(body);
    const sessionToken = await createSessionToken(options.sessionStore, "dev", profile.player.steamId);

    return {
      sessionToken,
      ...profile,
    };
  });

  app.post("/v1/auth/steam", async (request, reply) => {
    const body = authSteamSchema.parse(request.body ?? {});
    const apiKey = process.env.STEAM_WEB_API_KEY;
    const appId = process.env.STEAM_APP_ID;
    const steamApiBase = process.env.STEAM_WEB_API_BASE ?? "https://api.steampowered.com";

    if (!apiKey || !appId) {
      return reply.code(501).send({
        error: "steam_auth_not_configured",
        next: "Set STEAM_WEB_API_KEY and STEAM_APP_ID so the backend can call ISteamUserAuth/AuthenticateUserTicket.",
      });
    }

    const url = new URL("/ISteamUserAuth/AuthenticateUserTicket/v1/", steamApiBase);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("appid", appId);
    url.searchParams.set("ticket", body.ticket);
    url.searchParams.set("identity", body.identity);
    url.searchParams.set("format", "json");

    const steamResponse = await fetch(url);
    if (!steamResponse.ok) {
      request.log.warn({ status: steamResponse.status }, "steam auth request failed");
      return reply.code(502).send({ error: "steam_auth_upstream_failed" });
    }

    const steamJson = (await steamResponse.json()) as {
      response?: {
        params?: {
          steamid?: string;
          ownersteamid?: string;
          vacbanned?: boolean;
          publisherbanned?: boolean;
        };
        error?: {
          errorcode?: number;
          errordesc?: string;
        };
      };
    };

    const params = steamJson.response?.params;
    if (!params?.steamid) {
      request.log.warn({ steam: steamJson.response?.error }, "steam auth ticket rejected");
      return reply.code(401).send({ error: "steam_ticket_invalid" });
    }

    if (params.vacbanned || params.publisherbanned) {
      return reply.code(403).send({ error: "steam_account_banned" });
    }

    const displayName = body.displayName ?? `Steam ${params.steamid.slice(-6)}`;
    const profile = await options.repository.upsertDevPlayer({
      steamId: params.steamid,
      displayName,
    });
    const sessionToken = await createSessionToken(options.sessionStore, "steam", params.steamid);

    return {
      authenticated: true,
      sessionToken,
      steamId: params.steamid,
      ownerSteamId: params.ownersteamid ?? params.steamid,
      ...profile,
    };
  });

  app.get("/v1/me", async (request, reply) => {
    const query = getMeQuerySchema.parse(request.query);
    const profile = await options.repository.getProfile(query.steamId);
    if (!profile) return reply.code(404).send({ error: "player_not_found" });
    return profile;
  });

  app.get("/v1/shop", async () => ({
    items: await options.repository.listShop(),
  }));

  app.get("/v1/assets/manifest", async () => {
    const cdnBaseUrl = (process.env.OPENVIBE_CDN_BASE_URL ?? "https://openvibe.games/cdn").replace(/\/+$/, "");
    const shop = await options.repository.listShop();

    return {
      cdnBaseUrl,
      generatedAt: new Date().toISOString(),
      assets: shop
        .filter((item) => item.assetPath.length > 0)
        .map((item) => {
          const isAbsolute = /^https?:\/\//i.test(item.assetPath);
          const assetPath = item.assetPath.replace(/^\/+/, "");
          return {
            itemId: item.itemId,
            itemType: item.itemType,
            displayName: item.displayName,
            assetPath: item.assetPath,
            url: isAbsolute ? item.assetPath : `${cdnBaseUrl}/${assetPath}`,
          };
        }),
    };
  });

  app.post("/v1/shop/buy", async (request) => {
    const body = buyItemSchema.parse(request.body);
    return options.repository.buyItem(body);
  });

  app.post("/v1/equip", async (request) => {
    const body = equipItemSchema.parse(request.body);
    return options.repository.equipItem(body);
  });

  app.post("/v1/servers/register", async (request) => {
    const body = registerServerSchema.parse(request.body);
    return options.repository.registerServer(body);
  });

  app.post("/v1/servers/heartbeat", async (request, reply) => {
    const body = heartbeatSchema.parse(request.body);
    const server = await options.repository.heartbeat(body);
    if (!server) return reply.code(403).send({ error: "invalid_server_secret" });
    return server;
  });

  app.get("/v1/servers", async (request) => {
    const query = listServersQuerySchema.parse(request.query);
    return {
      servers: await options.repository.listServers(query.mode),
    };
  });

  app.post("/v1/travel/request", async (request, reply) => {
    const body = travelRequestSchema.parse(request.body);
    const reservation = await options.repository.reserveTravel(body);
    if (!reservation) return reply.code(404).send({ error: "no_server_available" });
    return reservation;
  });

  app.post("/v1/parties", async (request) => {
    const body = createPartySchema.parse(request.body);
    return options.repository.createParty(body);
  });

  app.get("/v1/parties", async (request, reply) => {
    const query = getPartyQuerySchema.parse(request.query);
    const party = await options.repository.getParty(query.partyId);
    if (!party) return reply.code(404).send({ error: "party_not_found" });
    return party;
  });

  app.post("/v1/parties/invite", async (request) => {
    const body = partyInviteSchema.parse(request.body);
    return options.repository.inviteToParty(body);
  });

  app.post("/v1/parties/invite/accept", async (request) => {
    const body = acceptPartyInviteSchema.parse(request.body);
    return options.repository.acceptPartyInvite(body);
  });

  app.post("/v1/parties/travel", async (request, reply) => {
    const body = partyTravelSchema.parse(request.body);
    const reservation = await options.repository.reservePartyTravel(body);
    if (!reservation) return reply.code(404).send({ error: "no_server_with_party_capacity" });
    return reservation;
  });

  app.post("/v1/travel/validate", async (request) => {
    const body = validateJoinTokenSchema.parse(request.body);
    return options.repository.validateJoinToken(body);
  });

  app.post("/v1/matches/end", async (request, reply) => {
    const body = matchEndSchema.parse(request.body);
    const profile = await options.repository.recordMatchReward(body);
    if (!profile) return reply.code(403).send({ error: "invalid_server_secret" });
    return profile;
  });

  // GET /v1/leaderboard?limit=10&mode=prophunt
  app.get("/v1/leaderboard", async (request) => {
    const query = leaderboardQuerySchema.parse(request.query);
    const entries = await options.repository.getLeaderboard({
      limit: query.limit,
      mode: query.mode,
    });
    return { leaderboard: entries };
  });

  // Admin: upsert a shop item
  // POST /v1/admin/shop/items  { body: UpsertShopItemInput }
  // Requires X-Admin-Secret header.
  app.post("/v1/admin/shop/items", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = upsertShopItemSchema.parse(request.body);
    return options.repository.upsertShopItem(body);
  });

  app.post("/v1/admin/audit/events", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = auditEventSchema.parse(request.body);
    return options.repository.recordAuditEvent(body);
  });

  app.get("/v1/admin/audit/events", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = auditQuerySchema.parse(request.query);
    return { events: await options.repository.listAuditEvents(query) };
  });

  app.get("/metrics", async (_request, reply) => {
    const servers = await options.repository.listServers();
    const open = servers.filter((server) => server.state === "open").length;
    const players = servers.reduce((sum, server) => sum + server.playerCount, 0);
    reply.type("text/plain; version=0.0.4");
    return [
      "# HELP openvibe_servers_open Number of open OpenVibe Source servers.",
      "# TYPE openvibe_servers_open gauge",
      `openvibe_servers_open ${open}`,
      "# HELP openvibe_players_online Current players reported by live servers.",
      "# TYPE openvibe_players_online gauge",
      `openvibe_players_online ${players}`,
      "",
    ].join("\n");
  });

  app.addHook("onClose", async () => {
    await options.sessionStore?.close?.();
  });

  return app;
}
