import { z } from "zod";
import { modes } from "./domain.js";

const steamId = z.string().regex(/^\d{5,20}$/);
const serverId = z.string().min(3).max(80);
const serverSecret = z.string().min(6).max(256);
const mode = z.enum(modes);

export const authDevSchema = z.object({
  steamId: steamId.default("76561198000000000"),
  displayName: z.string().trim().min(1).max(64).default("OpenVibe Dev"),
});

export const authSteamSchema = z.object({
  ticket: z.string().regex(/^[0-9a-fA-F]+$/).min(16).max(8192),
  identity: z.string().trim().min(1).max(128).default("openvibe.games"),
  displayName: z.string().trim().min(1).max(64).optional(),
});

export const getMeQuerySchema = z.object({
  steamId,
});

export const buyItemSchema = z.object({
  steamId,
  itemId: z.string().min(1).max(80),
});

export const equipItemSchema = buyItemSchema;

export const registerServerSchema = z.object({
  serverId,
  serverSecret,
  mode,
  mapName: z.string().min(1).max(80),
  publicHost: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  maxPlayers: z.number().int().min(1).max(128),
});

export const heartbeatSchema = z.object({
  serverId,
  serverSecret,
  mapName: z.string().min(1).max(80),
  playerCount: z.number().int().min(0).max(128),
  maxPlayers: z.number().int().min(1).max(128),
  state: z.enum(["starting", "open", "full", "ending", "offline"]),
});

export const listServersQuerySchema = z.object({
  mode: mode.optional(),
});

export const travelRequestSchema = z.object({
  steamId,
  mode,
});

export const validateJoinTokenSchema = z.object({
  token: z.string().min(16).max(128),
  steamId,
  serverId,
});

export const matchEndSchema = z.object({
  matchId: z.string().min(3).max(120),
  serverId,
  serverSecret,
  steamId,
  mode,
  rewardCurrency: z.number().int().min(0).max(5000),
  rewardXp: z.number().int().min(0).max(50000),
  stats: z.record(z.string(), z.unknown()).optional(),
});

export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  mode: mode.optional(),
});

export const upsertShopItemSchema = z.object({
  itemId: z.string().min(1).max(80),
  itemType: z.enum(["player_model", "trail", "nameplate"]),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
  assetPath: z.string().min(1).max(255),
  price: z.number().int().min(0).max(100_000),
  enabled: z.boolean().default(true),
});
