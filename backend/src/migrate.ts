import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openvibe:openvibe@127.0.0.1:5432/openvibe",
});

const migrations = ["001_init.sql"];

try {
  for (const migration of migrations) {
    const path = resolve(process.cwd(), "migrations", migration);
    const sql = await readFile(path, "utf8");
    await pool.query(sql);
    console.log(`[migrate] applied ${migration}`);
  }
} finally {
  await pool.end();
}
