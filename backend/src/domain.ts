export const modes = ["hub", "prophunt", "deathrun", "fortwars", "traitortown"] as const;

export type GameMode = (typeof modes)[number];

export type ServerState = "starting" | "open" | "full" | "ending" | "offline";

export type ItemType =
  | "player_model"
  | "trail"
  | "nameplate"
  | "title"
  | "spray"
  | "emote"
  | "fortwars_part"
  | "traitortown_cosmetic";

export type PackageType = "gamemode" | "addon" | "library";
export type PackageRealm = "server" | "client" | "shared";

export interface ScriptPackage {
  packageId: string;
  packageType: PackageType;
  displayName: string;
  description: string;
  version: string;
  authorSteamId: string | null;
  manifestJson: Record<string, unknown>;
  trusted: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptPackageFile {
  packageId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  realm: PackageRealm;
  content: string;
  createdAt: string;
}

export interface UpsertScriptPackageInput {
  packageId: string;
  packageType: PackageType;
  displayName: string;
  description: string;
  version: string;
  authorSteamId?: string | null;
  manifestJson?: Record<string, unknown>;
  trusted?: boolean;
}

export interface UpsertScriptPackageFileInput {
  packageId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  realm: PackageRealm;
  content: string;
}

export interface Player {
  steamId: string;
  displayName: string;
  currencyBalance: number;
  xp: number;
  equippedModelId: string | null;
  equippedTrailId: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  steamId: string;
  displayName: string;
  xp: number;
  currencyBalance: number;
}

export interface ShopItem {
  itemId: string;
  itemType: ItemType;
  displayName: string;
  description: string;
  assetPath: string;
  price: number;
  enabled: boolean;
}

export interface InventoryItem extends ShopItem {
  acquiredAt: string;
}

export interface PlayerProfile {
  player: Player;
  inventory: InventoryItem[];
  shop: ShopItem[];
}

export interface GameServer {
  serverId: string;
  mode: GameMode;
  mapName: string;
  publicHost: string;
  port: number;
  maxPlayers: number;
  playerCount: number;
  state: ServerState;
  lastHeartbeat: string;
}

export interface RegisterServerInput {
  serverId: string;
  serverSecret: string;
  mode: GameMode;
  mapName: string;
  publicHost: string;
  port: number;
  maxPlayers: number;
}

export interface HeartbeatInput {
  serverId: string;
  serverSecret: string;
  mapName: string;
  playerCount: number;
  maxPlayers: number;
  state: ServerState;
}

export interface TravelReservation {
  mode: GameMode;
  serverId: string;
  connect: string;
  joinToken: string;
  expiresAt: string;
}

export interface PartyMember {
  steamId: string;
  displayName: string;
  leader: boolean;
  joinedAt: string;
}

export interface Party {
  partyId: string;
  leaderSteamId: string;
  members: PartyMember[];
}

export interface PartyInvite {
  inviteId: string;
  partyId: string;
  invitedSteamId: string;
  invitedBySteamId: string;
  status: "pending" | "accepted" | "declined" | "expired";
  expiresAt: string;
}

export interface PartyTravelReservation {
  partyId: string;
  mode: GameMode;
  serverId: string;
  connect: string;
  reservations: TravelReservation[];
}

export interface AuditEvent {
  auditId: string;
  actorSteamId: string;
  action: string;
  targetSteamId: string | null;
  reason: string;
  createdAt: string;
}

export interface JoinTokenValidation {
  valid: boolean;
  serverId?: string;
  steamId?: string;
  mode?: GameMode;
}

export interface MatchRewardInput {
  matchId: string;
  serverId: string;
  serverSecret: string;
  steamId: string;
  mode: GameMode;
  rewardCurrency: number;
  rewardXp: number;
  stats?: Record<string, unknown>;
}

export interface UpsertShopItemInput {
  itemId: string;
  itemType: ItemType;
  displayName: string;
  description: string;
  assetPath: string;
  price: number;
  enabled: boolean;
}

export interface OpenVibeRepository {
  upsertDevPlayer(input: { steamId: string; displayName: string }): Promise<PlayerProfile>;
  getProfile(steamId: string): Promise<PlayerProfile | null>;
  listShop(): Promise<ShopItem[]>;
  buyItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile>;
  equipItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile>;
  registerServer(input: RegisterServerInput): Promise<GameServer>;
  heartbeat(input: HeartbeatInput): Promise<GameServer | null>;
  listServers(mode?: GameMode): Promise<GameServer[]>;
  reserveTravel(input: { steamId: string; mode: GameMode }): Promise<TravelReservation | null>;
  createParty(input: { leaderSteamId: string }): Promise<Party>;
  inviteToParty(input: {
    partyId: string;
    invitedBySteamId: string;
    invitedSteamId: string;
  }): Promise<PartyInvite>;
  acceptPartyInvite(input: { inviteId: string; steamId: string }): Promise<Party>;
  getParty(partyId: string): Promise<Party | null>;
  reservePartyTravel(input: {
    partyId: string;
    leaderSteamId: string;
    mode: GameMode;
  }): Promise<PartyTravelReservation | null>;
  validateJoinToken(input: {
    token: string;
    steamId: string;
    serverId: string;
  }): Promise<JoinTokenValidation>;
  recordMatchReward(input: MatchRewardInput): Promise<PlayerProfile | null>;
  getLeaderboard(options: { limit: number; mode?: GameMode }): Promise<LeaderboardEntry[]>;
  upsertShopItem(input: UpsertShopItemInput): Promise<ShopItem>;
  recordAuditEvent(input: {
    actorSteamId: string;
    action: string;
    targetSteamId?: string | null;
    reason: string;
  }): Promise<AuditEvent>;
  listAuditEvents(options: { limit: number }): Promise<AuditEvent[]>;

  // Script packages
  listScriptPackages(): Promise<ScriptPackage[]>;
  getScriptPackage(packageId: string): Promise<ScriptPackage | null>;
  listScriptPackageFiles(packageId: string): Promise<ScriptPackageFile[]>;
  upsertScriptPackage(input: UpsertScriptPackageInput): Promise<ScriptPackage>;
  upsertScriptPackageFile(input: UpsertScriptPackageFileInput): Promise<ScriptPackageFile>;
  setScriptPackageEnabled(packageId: string, enabled: boolean): Promise<ScriptPackage | null>;
}
