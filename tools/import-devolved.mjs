#!/usr/bin/env node
// import-devolved.mjs — parse the Garry's Mod Lua registries in devolvedttt
// and emit a single JSON content file for the OpenVibe backend seed.
//
// Pure Node, no deps. Deterministic and re-runnable (overwrites output).
// Never modifies anything under devolvedttt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.resolve(__dirname, '..', '..', 'devolvedttt');
const AUTORUN = path.join(DEV_ROOT, 'lua', 'autorun');
const OUT_DIR = path.resolve(__dirname, '..', 'backend', 'seed');
const OUT_FILE = path.join(OUT_DIR, 'devolved-content.json');

// ---------------------------------------------------------------------------
// Low-level Lua scanning helpers.
// All scanning happens over `clean` (comments blanked with spaces, same
// length/offsets as `orig`), so raw source spans (function bodies) can be
// extracted from `orig` using identical offsets.
// ---------------------------------------------------------------------------

const normalize = (s) => s.replace(/\r\n?/g, '\n');

/** Skip a short Lua string starting at src[i] (a quote). Returns index after
 * the closing quote. Tolerates unterminated strings by stopping at newline. */
function skipShortString(src, i) {
  const q = src[i];
  let p = i + 1;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\') { p += 2; continue; }
    if (c === q) return p + 1;
    if (c === '\n') return p; // unterminated; bail at line end
    p++;
  }
  return p;
}

/** Try to match a Lua long bracket [[...]] / [=[...]=] at src[i].
 * Returns {end, contentStart, contentEnd} or null. */
function longBracket(src, i) {
  if (src[i] !== '[') return null;
  let j = i + 1;
  while (src[j] === '=') j++;
  if (src[j] !== '[') return null;
  const level = j - i - 1;
  const close = ']' + '='.repeat(level) + ']';
  let contentStart = j + 1;
  if (src[contentStart] === '\n') contentStart++; // Lua skips a leading newline
  const idx = src.indexOf(close, j + 1);
  if (idx < 0) return { end: src.length, contentStart, contentEnd: src.length };
  return { end: idx + close.length, contentStart, contentEnd: idx };
}

/** Blank out Lua/GLua comments (--, --[[ ]], // and C-style block comments)
 * with spaces, preserving newlines and all offsets. Strings are left intact. */
function stripComments(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipShortString(src, i); continue; }
    if (c === '[') { const m = longBracket(src, i); if (m) { i = m.end; continue; } i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const m = longBracket(src, i + 2);
      let end;
      if (m) end = m.end;
      else { end = src.indexOf('\n', i); if (end < 0) end = n; }
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i); if (end < 0) end = n;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let end = src.indexOf('*/', i + 2); end = end < 0 ? n : end + 2;
      blank(i, end); i = end; continue;
    }
    i++;
  }
  return out.join('');
}

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
function skipWs(s, i) { while (i < s.length && isWs(s[i])) i++; return i; }

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

const KW_OPEN = new Set(['function', 'if', 'do']);

/** Given clean text and an index at/just before a `function` keyword, skip the
 * whole function block (balanced `function/if/do` ... `end`).
 * Returns index just after the matching `end`. */
function skipFunctionBlock(clean, i) {
  let depth = 0;
  let started = false;
  let p = i;
  while (p < clean.length) {
    const c = clean[p];
    if (c === '"' || c === "'") { p = skipShortString(clean, p); continue; }
    if (c === '[') { const m = longBracket(clean, p); if (m) { p = m.end; continue; } p++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let q = p;
      while (q < clean.length && /[A-Za-z0-9_]/.test(clean[q])) q++;
      const w = clean.slice(p, q);
      const prev = p > 0 ? clean[p - 1] : '';
      const isKeywordPos = prev !== '.' && prev !== ':';
      if (isKeywordPos && KW_OPEN.has(w)) { depth++; started = true; }
      else if (isKeywordPos && w === 'end') {
        depth--;
        if (started && depth === 0) return q;
      }
      p = q; continue;
    }
    p++;
  }
  throw new Error('unterminated function block');
}

/** Skip a balanced (...) group starting at clean[i] === '('. String-aware. */
function skipBalanced(clean, i) {
  let depth = 0;
  let p = i;
  while (p < clean.length) {
    const c = clean[p];
    if (c === '"' || c === "'") { p = skipShortString(clean, p); continue; }
    if (c === '[') { const m = longBracket(clean, p); if (m) { p = m.end; continue; } }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return p + 1; }
    p++;
  }
  throw new Error('unbalanced parentheses');
}

function decodeLuaString(raw) {
  // raw includes the surrounding quotes
  const q = raw[0];
  let out = '';
  for (let i = 1; i < raw.length - (raw[raw.length - 1] === q ? 1 : 0); i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const d = raw[++i];
    switch (d) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '\n': out += '\n'; break;
      default:
        if (/[0-9]/.test(d)) {
          let num = d;
          while (num.length < 3 && /[0-9]/.test(raw[i + 1] || '')) num += raw[++i];
          out += String.fromCharCode(parseInt(num, 10));
        } else out += d;
    }
  }
  return out;
}

// Sentinel wrappers for non-JSON Lua values
const FN = Symbol('fn');
const IDENT = Symbol('ident');
const RAW = Symbol('raw');
const isFn = (v) => Boolean(v && typeof v === 'object' && v.__kind === FN);
const isIdent = (v) => Boolean(v && typeof v === 'object' && v.__kind === IDENT);
const isRaw = (v) => Boolean(v && typeof v === 'object' && v.__kind === RAW);

/**
 * Parse one Lua value expression starting at clean[i].
 * env: Map of dotted identifier path -> previously assigned value.
 * Returns { val, end }.
 */
function parseValue(clean, orig, i, env) {
  i = skipWs(clean, i);
  if (i >= clean.length) throw new Error('unexpected end of file while reading value');
  const c = clean[i];

  let primary;
  if (c === '"' || c === "'") {
    const end = skipShortString(clean, i);
    primary = { val: decodeLuaString(orig.slice(i, end)), end };
  } else if (c === '[') {
    const m = longBracket(clean, i);
    if (!m) throw new Error(`unexpected '[' at value position`);
    primary = { val: orig.slice(m.contentStart, m.contentEnd), end: m.end };
  } else if (c === '{') {
    primary = parseTable(clean, orig, i, env);
  } else if (c === '-' || c === '.' || /[0-9]/.test(c)) {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(clean.slice(i, i + 40));
    if (!m) throw new Error(`cannot parse number at "${clean.slice(i, i + 20)}"`);
    primary = { val: Number(m[0]), end: i + m[0].length };
  } else if (/[A-Za-z_]/.test(c)) {
    const wm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(clean.slice(i));
    const w = wm[0];
    if (w === 'function') {
      const end = skipFunctionBlock(clean, i);
      primary = { val: { __kind: FN, src: orig.slice(i, end) }, end };
    } else if (w === 'true') primary = { val: true, end: i + 4 };
    else if (w === 'false') primary = { val: false, end: i + 5 };
    else if (w === 'nil') primary = { val: null, end: i + 3 };
    else {
      const pm = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(clean.slice(i));
      const name = pm[0];
      let end = i + name.length;
      const after = skipWs(clean, end);
      if (clean[after] === '(' || clean[after] === '{' || clean[after] === ':' ||
          clean[after] === '"' || clean[after] === "'") {
        // a call expression (or method call) used as a value — keep raw
        let p = after;
        if (clean[p] === ':') { // method: consume name then args
          const mm = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(clean.slice(p));
          p = skipWs(clean, p + mm[0].length);
        }
        if (clean[p] === '(') p = skipBalanced(clean, p);
        else if (clean[p] === '{') p = skipBalancedBrace(clean, p);
        else if (clean[p] === '"' || clean[p] === "'") p = skipShortString(clean, p);
        primary = { val: { __kind: RAW, src: orig.slice(i, p).trim() }, end: p };
      } else if (env.has(name)) {
        primary = { val: env.get(name), end };
      } else if (name.includes('.') && env.has(name.split('.')[0])) {
        // field of a known (reset) local table that was never assigned -> nil
        primary = { val: null, end };
      } else {
        primary = { val: { __kind: IDENT, name }, end };
      }
    }
  } else {
    throw new Error(`cannot parse value at "${clean.slice(i, i + 25)}"`);
  }

  // handle string concatenation chains: a .. b .. c
  let p = skipWs(clean, primary.end);
  if (clean.startsWith('..', p) && clean[p + 2] !== '.') {
    const parts = [primary.val];
    let allStrings = typeof primary.val === 'string' || typeof primary.val === 'number';
    let startAt = primary.end;
    while (clean.startsWith('..', p) && clean[p + 2] !== '.') {
      const next = parseValue(clean, orig, p + 2, env);
      parts.push(next.val);
      if (!(typeof next.val === 'string' || typeof next.val === 'number')) allStrings = false;
      startAt = next.end;
      p = skipWs(clean, startAt);
    }
    if (allStrings) return { val: parts.join(''), end: startAt };
    return { val: { __kind: RAW, src: orig.slice(i, startAt).trim() }, end: startAt };
  }
  return primary;
}

function skipBalancedBrace(clean, i) {
  // same as skipBalanced but entry char is '{'
  return skipBalanced(clean, i);
}

/** Parse a Lua table constructor at clean[i] === '{'.
 * Produces an array when all keys are positional/numeric, else a plain object. */
function parseTable(clean, orig, i, env) {
  let p = i + 1;
  const entries = [];
  let nextIndex = 1;
  for (;;) {
    p = skipWs(clean, p);
    if (p >= clean.length) throw new Error('unterminated table constructor');
    const c = clean[p];
    if (c === ',' || c === ';') { p++; continue; }
    if (c === '}') { p++; break; }
    if (c === '[') {
      const key = parseValue(clean, orig, p + 1, env);
      let q = skipWs(clean, key.end);
      if (clean[q] !== ']') throw new Error(`expected ']' in table key`);
      q = skipWs(clean, q + 1);
      if (clean[q] !== '=') throw new Error(`expected '=' after table key`);
      const v = parseValue(clean, orig, q + 1, env);
      entries.push({ key: key.val, val: v.val });
      p = v.end; continue;
    }
    const km = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(clean.slice(p, p + 200));
    if (km) {
      const v = parseValue(clean, orig, p + km[0].length, env);
      entries.push({ key: km[1], val: v.val });
      p = v.end; continue;
    }
    const v = parseValue(clean, orig, p, env);
    entries.push({ key: nextIndex++, val: v.val });
    p = v.end;
  }

  const allNumeric = entries.every((e) => typeof e.key === 'number');
  if (allNumeric) {
    const sorted = entries.slice().sort((a, b) => a.key - b.key);
    return { val: sorted.map((e) => e.val), end: p };
  }
  const obj = {};
  for (const e of entries) obj[String(e.key)] = e.val;
  return { val: obj, end: p };
}

/** Count occurrences of any target call name followed by '(' in a clean slice
 * (used to prove zero silent drops in skipped regions). */
function countTargetOccurrences(cleanSlice, targets) {
  let count = 0;
  for (const t of targets) {
    const re = new RegExp(`(?<![A-Za-z0-9_.])${t.replace(/[.]/g, '\\.')}\\s*\\(`, 'g');
    count += (cleanSlice.match(re) || []).length;
  }
  return count;
}

/**
 * Scan one Lua file for top-level calls to the given target names.
 * Tracks simple `X = {}` / `X.Field = value` assignments so args like
 * `Item.Name` resolve. Function bodies are skipped wholesale.
 */
function scanFile(file, targets) {
  const relFile = path.relative(DEV_ROOT, file);
  const orig = normalize(fs.readFileSync(file, 'utf8'));
  const clean = stripComments(orig);
  const env = new Map();
  const calls = [];
  const skipped = [];
  let nested = 0; // target-call occurrences inside skipped function bodies / non-target call args
  const rawCount = countTargetOccurrences(clean, targets);

  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (isWs(c)) { i++; continue; }
    if (c === '"' || c === "'") { i = skipShortString(clean, i); continue; }
    if (c === '[') { const m = longBracket(clean, i); i = m ? m.end : i + 1; continue; }
    if (!/[A-Za-z_]/.test(c)) { i++; continue; }

    const m = /^(local[ \t]+)?([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)/.exec(clean.slice(i));
    const word = m[2];
    const wordStart = i + (m[1] ? m[1].length : 0);
    let j = i + m[0].length;

    if (word === 'function' || word.startsWith('function.')) {
      const end = skipFunctionBlock(clean, wordStart);
      nested += countTargetOccurrences(clean.slice(wordStart, end), targets);
      i = end; continue;
    }
    // `local function foo(...)`
    if (m[1] && word === 'function') { /* covered above */ }

    const j2 = skipWs(clean, j);
    if (clean[j2] === '(') {
      if (targets.has(word)) {
        const line = lineOf(orig, i);
        try {
          const { args, end } = parseArgs(clean, orig, j2, env);
          calls.push({ fn: word, args, file: relFile, line });
          i = end; continue;
        } catch (e) {
          skipped.push({ file: relFile, line, call: word, reason: e.message });
          try { i = skipBalanced(clean, j2); } catch { i = clean.length; }
          continue;
        }
      }
      const end = skipBalanced(clean, j2);
      nested += countTargetOccurrences(clean.slice(j2, end), targets);
      i = end; continue;
    }
    if (clean[j2] === '=' && clean[j2 + 1] !== '=' && !word.includes(':')) {
      try {
        const v = parseValue(clean, orig, j2 + 1, env);
        if (Array.isArray(v.val) && v.val.length === 0 && !word.includes('.')) {
          // `local X = {}` resets any previous X.* fields
          for (const k of [...env.keys()]) if (k === word || k.startsWith(word + '.')) env.delete(k);
        }
        env.set(word, v.val);
        i = v.end; continue;
      } catch {
        i = j2 + 1; continue;
      }
    }
    i = j; continue;
  }

  return { calls, skipped, nested, rawCount, relFile };
}

function parseArgs(clean, orig, i, env) {
  // i at '('
  let p = skipWs(clean, i + 1);
  const args = [];
  if (clean[p] === ')') return { args, end: p + 1 };
  for (;;) {
    const v = parseValue(clean, orig, p, env);
    args.push(v.val);
    p = skipWs(clean, v.end);
    if (clean[p] === ',') { p = skipWs(clean, p + 1); if (clean[p] === ')') { p++; break; } continue; }
    if (clean[p] === ')') { p++; break; }
    throw new Error(`expected ',' or ')' in argument list, got "${clean.slice(p, p + 15)}"`);
  }
  return { args, end: p };
}

// ---------------------------------------------------------------------------
// Coercion helpers (arg -> JSON field)
// ---------------------------------------------------------------------------

function asStr(v, what) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === null || v === undefined) return null;
  throw new Error(`${what}: expected string, got ${describe(v)}`);
}
function asNum(v, what) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return null;
  throw new Error(`${what}: expected number, got ${describe(v)}`);
}
function asBool(v) { return !(v === null || v === undefined || v === false); }
function describe(v) {
  if (isFn(v)) return 'function';
  if (isIdent(v)) return `identifier ${v.name}`;
  if (isRaw(v)) return `expression ${JSON.stringify(v.src.slice(0, 40))}`;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Category extraction
// ---------------------------------------------------------------------------

const warnings = [];
const skippedAll = [];
const scanStats = []; // per file-group accounting

function runScan(files, targets) {
  const all = [];
  let nested = 0, rawCount = 0;
  for (const f of files) {
    const r = scanFile(f, targets);
    all.push(...r.calls);
    skippedAll.push(...r.skipped);
    nested += r.nested;
    rawCount += r.rawCount;
  }
  scanStats.push({ targets: [...targets].join(','), files: files.length, rawCount, parsed: all.length, nested });
  if (all.length + nested + skippedCountFor(targets) !== rawCount) {
    warnings.push(`accounting mismatch for ${[...targets].join(',')}: raw=${rawCount} parsed=${all.length} nested=${nested} skipped=${skippedCountFor(targets)}`);
  }
  return all;
}
function skippedCountFor(targets) {
  return skippedAll.filter((s) => targets.has(s.call)).length;
}

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.lua')).sort()
    .map((f) => path.join(dir, f));
}

function dedupeById(list, category) {
  const map = new Map();
  for (const e of list) {
    if (map.has(e.id)) warnings.push(`${category}: duplicate id "${e.id}" (${e._src}); last definition wins (Lua overwrite semantics)`);
    map.set(e.id, e);
  }
  return [...map.values()];
}

const src = (c) => `${c.file}:${c.line}`;

// --- items + recipes (+ crosshair-derived items) ---------------------------
const itemsFile = path.join(AUTORUN, 'sh_items.lua');
const itemCalls = runScan([itemsFile], new Set(['Dev.AddItem', 'Dev.AddRecipe', 'Dev.AddCrosshair', 'Dev.AddFunRound']));

let items = [];
let recipes = [];
for (const c of itemCalls) {
  try {
    if (c.fn === 'Dev.AddItem') {
      const [name, mat, canUse, noTake, checkUse] = c.args;
      const it = {
        id: `item_${asStr(name, 'Name')}`,
        name: asStr(name, 'Name'),
        mat: asStr(mat, 'Mat'),
        usable: isFn(canUse),
        notake: asBool(noTake),
        _src: src(c),
      };
      if (isFn(canUse)) it.luaUse = canUse.src;
      if (isFn(checkUse)) { it.hasCheckUse = true; it.luaCheckUse = checkUse.src; }
      items.push(it);
    } else if (c.fn === 'Dev.AddRecipe') {
      const [name, recipe, gives] = c.args;
      recipes.push({
        id: `recipe_${asStr(name, 'name')}`,
        name: asStr(name, 'name'),
        recipe: (recipe || []).map((r) => asStr(r, 'recipe entry')),
        gives: (gives || []).map((g) => asStr(g, 'gives entry')),
        _src: src(c),
      });
      // Dev.AddRecipe internally calls Dev.AddItem("Recipe: "..name, "Devolved/recipe.png")
      items.push({
        id: `item_Recipe: ${asStr(name, 'name')}`,
        name: `Recipe: ${asStr(name, 'name')}`,
        mat: 'Devolved/recipe.png',
        usable: false,
        notake: false,
        derivedFrom: 'recipe',
        _src: src(c),
      });
    } else if (c.fn === 'Dev.AddCrosshair') {
      const [name, mat, w, h] = c.args;
      // Dev.AddCrosshair internally registers item "Crosshair: <name>" with a use function
      items.push({
        id: `item_Crosshair: ${asStr(name, 'name')}`,
        name: `Crosshair: ${asStr(name, 'name')}`,
        mat: asStr(mat, 'mat'),
        usable: true,
        notake: false,
        derivedFrom: 'crosshair',
        crosshair: { w: asNum(w, 'w'), h: asNum(h, 'h') },
        _src: src(c),
      });
    } else if (c.fn === 'Dev.AddFunRound') {
      const [name] = c.args;
      // Dev.AddFunRound internally registers item "Fun Round: <name>" with use + check functions
      items.push({
        id: `item_Fun Round: ${asStr(name, 'name')}`,
        name: `Fun Round: ${asStr(name, 'name')}`,
        mat: 'Devolved/item_funround.png',
        usable: true,
        notake: false,
        derivedFrom: 'funround',
        _src: src(c),
      });
    }
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
items = dedupeById(items, 'items');
recipes = dedupeById(recipes, 'recipes');

// --- crates -----------------------------------------------------------------
const crateCalls = runScan([path.join(AUTORUN, 'sh_crates.lua')], new Set(['Dev.AddCrate']));
let crates = [];
for (const c of crateCalls) {
  try {
    const [name, mat, itemsTbl, keyNeeded, maxDrop, hostname] = c.args;
    const drops = [];
    if (!Array.isArray(itemsTbl)) throw new Error(`Items: expected array table, got ${describe(itemsTbl)}`);
    for (const ent of itemsTbl) {
      if (!ent || typeof ent !== 'object') throw new Error(`crate item entry not a table: ${describe(ent)}`);
      const dn = asStr(ent.name, 'crate item name');
      const ch = ent.chance;
      if (typeof ch !== 'number') {
        warnings.push(`crate "${name}" (${src(c)}): item "${dn}" has non-numeric chance ${describe(ch)}`);
      }
      drops.push({ name: dn, chance: typeof ch === 'number' ? ch : null });
    }
    crates.push({
      id: `crate_${asStr(name, 'Name')}`,
      name: asStr(name, 'Name'),
      icon: asStr(mat, 'Mat'),
      key: keyNeeded === null || keyNeeded === undefined ? null : asStr(keyNeeded, 'KeyNeeded'),
      limited: typeof maxDrop === 'number' ? maxDrop : null,
      host: hostname === null || hostname === undefined ? null : asStr(hostname, 'Hostname'),
      items: drops,
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
crates = dedupeById(crates, 'crates');

// --- rares -------------------------------------------------------------------
const rareCalls = runScan([path.join(AUTORUN, 'sh_rares.lua')], new Set(['Dev_SH.AddRare']));
const rares = [];
for (const c of rareCalls) {
  try {
    const [name, chance, mdl, type, varArg, limited, noscratch] = c.args;
    let varOut;
    if (varArg === null || varArg === undefined) varOut = [];
    else if (Array.isArray(varArg)) varOut = varArg.map((v) => asStr(v, 'Var entry'));
    else varOut = [asStr(varArg, 'Var')];
    rares.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      chance: asNum(chance, 'Chance'),
      model: asStr(mdl, 'Mdl'),
      type: type === null || type === undefined ? null : asStr(type, 'Type'),
      var: varOut,
      limited: typeof limited === 'number' ? limited : null,
      noscratch: asBool(noscratch),
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}

// --- cades -------------------------------------------------------------------
const cadeCalls = runScan(
  [path.join(AUTORUN, 'sh_cades.lua'), ...listDir(path.join(AUTORUN, 'cades'))],
  new Set(['Dev_SH.AddCade'])
);
let cades = [];
for (const c of cadeCalls) {
  try {
    const [name, mdl, hp, cost, lvl, hidden] = c.args;
    cades.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      model: asStr(mdl, 'Mdl'),
      hp: asNum(hp, 'HP'),
      cost: asNum(cost, 'Cost'),
      lvl: asNum(lvl, 'Lvl'),
      hidden: asBool(hidden),
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
cades = dedupeById(cades, 'cades');

// --- permas ------------------------------------------------------------------
const permaCalls = runScan(
  [path.join(AUTORUN, 'sh_permabuys.lua'), ...listDir(path.join(AUTORUN, 'perma'))],
  new Set(['Dev_SH.AddPermaBuy'])
);
let permas = [];
for (const c of permaCalls) {
  try {
    const [name, type, icon, cost, klass, lvl, checkFunc, hidden] = c.args;
    const p = {
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      type: asStr(type, 'Type'),
      icon: asStr(icon, 'Icon'),
      cost: asNum(cost, 'Cost'),
      class: klass === null || klass === undefined ? null : asStr(klass, 'Class'),
      lvl: asNum(lvl, 'Lvl'),
      hidden: asBool(hidden),
      hasCheck: isFn(checkFunc),
      _src: src(c),
    };
    if (isFn(checkFunc)) p.luaCheck = checkFunc.src;
    permas.push(p);
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
permas = dedupeById(permas, 'permas');

// --- tiers --------------------------------------------------------------------
const tierCalls = runScan(
  [path.join(AUTORUN, 'sh_tiers.lua'), ...listDir(path.join(AUTORUN, 'tiers'))],
  new Set(['Dev_SH.AddTier'])
);
let tiers = [];
for (const c of tierCalls) {
  try {
    const [name, desc, amount, stat, cost] = c.args;
    tiers.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      desc: asStr(desc, 'Desc'),
      amount: asNum(amount, 'Amount'),
      stat: asStr(stat, 'Stat'),
      cost: asNum(cost, 'Cost'),
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
tiers = dedupeById(tiers, 'tiers');

// --- round buys -----------------------------------------------------------------
// signature (verified in sh_roundbuys.lua): AddRoundBuy(Name,Type,Icon,Cost,Class,Lvl)
const roundCalls = runScan(
  [path.join(AUTORUN, 'sh_roundbuys.lua'), ...listDir(path.join(AUTORUN, 'round'))],
  new Set(['Dev_SH.AddRoundBuy'])
);
const roundbuys = [];
for (const c of roundCalls) {
  try {
    const [name, type, icon, cost, klass, lvl] = c.args;
    const rb = {
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      type: asStr(type, 'Type'),
      icon: asStr(icon, 'Icon'),
      cost: asNum(cost, 'Cost'),
      // Type "func" round buys pass a Lua function as Class (e.g. ammo givers)
      class: isFn(klass) ? null : (klass === null || klass === undefined ? null : asStr(klass, 'Class')),
      lvl: asNum(lvl, 'Lvl'),
      _src: src(c),
    };
    if (isFn(klass)) { rb.hasFunc = true; rb.luaClass = klass.src; }
    roundbuys.push(rb);
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}

// --- spec weps -------------------------------------------------------------------
// signature (verified in sh_specweps.lua): AddSpecWep(Name,Class,Icon,Cost,Hidden)
const specCalls = runScan([path.join(AUTORUN, 'sh_specweps.lua')], new Set(['Dev_SH.AddSpecWep']));
let specweps = [];
for (const c of specCalls) {
  try {
    const [name, klass, icon, cost, hidden] = c.args;
    specweps.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      class: asStr(klass, 'Class'),
      icon: asStr(icon, 'Icon'),
      cost: asNum(cost, 'Cost'),
      hidden: asBool(hidden),
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
specweps = dedupeById(specweps, 'specweps');

// --- taunts ------------------------------------------------------------------------
// signature (verified in sh_taunts.lua): AddTaunt(Name,Animation,Length,OnStart,OnStop,Interactive)
const tauntCalls = runScan([path.join(AUTORUN, 'sh_taunts.lua')], new Set(['Dev.AddTaunt']));
let taunts = [];
for (const c of tauntCalls) {
  try {
    const [name, anim, len, onStart, onStop, interactive] = c.args;
    const t = {
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      anim: isIdent(anim) ? anim.name : anim, // ACT_* enum name or raw activity number
      length: typeof len === 'number' || typeof len === 'string' ? len : null,
      interactive: asBool(interactive),
      hasStart: isFn(onStart),
      hasStop: isFn(onStop),
      _src: src(c),
    };
    if (isFn(onStart)) t.luaStart = onStart.src;
    if (isFn(onStop)) t.luaStop = onStop.src;
    taunts.push(t);
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
taunts = dedupeById(taunts, 'taunts');

// --- cade materials -------------------------------------------------------------------
// signature (verified in sh_mats.lua): AddMat(Name,Mat,Cost)
const matCalls = runScan([path.join(AUTORUN, 'sh_mats.lua')], new Set(['Dev_SH.AddMat']));
let mats = [];
for (const c of matCalls) {
  try {
    const [name, mat, cost] = c.args;
    mats.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      mat: asStr(mat, 'Mat'),
      cost: asNum(cost, 'Cost'),
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
mats = dedupeById(mats, 'mats');

// --- quests ------------------------------------------------------------------------------
// signature (verified in server/sv_quests.lua):
// AddQuest(Name,NPCName,Icon,Description,Lvl,NeedBefore,NeedItems,NeedStats,Rewards,TimeStart,TimeEnd)
const questCalls = runScan(listDir(path.join(AUTORUN, 'quests')), new Set(['Dev_SH.AddQuest']));
const emptyToMap = (v) => (Array.isArray(v) && v.length === 0 ? {} : v);
let quests = [];
for (const c of questCalls) {
  try {
    const [name, npcName, icon, desc, lvl, needBefore, needItems, needStats, rewards, timeStart, timeEnd] = c.args;
    const rewardsOut = rewards && typeof rewards === 'object' && !Array.isArray(rewards) ? { ...rewards } : emptyToMap(rewards);
    if (rewardsOut && rewardsOut.items) rewardsOut.items = emptyToMap(rewardsOut.items);
    quests.push({
      id: asStr(name, 'Name'),
      name: asStr(name, 'Name'),
      npcName: asStr(npcName, 'NPCName'),
      icon: asStr(icon, 'Icon'),
      description: asStr(desc, 'Description'),
      lvl: asNum(lvl, 'Lvl'),
      needBefore: needBefore || [],
      needItems: emptyToMap(needItems || {}),
      needStats: Array.isArray(needStats) ? needStats : [],
      rewards: rewardsOut || {},
      timeStart: typeof timeStart === 'number' ? timeStart : null,
      timeEnd: typeof timeEnd === 'number' ? timeEnd : null,
      _src: src(c),
    });
  } catch (e) {
    skippedAll.push({ file: c.file, line: c.line, call: c.fn, reason: e.message });
  }
}
quests = dedupeById(quests, 'quests');

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------

const itemNames = new Set(items.map((i) => i.name));
for (const cr of crates) {
  if (cr.key && !itemNames.has(cr.key)) {
    warnings.push(`crate "${cr.name}" (${cr._src}) requires key "${cr.key}" which is not a registered inventory item`);
  }
}

// deep-check that nothing non-JSON leaked into the output
function assertJsonSafe(v, where) {
  if (v === null) return;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (Array.isArray(v)) { v.forEach((x, k) => assertJsonSafe(x, `${where}[${k}]`)); return; }
  if (t === 'object') {
    if (v.__kind) throw new Error(`non-JSON Lua value leaked at ${where}: ${describe(v)}`);
    for (const [k, x] of Object.entries(v)) assertJsonSafe(x, `${where}.${k}`);
    return;
  }
  throw new Error(`unexpected value type ${t} at ${where}`);
}

const output = {
  generatedFrom: 'devolvedttt',
  counts: {},
  items, recipes, crates, rares, cades, permas, tiers, roundbuys, specweps, taunts, mats, quests,
};
for (const key of ['items', 'recipes', 'crates', 'rares', 'cades', 'permas', 'tiers', 'roundbuys', 'specweps', 'taunts', 'mats', 'quests']) {
  output.counts[key] = output[key].length;
  assertJsonSafe(output[key], key);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`devolved importer — wrote ${OUT_FILE}`);
console.log('');
console.log('category    count');
console.log('---------   -----');
for (const [k, v] of Object.entries(output.counts)) {
  console.log(`${k.padEnd(11)} ${String(v).padStart(5)}`);
}
console.log('');
console.log('call accounting (raw = occurrences in source, nested = inside function defs / non-target call args, intentionally excluded):');
for (const s of scanStats) {
  console.log(`  ${s.targets.padEnd(20)} files=${String(s.files).padStart(3)}  raw=${String(s.rawCount).padStart(3)}  parsed=${String(s.parsed).padStart(3)}  nested=${s.nested}`);
}

console.log('');
if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log('WARNINGS: none');
}

console.log('');
if (skippedAll.length) {
  console.log(`SKIPPED (${skippedAll.length}) — registrations found but not parsed:`);
  for (const s of skippedAll) console.log(`  - ${s.file}:${s.line} ${s.call}: ${s.reason}`);
  process.exitCode = 1;
} else {
  console.log('SKIPPED: none (zero drops)');
}
