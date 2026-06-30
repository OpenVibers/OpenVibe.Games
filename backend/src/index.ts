import "dotenv/config";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { PgOpenVibeRepository } from "./repository-pg.js";
import { RedisSessionStore } from "./sessions.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openvibe:openvibe@127.0.0.1:5432/openvibe",
});

const app = await createApp({
  repository: new PgOpenVibeRepository(pool),
  devAuthEnabled: process.env.OPENVIBE_DEV_AUTH_ENABLED !== "false",
  sessionStore: process.env.SESSION_REDIS_URL
    ? new RedisSessionStore(process.env.SESSION_REDIS_URL)
    : undefined,
});

// Serve the in-game web client from the repo-root client/ directory.
const clientRoot = resolve(__dirname, "../../client");
await app.register(fastifyStatic, {
  root: clientRoot,
  prefix: "/client/",
  decorateReply: false,
});

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host, port });
