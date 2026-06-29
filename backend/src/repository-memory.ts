import { nanoid } from "nanoid";
import {
  GameMode,
  GameServer,
  HeartbeatInput,
  InventoryItem,
  AuditEvent,
  JoinTokenValidation,
  LeaderboardEntry,
  MatchRewardInput,
  OpenVibeRepository,
  Party,
  PartyInvite,
  PartyTravelReservation,
  Player,
  PlayerProfile,
  RegisterServerInput,
  ScriptPackage,
  ScriptPackageFile,
  ShopItem,
  TravelReservation,
  UpsertScriptPackageFileInput,
  UpsertScriptPackageInput,
  UpsertShopItemInput,
} from "./domain.js";

interface StoredServer extends GameServer {
  serverSecret: string;
}

interface StoredToken {
  token: string;
  steamId: string;
  serverId: string;
  mode: GameMode;
  expiresAt: string;
  consumedAt: string | null;
}

interface StoredParty {
  partyId: string;
  leaderSteamId: string;
  members: Set<string>;
  joinedAt: Map<string, string>;
}

const seedShop: ShopItem[] = [
  {
    itemId: "model_rebel",
    itemType: "player_model",
    displayName: "Rebel",
    description: "Baseline resistance player model.",
    assetPath: "models/player/group03/male_07.mdl",
    price: 0,
    enabled: true,
  },
  {
    itemId: "trail_blue",
    itemType: "trail",
    displayName: "Blue Trail",
    description: "A simple blue movement trail.",
    assetPath: "particles/openvibe/trail_blue.pcf",
    price: 100,
    enabled: true,
  },
];

export class MemoryOpenVibeRepository implements OpenVibeRepository {
  private players = new Map<string, Player>();
  private shop = new Map<string, ShopItem>(seedShop.map((item) => [item.itemId, item]));
  private inventory = new Map<string, Set<string>>();
  private servers = new Map<string, StoredServer>();
  private tokens = new Map<string, StoredToken>();
  private parties = new Map<string, StoredParty>();
  private invites = new Map<string, PartyInvite>();
  private auditEvents: AuditEvent[] = [];
  private rewardKeys = new Set<string>();
  private scriptPackages = new Map<string, ScriptPackage>();
  private scriptPackageFiles = new Map<string, ScriptPackageFile[]>();

  async upsertDevPlayer(input: { steamId: string; displayName: string }): Promise<PlayerProfile> {
    const existing = this.players.get(input.steamId);
    const player: Player = existing ?? {
      steamId: input.steamId,
      displayName: input.displayName,
      currencyBalance: 250,
      xp: 0,
      equippedModelId: "model_rebel",
      equippedTrailId: null,
    };

    player.displayName = input.displayName;
    this.players.set(input.steamId, player);
    this.ensureInventory(input.steamId).add("model_rebel");

    return this.profileFor(input.steamId);
  }

  async getProfile(steamId: string): Promise<PlayerProfile | null> {
    if (!this.players.has(steamId)) return null;
    return this.profileFor(steamId);
  }

  async listShop(): Promise<ShopItem[]> {
    return [...this.shop.values()].filter((item) => item.enabled);
  }

  async buyItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile> {
    const player = this.requirePlayer(input.steamId);
    const item = this.requireShopItem(input.itemId);
    const owned = this.ensureInventory(input.steamId);

    if (!item.enabled) {
      throw new RepositoryError("item_disabled", 409);
    }

    if (!owned.has(item.itemId)) {
      if (player.currencyBalance < item.price) {
        throw new RepositoryError("insufficient_currency", 409);
      }

      player.currencyBalance -= item.price;
      owned.add(item.itemId);
    }

    return this.profileFor(input.steamId);
  }

  async equipItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile> {
    const player = this.requirePlayer(input.steamId);
    const item = this.requireShopItem(input.itemId);
    const owned = this.ensureInventory(input.steamId);

    if (!owned.has(input.itemId)) {
      throw new RepositoryError("item_not_owned", 403);
    }

    if (item.itemType === "player_model") {
      player.equippedModelId = item.itemId;
    } else if (item.itemType === "trail") {
      player.equippedTrailId = item.itemId;
    }

    return this.profileFor(input.steamId);
  }

  async registerServer(input: RegisterServerInput): Promise<GameServer> {
    const now = new Date().toISOString();
    const server: StoredServer = {
      serverId: input.serverId,
      serverSecret: input.serverSecret,
      mode: input.mode,
      mapName: input.mapName,
      publicHost: input.publicHost,
      port: input.port,
      maxPlayers: input.maxPlayers,
      playerCount: 0,
      state: "open",
      lastHeartbeat: now,
    };

    this.servers.set(server.serverId, server);
    return this.publicServer(server);
  }

  async heartbeat(input: HeartbeatInput): Promise<GameServer | null> {
    const server = this.servers.get(input.serverId);
    if (!server || server.serverSecret !== input.serverSecret) return null;

    server.mapName = input.mapName;
    server.playerCount = input.playerCount;
    server.maxPlayers = input.maxPlayers;
    server.state = input.state;
    server.lastHeartbeat = new Date().toISOString();
    return this.publicServer(server);
  }

  async listServers(mode?: GameMode): Promise<GameServer[]> {
    return [...this.servers.values()]
      .filter((server) => (mode ? server.mode === mode : true))
      .filter((server) => server.state === "open" || server.state === "full")
      .map((server) => this.publicServer(server))
      .sort((a, b) => a.mode.localeCompare(b.mode) || b.playerCount - a.playerCount);
  }

  async reserveTravel(input: { steamId: string; mode: GameMode }): Promise<TravelReservation | null> {
    this.requirePlayer(input.steamId);

    const server = [...this.servers.values()]
      .filter((candidate) => candidate.mode === input.mode)
      .filter((candidate) => candidate.state === "open")
      .filter((candidate) => candidate.playerCount < candidate.maxPlayers)
      .sort((a, b) => b.playerCount - a.playerCount)[0];

    if (!server) return null;

    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const token = nanoid(32);
    this.tokens.set(token, {
      token,
      steamId: input.steamId,
      serverId: server.serverId,
      mode: input.mode,
      expiresAt,
      consumedAt: null,
    });

    return {
      mode: input.mode,
      serverId: server.serverId,
      connect: `${server.publicHost}:${server.port}`,
      joinToken: token,
      expiresAt,
    };
  }

  async createParty(input: { leaderSteamId: string }): Promise<Party> {
    this.requirePlayer(input.leaderSteamId);
    const now = new Date().toISOString();
    const party: StoredParty = {
      partyId: nanoid(16),
      leaderSteamId: input.leaderSteamId,
      members: new Set([input.leaderSteamId]),
      joinedAt: new Map([[input.leaderSteamId, now]]),
    };
    this.parties.set(party.partyId, party);
    return this.publicParty(party);
  }

  async inviteToParty(input: {
    partyId: string;
    invitedBySteamId: string;
    invitedSteamId: string;
  }): Promise<PartyInvite> {
    const party = this.requireParty(input.partyId);
    this.requirePlayer(input.invitedBySteamId);
    this.requirePlayer(input.invitedSteamId);
    if (!party.members.has(input.invitedBySteamId)) throw new RepositoryError("not_party_member", 403);

    const invite: PartyInvite = {
      inviteId: nanoid(16),
      partyId: input.partyId,
      invitedBySteamId: input.invitedBySteamId,
      invitedSteamId: input.invitedSteamId,
      status: "pending",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    this.invites.set(invite.inviteId, invite);
    return { ...invite };
  }

  async acceptPartyInvite(input: { inviteId: string; steamId: string }): Promise<Party> {
    const invite = this.invites.get(input.inviteId);
    if (!invite || invite.status !== "pending") throw new RepositoryError("invite_not_found", 404);
    if (invite.invitedSteamId !== input.steamId) throw new RepositoryError("invite_forbidden", 403);
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      invite.status = "expired";
      throw new RepositoryError("invite_expired", 409);
    }

    const party = this.requireParty(invite.partyId);
    party.members.add(input.steamId);
    party.joinedAt.set(input.steamId, new Date().toISOString());
    invite.status = "accepted";
    return this.publicParty(party);
  }

  async getParty(partyId: string): Promise<Party | null> {
    const party = this.parties.get(partyId);
    return party ? this.publicParty(party) : null;
  }

  async reservePartyTravel(input: {
    partyId: string;
    leaderSteamId: string;
    mode: GameMode;
  }): Promise<PartyTravelReservation | null> {
    const party = this.requireParty(input.partyId);
    if (party.leaderSteamId !== input.leaderSteamId) {
      throw new RepositoryError("party_leader_required", 403);
    }

    const members = [...party.members];
    const server = [...this.servers.values()]
      .filter((candidate) => candidate.mode === input.mode)
      .filter((candidate) => candidate.state === "open")
      .filter((candidate) => candidate.maxPlayers - candidate.playerCount >= members.length)
      .sort((a, b) => b.playerCount - a.playerCount)[0];

    if (!server) return null;

    const reservations = members.map((steamId) => {
      const expiresAt = new Date(Date.now() + 90_000).toISOString();
      const token = nanoid(32);
      this.tokens.set(token, {
        token,
        steamId,
        serverId: server.serverId,
        mode: input.mode,
        expiresAt,
        consumedAt: null,
      });
      return {
        mode: input.mode,
        serverId: server.serverId,
        connect: `${server.publicHost}:${server.port}`,
        joinToken: token,
        expiresAt,
      };
    });

    return {
      partyId: input.partyId,
      mode: input.mode,
      serverId: server.serverId,
      connect: `${server.publicHost}:${server.port}`,
      reservations,
    };
  }

  async validateJoinToken(input: {
    token: string;
    steamId: string;
    serverId: string;
  }): Promise<JoinTokenValidation> {
    const token = this.tokens.get(input.token);
    if (!token || token.consumedAt) return { valid: false };
    if (token.steamId !== input.steamId || token.serverId !== input.serverId) {
      return { valid: false };
    }
    if (new Date(token.expiresAt).getTime() <= Date.now()) return { valid: false };

    token.consumedAt = new Date().toISOString();
    return {
      valid: true,
      serverId: token.serverId,
      steamId: token.steamId,
      mode: token.mode,
    };
  }

  async recordMatchReward(input: MatchRewardInput): Promise<PlayerProfile | null> {
    const server = this.servers.get(input.serverId);
    if (!server || server.serverSecret !== input.serverSecret) return null;

    const player = this.requirePlayer(input.steamId);
    const key = `${input.matchId}:${input.steamId}`;
    if (!this.rewardKeys.has(key)) {
      player.currencyBalance += input.rewardCurrency;
      player.xp += input.rewardXp;
      this.rewardKeys.add(key);
    }

    return this.profileFor(input.steamId);
  }

  private profileFor(steamId: string): PlayerProfile {
    const player = this.requirePlayer(steamId);
    const owned = this.ensureInventory(steamId);
    const inventory: InventoryItem[] = [...owned].map((itemId) => {
      const item = this.requireShopItem(itemId);
      return {
        ...item,
        acquiredAt: new Date(0).toISOString(),
      };
    });

    return {
      player: { ...player },
      inventory,
      shop: [...this.shop.values()].filter((item) => item.enabled),
    };
  }

  private ensureInventory(steamId: string): Set<string> {
    let owned = this.inventory.get(steamId);
    if (!owned) {
      owned = new Set<string>();
      this.inventory.set(steamId, owned);
    }
    return owned;
  }

  private requirePlayer(steamId: string): Player {
    const player = this.players.get(steamId);
    if (!player) {
      throw new RepositoryError("player_not_found", 404);
    }
    return player;
  }

  private requireShopItem(itemId: string): ShopItem {
    const item = this.shop.get(itemId);
    if (!item) {
      throw new RepositoryError("item_not_found", 404);
    }
    return item;
  }

  private requireParty(partyId: string): StoredParty {
    const party = this.parties.get(partyId);
    if (!party) throw new RepositoryError("party_not_found", 404);
    return party;
  }

  private publicServer(server: StoredServer): GameServer {
    const { serverSecret: _serverSecret, ...safe } = server;
    return { ...safe };
  }

  private publicParty(party: StoredParty): Party {
    return {
      partyId: party.partyId,
      leaderSteamId: party.leaderSteamId,
      members: [...party.members].map((steamId) => {
        const player = this.requirePlayer(steamId);
        return {
          steamId,
          displayName: player.displayName,
          leader: steamId === party.leaderSteamId,
          joinedAt: party.joinedAt.get(steamId) ?? new Date(0).toISOString(),
        };
      }),
    };
  }

  async getLeaderboard(options: { limit: number; mode?: GameMode }): Promise<LeaderboardEntry[]> {
    const players = [...this.players.values()];
    const sorted = players
      .sort((a, b) => b.xp - a.xp || b.currencyBalance - a.currencyBalance)
      .slice(0, options.limit);

    return sorted.map((player, i) => ({
      rank: i + 1,
      steamId: player.steamId,
      displayName: player.displayName,
      xp: player.xp,
      currencyBalance: player.currencyBalance,
    }));
  }

  async upsertShopItem(input: UpsertShopItemInput): Promise<ShopItem> {
    const item: ShopItem = { ...input };
    this.shop.set(item.itemId, item);
    return { ...item };
  }

  async recordAuditEvent(input: {
    actorSteamId: string;
    action: string;
    targetSteamId?: string | null;
    reason: string;
  }): Promise<AuditEvent> {
    const event: AuditEvent = {
      auditId: nanoid(16),
      actorSteamId: input.actorSteamId,
      action: input.action,
      targetSteamId: input.targetSteamId ?? null,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    this.auditEvents.unshift(event);
    return { ...event };
  }

  async listAuditEvents(options: { limit: number }): Promise<AuditEvent[]> {
    return this.auditEvents.slice(0, options.limit).map((event) => ({ ...event }));
  }

  async listScriptPackages(): Promise<ScriptPackage[]> {
    return Array.from(this.scriptPackages.values()).map((p) => ({ ...p }));
  }

  async getScriptPackage(packageId: string): Promise<ScriptPackage | null> {
    const pkg = this.scriptPackages.get(packageId);
    return pkg ? { ...pkg } : null;
  }

  async upsertScriptPackage(input: UpsertScriptPackageInput): Promise<ScriptPackage> {
    const now = new Date().toISOString();
    const existing = this.scriptPackages.get(input.packageId);
    const pkg: ScriptPackage = {
      packageId: input.packageId,
      packageType: input.packageType,
      displayName: input.displayName,
      description: input.description,
      version: input.version,
      authorSteamId: input.authorSteamId ?? null,
      manifestJson: input.manifestJson ?? {},
      trusted: input.trusted ?? false,
      enabled: existing?.enabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.scriptPackages.set(pkg.packageId, pkg);
    return { ...pkg };
  }

  async upsertScriptPackageFile(input: UpsertScriptPackageFileInput): Promise<ScriptPackageFile> {
    const now = new Date().toISOString();
    const file: ScriptPackageFile = { ...input, createdAt: now };
    const files = this.scriptPackageFiles.get(input.packageId) ?? [];
    const idx = files.findIndex((f) => f.path === input.path);
    if (idx >= 0) {
      files[idx] = file;
    } else {
      files.push(file);
    }
    this.scriptPackageFiles.set(input.packageId, files);
    return { ...file };
  }

  async setScriptPackageEnabled(packageId: string, enabled: boolean): Promise<ScriptPackage | null> {
    const pkg = this.scriptPackages.get(packageId);
    if (!pkg) return null;
    const updated: ScriptPackage = { ...pkg, enabled, updatedAt: new Date().toISOString() };
    this.scriptPackages.set(packageId, updated);
    return { ...updated };
  }
}

export class RepositoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
  }
}
