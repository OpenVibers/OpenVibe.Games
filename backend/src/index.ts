import "dotenv/config";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { PgOpenVibeRepository } from "./repository-pg.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openvibe:openvibe@127.0.0.1:5432/openvibe",
});

const app = await createApp({
  repository: new PgOpenVibeRepository(pool),
  devAuthEnabled: process.env.OPENVIBE_DEV_AUTH_ENABLED !== "false",
});

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host, port });
