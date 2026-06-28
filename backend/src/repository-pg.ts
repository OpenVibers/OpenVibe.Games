import { Pool } from "pg";
import {
  GameMode,
  GameServer,
  HeartbeatInput,
  InventoryItem,
  JoinTokenValidation,
  LeaderboardEntry,
  MatchRewardInput,
  OpenVibeRepository,
  Player,
  PlayerProfile,
  RegisterServerInput,
  ShopItem,
  TravelReservation,
  UpsertShopItemInput,
} from "./domain.js";
import { RepositoryError } from "./repository-memory.js";
import { nanoid } from "nanoid";

export class PgOpenVibeRepository implements OpenVibeRepository {
  constructor(private readonly pool: Pool) {}

  async upsertDevPlayer(input: { steamId: string; displayName: string }): Promise<PlayerProfile> {
    await this.pool.query(
      `
      INSERT INTO players (steam_id, display_name, currency_balance, equipped_model_id)
      VALUES ($1, $2, 250, 'model_rebel')
      ON CONFLICT (steam_id)
      DO UPDATE SET display_name = EXCLUDED.display_name,
                    updated_at = now()
      `,
      [input.steamId, input.displayName],
    );

    await this.pool.query(
      `
      INSERT INTO player_items (steam_id, item_id)
      VALUES ($1, 'model_rebel')
      ON CONFLICT DO NOTHING
      `,
      [input.steamId],
    );

    const profile = await this.getProfile(input.steamId);
    if (!profile) throw new RepositoryError("player_not_found", 404);
    return profile;
  }

  async getProfile(steamId: string): Promise<PlayerProfile | null> {
    const playerResult = await this.pool.query(
      `
      SELECT steam_id, display_name, currency_balance, xp, equipped_model_id, equipped_trail_id
      FROM players
      WHERE steam_id = $1
      `,
      [steamId],
    );

    if (playerResult.rowCount !== 1) return null;

    const inventoryResult = await this.pool.query(
      `
      SELECT si.item_id, si.item_type, si.display_name, si.description, si.asset_path, si.price, si.enabled, pi.acquired_at
      FROM player_items pi
      JOIN shop_items si ON si.item_id = pi.item_id
      WHERE pi.steam_id = $1
      ORDER BY si.item_type, si.display_name
      `,
      [steamId],
    );

    return {
      player: mapPlayer(playerResult.rows[0]),
      inventory: inventoryResult.rows.map(mapInventoryItem),
      shop: await this.listShop(),
    };
  }

  async listShop(): Promise<ShopItem[]> {
    const result = await this.pool.query(
      `
      SELECT item_id, item_type, display_name, description, asset_path, price, enabled
      FROM shop_items
      WHERE enabled = true
      ORDER BY item_type, price, display_name
      `,
    );

    return result.rows.map(mapShopItem);
  }

  async buyItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const itemResult = await client.query(
        `
        SELECT item_id, item_type, display_name, description, asset_path, price, enabled
        FROM shop_items
        WHERE item_id = $1
        `,
        [input.itemId],
      );

      if (itemResult.rowCount !== 1) throw new RepositoryError("item_not_found", 404);
      const item = mapShopItem(itemResult.rows[0]);
      if (!item.enabled) throw new RepositoryError("item_disabled", 409);

      const ownedResult = await client.query(
        `
        SELECT 1
        FROM player_items
        WHERE steam_id = $1 AND item_id = $2
        `,
        [input.steamId, input.itemId],
      );

      if (ownedResult.rowCount === 0) {
        const playerResult = await client.query(
          `
          SELECT currency_balance
          FROM players
          WHERE steam_id = $1
          FOR UPDATE
          `,
          [input.steamId],
        );

        if (playerResult.rowCount !== 1) throw new RepositoryError("player_not_found", 404);
        if (Number(playerResult.rows[0].currency_balance) < item.price) {
          throw new RepositoryError("insufficient_currency", 409);
        }

        await client.query(
          `
          UPDATE players
          SET currency_balance = currency_balance - $2,
              updated_at = now()
          WHERE steam_id = $1
          `,
          [input.steamId, item.price],
        );

        await client.query(
          `
          INSERT INTO player_items (steam_id, item_id)
          VALUES ($1, $2)
          `,
          [input.steamId, input.itemId],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const profile = await this.getProfile(input.steamId);
    if (!profile) throw new RepositoryError("player_not_found", 404);
    return profile;
  }

  async equipItem(input: { steamId: string; itemId: string }): Promise<PlayerProfile> {
    const itemResult = await this.pool.query(
      `
      SELECT si.item_id, si.item_type
      FROM player_items pi
      JOIN shop_items si ON si.item_id = pi.item_id
      WHERE pi.steam_id = $1 AND pi.item_id = $2
      `,
      [input.steamId, input.itemId],
    );

    if (itemResult.rowCount !== 1) throw new RepositoryError("item_not_owned", 403);

    const itemType = String(itemResult.rows[0].item_type);
    if (itemType === "player_model") {
      await this.pool.query(
        "UPDATE players SET equipped_model_id = $2, updated_at = now() WHERE steam_id = $1",
        [input.steamId, input.itemId],
      );
    } else if (itemType === "trail") {
      await this.pool.query(
        "UPDATE players SET equipped_trail_id = $2, updated_at = now() WHERE steam_id = $1",
        [input.steamId, input.itemId],
      );
    }

    const profile = await this.getProfile(input.steamId);
    if (!profile) throw new RepositoryError("player_not_found", 404);
    return profile;
  }

  async registerServer(input: RegisterServerInput): Promise<GameServer> {
    const result = await this.pool.query(
      `
      INSERT INTO game_servers (
        server_id, server_secret, mode, map_name, public_host, port,
        max_players, player_count, state, last_heartbeat
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,'open',now())
      ON CONFLICT (server_id)
      DO UPDATE SET
        server_secret = EXCLUDED.server_secret,
        mode = EXCLUDED.mode,
        map_name = EXCLUDED.map_name,
        public_host = EXCLUDED.public_host,
        port = EXCLUDED.port,
        max_players = EXCLUDED.max_players,
        state = 'open',
        last_heartbeat = now(),
        updated_at = now()
      RETURNING server_id, mode, map_name, public_host, port, max_players, player_count, state, last_heartbeat
      `,
      [
        input.serverId,
        input.serverSecret,
        input.mode,
        input.mapName,
        input.publicHost,
        input.port,
        input.maxPlayers,
      ],
    );

    return mapServer(result.rows[0]);
  }

  async heartbeat(input: HeartbeatInput): Promise<GameServer | null> {
    const result = await this.pool.query(
      `
      UPDATE game_servers
      SET map_name = $3,
          player_count = $4,
          max_players = $5,
          state = $6,
          last_heartbeat = now(),
          updated_at = now()
      WHERE server_id = $1 AND server_secret = $2
      RETURNING server_id, mode, map_name, public_host, port, max_players, player_count, state, last_heartbeat
      `,
      [
        input.serverId,
        input.serverSecret,
        input.mapName,
        input.playerCount,
        input.maxPlayers,
        input.state,
      ],
    );

    if (result.rowCount !== 1) return null;
    return mapServer(result.rows[0]);
  }

  async listServers(mode?: GameMode): Promise<GameServer[]> {
    const result = await this.pool.query(
      `
      SELECT server_id, mode, map_name, public_host, port, max_players, player_count, state, last_heartbeat
      FROM game_servers
      WHERE state IN ('open', 'full')
        AND last_heartbeat > now() - interval '60 seconds'
        AND ($1::text IS NULL OR mode = $1)
      ORDER BY mode, player_count DESC, last_heartbeat DESC
      `,
      [mode ?? null],
    );

    return result.rows.map(mapServer);
  }

  async reserveTravel(input: { steamId: string; mode: GameMode }): Promise<TravelReservation | null> {
    const playerResult = await this.pool.query("SELECT 1 FROM players WHERE steam_id = $1", [
      input.steamId,
    ]);
    if (playerResult.rowCount !== 1) throw new RepositoryError("player_not_found", 404);

    const serverResult = await this.pool.query(
      `
      SELECT server_id, public_host, port
      FROM game_servers
      WHERE mode = $1
        AND state = 'open'
        AND player_count < max_players
        AND last_heartbeat > now() - interval '60 seconds'
      ORDER BY player_count DESC, last_heartbeat DESC
      LIMIT 1
      `,
      [input.mode],
    );

    if (serverResult.rowCount !== 1) return null;

    const server = serverResult.rows[0];
    const token = nanoid(32);
    const tokenResult = await this.pool.query(
      `
      INSERT INTO join_tokens (token, steam_id, server_id, mode, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '90 seconds')
      RETURNING expires_at
      `,
      [token, input.steamId, server.server_id, input.mode],
    );

    return {
      mode: input.mode,
      serverId: String(server.server_id),
      connect: `${server.public_host}:${server.port}`,
      joinToken: token,
      expiresAt: new Date(tokenResult.rows[0].expires_at).toISOString(),
    };
  }

  async validateJoinToken(input: {
    token: string;
    steamId: string;
    serverId: string;
  }): Promise<JoinTokenValidation> {
    const result = await this.pool.query(
      `
      UPDATE join_tokens
      SET consumed_at = now()
      WHERE token = $1
        AND steam_id = $2
        AND server_id = $3
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING steam_id, server_id, mode
      `,
      [input.token, input.steamId, input.serverId],
    );

    if (result.rowCount !== 1) return { valid: false };

    return {
      valid: true,
      steamId: String(result.rows[0].steam_id),
      serverId: String(result.rows[0].server_id),
      mode: result.rows[0].mode,
    };
  }

  async recordMatchReward(input: MatchRewardInput): Promise<PlayerProfile | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const serverResult = await client.query(
        "SELECT 1 FROM game_servers WHERE server_id = $1 AND server_secret = $2",
        [input.serverId, input.serverSecret],
      );
      if (serverResult.rowCount !== 1) return null;

      const inserted = await client.query(
        `
        INSERT INTO match_results (
          match_id, server_id, steam_id, mode, reward_currency, reward_xp, stats
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (match_id, steam_id) DO NOTHING
        RETURNING result_id
        `,
        [
          input.matchId,
          input.serverId,
          input.steamId,
          input.mode,
          input.rewardCurrency,
          input.rewardXp,
          JSON.stringify(input.stats ?? {}),
        ],
      );

      if (inserted.rowCount === 1) {
        await client.query(
          `
          UPDATE players
          SET currency_balance = currency_balance + $2,
              xp = xp + $3,
              updated_at = now()
          WHERE steam_id = $1
          `,
          [input.steamId, input.rewardCurrency, input.rewardXp],
        );

        await client.query(
          `
          INSERT INTO currency_ledger (steam_id, delta, reason, idempotency_key)
          VALUES ($1, $2, 'match_reward', $3)
          ON CONFLICT DO NOTHING
          `,
          [input.steamId, input.rewardCurrency, `match:${input.matchId}:${input.steamId}`],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getProfile(input.steamId);
  }

  async getLeaderboard(options: { limit: number; mode?: GameMode }): Promise<LeaderboardEntry[]> {
    const result = await this.pool.query(
      `
      SELECT steam_id, display_name, xp, currency_balance
      FROM players
      ORDER BY xp DESC, currency_balance DESC
      LIMIT $1
      `,
      [options.limit],
    );

    return result.rows.map((row, i) => ({
      rank: i + 1,
      steamId: String(row.steam_id),
      displayName: String(row.display_name),
      xp: Number(row.xp),
      currencyBalance: Number(row.currency_balance),
    }));
  }

  async upsertShopItem(input: UpsertShopItemInput): Promise<ShopItem> {
    const result = await this.pool.query(
      `
      INSERT INTO shop_items (item_id, item_type, display_name, description, asset_path, price, enabled)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (item_id)
      DO UPDATE SET
        item_type    = EXCLUDED.item_type,
        display_name = EXCLUDED.display_name,
        description  = EXCLUDED.description,
        asset_path   = EXCLUDED.asset_path,
        price        = EXCLUDED.price,
        enabled      = EXCLUDED.enabled
      RETURNING item_id, item_type, display_name, description, asset_path, price, enabled
      `,
      [
        input.itemId,
        input.itemType,
        input.displayName,
        input.description,
        input.assetPath,
        input.price,
        input.enabled,
      ],
    );
    return mapShopItem(result.rows[0]);
  }
}

function mapPlayer(row: Record<string, unknown>): Player {
  return {
    steamId: String(row.steam_id),
    displayName: String(row.display_name),
    currencyBalance: Number(row.currency_balance),
    xp: Number(row.xp),
    equippedModelId: row.equipped_model_id ? String(row.equipped_model_id) : null,
    equippedTrailId: row.equipped_trail_id ? String(row.equipped_trail_id) : null,
  };
}

function mapShopItem(row: Record<string, unknown>): ShopItem {
  return {
    itemId: String(row.item_id),
    itemType: row.item_type as ShopItem["itemType"],
    displayName: String(row.display_name),
    description: String(row.description),
    assetPath: String(row.asset_path),
    price: Number(row.price),
    enabled: Boolean(row.enabled),
  };
}

function mapInventoryItem(row: Record<string, unknown>): InventoryItem {
  return {
    ...mapShopItem(row),
    acquiredAt: new Date(row.acquired_at as string | Date).toISOString(),
  };
}

function mapServer(row: Record<string, unknown>): GameServer {
  return {
    serverId: String(row.server_id),
    mode: row.mode as GameMode,
    mapName: String(row.map_name),
    publicHost: String(row.public_host),
    port: Number(row.port),
    maxPlayers: Number(row.max_players),
    playerCount: Number(row.player_count),
    state: row.state as GameServer["state"],
    lastHeartbeat: new Date(row.last_heartbeat as string | Date).toISOString(),
  };
}
