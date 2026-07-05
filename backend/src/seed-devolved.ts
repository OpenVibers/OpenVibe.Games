// Loads backend/seed/devolved-content.json (produced by
// tools/import-devolved.mjs from the original devolvedttt Lua) and maps it to
// econ_defs rows. Runs at server boot (index.ts) and as a CLI:
//   npm run seed:devolved
import { readFileSync, existsSync } from "fs";
import { EconDef, EconKind } from "./economy.js";

interface RawEntry {
  id?: string;
  name: string;
  icon?: string;
  mat?: string;
  [key: string]: unknown;
}

interface DevolvedContent {
  items?: RawEntry[];
  recipes?: RawEntry[];
  crates?: RawEntry[];
  rares?: RawEntry[];
  cades?: RawEntry[];
  permas?: RawEntry[];
  tiers?: RawEntry[];
  roundbuys?: RawEntry[];
  specweps?: RawEntry[];
  taunts?: RawEntry[];
  mats?: RawEntry[];
  quests?: RawEntry[];
}

const META_DROP_KEYS = new Set(["id", "name", "icon", "luaUse", "luaCheck"]);

function toDef(entry: RawEntry, kind: EconKind, defId: string, icon: string): EconDef {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (META_DROP_KEYS.has(key) || value === undefined) continue;
    meta[key] = value;
  }
  return { defId, kind, displayName: entry.name, icon, meta, enabled: true };
}

export function loadDevolvedDefs(jsonPath: string): { defs: EconDef[]; skippedDuplicates: string[] } {
  const content = JSON.parse(readFileSync(jsonPath, "utf8")) as DevolvedContent;
  const defs: EconDef[] = [];
  const seen = new Set<string>();
  const skippedDuplicates: string[] = [];

  const push = (def: EconDef) => {
    if (seen.has(def.defId)) {
      skippedDuplicates.push(def.defId);
      return;
    }
    seen.add(def.defId);
    defs.push(def);
  };

  // Inventory-holdable defs keep the original devolved inventory ids.
  for (const entry of content.items ?? []) {
    push(toDef(entry, "item", entry.id ?? `item_${entry.name}`, String(entry.mat ?? entry.icon ?? "")));
  }
  for (const entry of content.crates ?? []) {
    push(toDef(entry, "crate", entry.id ?? `crate_${entry.name}`, String(entry.icon ?? entry.mat ?? "")));
  }
  for (const entry of content.rares ?? []) {
    push(toDef(entry, "rare", entry.id ?? entry.name, String(entry.model ?? entry.icon ?? "")));
  }

  // Registry defs are namespaced "<kind>:<Name>".
  const registries: Array<[keyof DevolvedContent, EconKind]> = [
    ["cades", "cade"],
    ["permas", "perma"],
    ["tiers", "tier"],
    ["roundbuys", "roundbuy"],
    ["specweps", "specwep"],
    ["taunts", "taunt"],
    ["mats", "mat"],
    ["recipes", "recipe"],
    ["quests", "quest"],
  ];
  for (const [category, kind] of registries) {
    for (const entry of content[category] ?? []) {
      push(toDef(entry, kind, `${kind}:${entry.name}`, String(entry.icon ?? entry.mat ?? "")));
    }
  }

  return { defs, skippedDuplicates };
}

export function findSeedFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// CLI entry: tsx src/seed-devolved.ts [path/to/devolved-content.json]
if (process.argv[1] && process.argv[1].endsWith("seed-devolved.ts")) {
  const { Pool } = await import("pg");
  const { PgEconomyRepository } = await import("./economy-repository-pg.js");
  const { config } = await import("dotenv");
  config();

  const jsonPath = process.argv[2] ?? new URL("../seed/devolved-content.json", import.meta.url).pathname;
  const { defs, skippedDuplicates } = loadDevolvedDefs(jsonPath);
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://openvibe:openvibe@127.0.0.1:5432/openvibe",
  });
  const repo = new PgEconomyRepository(pool);
  await repo.upsertDefs(defs);
  console.log(`[seed-devolved] upserted ${defs.length} defs from ${jsonPath}`);
  if (skippedDuplicates.length > 0) {
    console.warn(`[seed-devolved] skipped ${skippedDuplicates.length} duplicate ids:`, skippedDuplicates.slice(0, 20));
  }
  await pool.end();
}
