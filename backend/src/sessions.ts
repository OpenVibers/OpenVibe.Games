import { nanoid } from "nanoid";
import { Redis } from "ioredis";

export interface SessionInput {
  token: string;
  steamId: string;
  provider: "dev" | "steam";
  ttlSeconds: number;
}

export interface SessionData {
  steamId: string;
  provider: "dev" | "steam";
  createdAt: string;
}

export interface OpenVibeSessionStore {
  createSession(input: SessionInput): Promise<void>;
  getSession?(token: string): Promise<SessionData | null>;
  close?(): Promise<void>;
}

export async function createSessionToken(
  store: OpenVibeSessionStore | undefined,
  provider: "dev" | "steam",
  steamId: string,
): Promise<string> {
  const token = `${provider}.${steamId}.${nanoid(32)}`;

  if (store) {
    await store.createSession({
      token,
      steamId,
      provider,
      ttlSeconds: 60 * 60 * 24,
    });
  }

  return token;
}

export class RedisSessionStore implements OpenVibeSessionStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
  }

  async createSession(input: SessionInput): Promise<void> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }

    await this.redis.set(
      `openvibe:session:${input.token}`,
      JSON.stringify({
        steamId: input.steamId,
        provider: input.provider,
        createdAt: new Date().toISOString(),
      }),
      "EX",
      input.ttlSeconds,
    );
  }

  async getSession(token: string): Promise<SessionData | null> {
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }

    const raw = await this.redis.get(`openvibe:session:${token}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
