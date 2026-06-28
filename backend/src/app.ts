import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { OpenVibeRepository } from "./domain.js";
import {
  authDevSchema,
  buyItemSchema,
  equipItemSchema,
  getMeQuerySchema,
  heartbeatSchema,
  leaderboardQuerySchema,
  listServersQuerySchema,
  matchEndSchema,
  registerServerSchema,
  travelRequestSchema,
  upsertShopItemSchema,
  validateJoinTokenSchema,
} from "./schemas.js";
import { RepositoryError } from "./repository-memory.js";

export interface AppOptions {
  repository: OpenVibeRepository;
  devAuthEnabled?: boolean;
  adminSecret?: string;
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

    return {
      sessionToken: `dev.${profile.player.steamId}`,
      ...profile,
    };
  });

  app.post("/v1/auth/steam", async (_request, reply) => {
    return reply.code(501).send({
      error: "steam_auth_not_configured",
      next: "Use ISteamUser::GetAuthTicketForWebApi client-side, then verify with AuthenticateUserTicket server-side.",
    });
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

  return app;
}
