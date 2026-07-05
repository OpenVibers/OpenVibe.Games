#!/usr/bin/env node
// Copies the Devolved economy .png icons referenced by the backend seed
// (backend/seed/devolved-content.json — every `mat`/`icon` field ending in
// .png) out of the original GMod addon's materials/ tree into
// client/assets/devolved/, preserving the relative material path lowercased.
//
// Source paths in the defs are relative material paths ("Devolved/x.png",
// "vgui/crates/y.png") with unreliable casing, so each is resolved against
// /home/workstation/src/devolvedttt/materials case-insensitively.
//
// Usage: node tools/copy-devolved-icons.mjs [--materials <dir>]

import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const seedPath = join(root, 'backend', 'seed', 'devolved-content.json');
const outRoot = join(root, 'client', 'assets', 'devolved');

const argIdx = process.argv.indexOf('--materials');
const materialsRoot = argIdx !== -1
  ? resolve(process.argv[argIdx + 1])
  : '/home/workstation/src/devolvedttt/materials';

if (!existsSync(materialsRoot)) {
  console.error(`[copy-devolved-icons] materials dir not found: ${materialsRoot}`);
  process.exit(1);
}

// ── Collect every mat/icon *.png path from the seed ────────────────────────
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const wanted = new Set();
(function walk(node) {
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'mat' || k === 'icon') && typeof v === 'string' && /\.png$/i.test(v)) {
        wanted.add(v.replace(/\\/g, '/').replace(/^\/+/, ''));
      } else {
        walk(v);
      }
    }
  }
})(seed);

// ── Case-insensitive resolver against the materials tree ───────────────────
const dirCache = new Map(); // dir → Map(lowername → realname)
function listing(dir) {
  let m = dirCache.get(dir);
  if (m === undefined) {
    m = null;
    try {
      m = new Map(readdirSync(dir).map((n) => [n.toLowerCase(), n]));
    } catch { /* not a dir */ }
    dirCache.set(dir, m);
  }
  return m;
}

function resolveInsensitive(relPath) {
  // Defs sometimes carry a leading "materials/" — strip it.
  const parts = relPath.replace(/^materials\//i, '').split('/').filter(Boolean);
  let dir = materialsRoot;
  for (let i = 0; i < parts.length; i++) {
    const m = listing(dir);
    if (!m) return null;
    const real = m.get(parts[i].toLowerCase());
    if (!real) return null;
    dir = join(dir, real);
  }
  return dir;
}

// ── Copy ────────────────────────────────────────────────────────────────────
let copied = 0;
const missing = [];
for (const rel of [...wanted].sort()) {
  const src = resolveInsensitive(rel);
  if (!src) { missing.push(rel); continue; }
  const destRel = rel.replace(/^materials\//i, '').toLowerCase();
  const dest = join(outRoot, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied += 1;
}

console.log(`[copy-devolved-icons] referenced .png icons: ${wanted.size}`);
console.log(`[copy-devolved-icons] copied:  ${copied} → ${outRoot}`);
console.log(`[copy-devolved-icons] missing: ${missing.length}`);
for (const rel of missing) console.log(`  missing ${rel}`);
