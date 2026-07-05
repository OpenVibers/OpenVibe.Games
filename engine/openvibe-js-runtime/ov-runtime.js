#!/usr/bin/env node
/**
 * OpenVibe.JS Node runtime host.
 *
 * Runs the GMod-style JavaScript framework in REAL Node.js — so gamemodes and
 * addons get the full npm ecosystem (including native modules) and true
 * hot-reload — bridged to the Source game DLLs over a line-delimited JSON TCP
 * socket. The DLLs stay thin: they forward engine events and apply commands;
 * all JS logic lives here.
 *
 * The host provides globalThis.OV + loads the SAME game/openvibe.games/js/*
 * files the (embedded) build uses, so the entire existing framework
 * (module/require, net, addon, timer, command, gamemodes) runs unchanged.
 *
 * Usage:
 *   node ov-runtime.js --realm server --mode sandbox --port 41999 --root <mod>
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- args ----
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REALM = arg('realm', 'server');           // "server" | "client"
const MODE = arg('mode', 'sandbox');
const PORT = Number(arg('port', REALM === 'client' ? 41998 : 41999));
const CTRL_PORT = Number(arg('ctrl-port', REALM === 'client' ? 41996 : 41997));
const ROOT = path.resolve(arg('root', path.join(__dirname, '..', '..')));
const MOD = path.join(ROOT, 'game', 'openvibe.games');
const JS = path.join(MOD, 'js');
const IS_SERVER = REALM === 'server';

// ---- log ring buffer + SSE fanout (consumed by the GUI console) ----
const LOG_RING_MAX = 500;
const logRing = [];
const sseClients = new Set();
let logSeq = 0;
function pushLog(level, text) {
  const entry = { seq: ++logSeq, t: Date.now(), level, text: String(text), realm: REALM };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { sseClients.delete(res); } }
}
function log(...a) { console.log(`[ov-runtime/${REALM}]`, ...a); pushLog('info', a.join(' ')); }
function warn(...a) { console.warn(`[ov-runtime/${REALM}] WARN`, ...a); pushLog('warn', a.join(' ')); }

// ---- IPC: one connected game client at a time ----
let sock = null;
let rxBuf = '';
function sendToGame(obj) {
  // Guard: console commands must survive the engine's CCommand::Tokenize
  // (512-byte string AND argv buffers — argv adds a NUL per token, and the
  // tokenizer splits on {}()':). Estimate argv usage and name the producer
  // loudly instead of letting the engine clamp it silently.
  if (obj && obj.t === 'concmd' && typeof obj.cmd === 'string') {
    const specials = (obj.cmd.match(/["'(){}:]/g) || []).length;
    if (obj.cmd.length >= 510 || obj.cmd.length + specials + 8 >= 510) {
      warn(`concmd too long for the engine (${obj.cmd.length} chars, ~${specials} token splits) — ` +
        `route it through OV.menuJS (auto-chunks) or chunk like net.js: ${obj.cmd.slice(0, 90)}...`);
    }
  }
  if (sock && !sock.destroyed) {
    try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) { warn('send failed', e.message); }
  }
}

// ---- the sandboxed JS world (same globals the embedded build provides) ----
let ctx = null;          // vm context (globalThis of the framework)
let watchers = [];       // fs watchers for hot-reload
let quietBoot = false;   // demote framework boot chatter during hot-reload re-bootstraps
let frameworkLoads = 0;

function modRel(p) {
  // Resolve a mod-relative path safely (no escaping MOD).
  const norm = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  return path.join(MOD, norm);
}

function buildOV() {
  // OV.* the js/core/* files expect, backed by Node + IPC.
  return {
    // During a hot-reload re-bootstrap the per-library "ready"/load chatter
    // (~25 lines) is demoted to the SSE debug stream — the console keeps one
    // "hot-reload:" + one "framework loaded" line. Warnings/errors stay loud.
    log: (m) => { if (quietBoot) { pushLog('debug', '[js] ' + m); return; } log('[js]', m); },
    warn: (m) => { warn('[js]', m); },
    error: (m) => { console.error(`[ov-runtime/${REALM}] [js ERROR]`, m); pushLog('error', String(m)); },
    isServer: () => IS_SERVER,
    getMode: () => MODE,
    getMapName: () => state.map,
    time: () => Date.now() / 1000,
    readFile: (p) => { try { return fs.readFileSync(modRel(p), 'utf8'); } catch { return null; } },
    fileExists: (p) => { try { fs.statSync(modRel(p)); return true; } catch { return false; } },
    listDir: (d /*, wildcard */) => { try { return fs.readdirSync(modRel(d)); } catch { return []; } },
    // Write access is jailed to the client download cache + data dir.
    writeFile: (p, content) => {
      const norm = path.normalize(String(p)).replace(/^([/\\]|\.\.)+/, '');
      if (!norm.startsWith(path.join('js', 'ov_downloads')) && !norm.startsWith('data')) {
        warn('writeFile blocked outside js/ov_downloads|data:', norm);
        return false;
      }
      try {
        const full = modRel(norm);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, String(content));
        return true;
      } catch (e) { warn('writeFile', e.message); return false; }
    },
    freeMem: () => {},
    players: () => Object.values(state.players).map(wrapPlayer),
    playerByUserId: (id) => state.players[id] ? wrapPlayer(state.players[id]) : null,
    localPlayer: () => (!IS_SERVER && state.localUserId != null && state.players[state.localUserId])
      ? wrapPlayer(state.players[state.localUserId]) : null,
    broadcast: (msg) => sendToGame({ t: 'chat', msg: String(msg) }),
    serverCommand: (cmd) => sendToGame({ t: 'concmd', cmd: String(cmd) }),
    netEmit: (idsCsv, name, payloadB64) => sendToGame({ t: 'net', ids: String(idsCsv), name: String(name), payload: String(payloadB64) }),
    netSendToServer: (name, payloadB64) => sendToGame({ t: 'net', toServer: true, name: String(name), payload: String(payloadB64) }),
    fireHook: (name, ...args) => { try { return ctx.hook.Run(name, ...args); } catch (e) { warn('fireHook', e.message); } },
    // Push JS into the in-game HTML panel (client realm): runs ov_menu_js.
    // The engine clamps console command lines at 512 chars (CCommand::Tokenize),
    // so oversized scripts are base64-chunked into an accumulator on the page
    // and eval'd by a final command. No semicolons anywhere (Cbuf splits on ;).
    //
    // The 512 budget is NOT just the string length: the tokenizer splits on
    // {}()': (and doesn't understand \" escapes), and CCommand's argv buffer
    // stores every token + a NUL — dense JSON overflows it well under 512 raw
    // chars. Single-shot only tiny scripts; the b64 chunk path is immune
    // (base64 contains none of the tokenizer's special characters).
    menuJS: (script) => {
      const s = String(script);
      const PREFIX = 'ov_menu_js ';
      const MAX_LINE = 220;
      if (PREFIX.length + s.length <= MAX_LINE && !s.includes(';')) {
        sendToGame({ t: 'concmd', cmd: PREFIX + s });
        return;
      }
      const b64 = Buffer.from(s, 'utf8').toString('base64');
      const CHUNK = 360;
      sendToGame({ t: 'concmd', cmd: PREFIX + 'window.__ovmjs=""' });
      for (let i = 0; i < b64.length; i += CHUNK) {
        sendToGame({ t: 'concmd', cmd: PREFIX + 'window.__ovmjs=window.__ovmjs+"' + b64.slice(i, i + CHUNK) + '"' });
      }
      // atob yields Latin-1 code units — escape/decodeURIComponent restores
      // proper UTF-8 (plain atob mangles any non-ASCII in HUD text).
      sendToGame({ t: 'concmd', cmd: PREFIX + 'eval(decodeURIComponent(escape(window.atob(window.__ovmjs))))' });
    },
    reward: () => {},
    endMatch: () => {},
  };
}

// Live game state mirrored from IPC events.
const state = { map: '', players: {} /* userId -> {userId,name,steamId,...} */, localUserId: null };
// Return a wrapped player, registering a minimal record if we haven't seen a
// full connect event yet (so chat replies / net handlers always have a target).
function ensurePlayer(userId, name) {
  if (userId == null || userId < 0) return null;
  if (!state.players[userId]) state.players[userId] = { userId, name: name || ('Player' + userId) };
  else if (name) state.players[userId].name = name;
  return wrapPlayer(state.players[userId]);
}
function wrapPlayer(p) {
  const native = {
    userId: () => p.userId, entIndex: () => p.entIndex || p.userId,
    steamId: () => p.steamId || '', name: () => p.name || ('Player' + p.userId),
    health: () => p.health || 100, setHealth: (v) => { p.health = v; sendToGame({ t: 'player', userId: p.userId, setHealth: v }); },
    team: () => p.team || 0, setTeam: (v) => { p.team = v; sendToGame({ t: 'player', userId: p.userId, setTeam: v }); },
    chat: (m) => sendToGame({ t: 'chat', userId: p.userId, msg: String(m) }),
    runCommand: (c) => sendToGame({ t: 'runcmd', userId: p.userId, cmd: String(c) }),
    getPos: () => p.pos || null,
    kill: () => sendToGame({ t: 'player', userId: p.userId, kill: true }),
  };
  // Upgrade to the framework Player class when loaded (gamemodes then get the
  // full GMod surface: Nick/SetTeam/ChatPrint/NW vars/...).
  if (ctx && ctx.Player && typeof ctx.Player.fromNative === 'function') {
    try { return ctx.Player.fromNative(native); } catch { /* fall through */ }
  }
  return native;
}

// Build the Node require npm + the addon loader use. Resolved from the mod's js
// dir so bare specifiers hit game/openvibe.games/node_modules (Node searches
// upward) — full npm incl. native modules.
// Bare specifiers that fail Node's walk-up resolution retry against the npm
// root: an addon under addons/<name>/ never walks up into js/node_modules, so
// without this only packages hand-copied next to addons/ would resolve. Keeps
// the package.json promise ("js/node_modules is require()-able from gamemodes,
// addons, and entities") true for freshly npm-installed deps too.
let resolveFallbackInstalled = false;
function installResolveFallback() {
  if (resolveFallbackInstalled) return;
  resolveFallbackInstalled = true;
  const Module = require('module');
  const orig = Module._resolveFilename;
  const npmRootPaths = [path.join(JS, 'node_modules')];
  Module._resolveFilename = function (request, parent, isMain, options) {
    try { return orig.call(this, request, parent, isMain, options); }
    catch (e) {
      if (typeof request === 'string' && request[0] !== '.' && request[0] !== '/' && !options) {
        try { return orig.call(this, request, parent, isMain, { paths: npmRootPaths }); } catch { /* rethrow original */ }
      }
      throw e;
    }
  };
}

function buildRequire() {
  installResolveFallback();
  const { createRequire } = require('module');
  const nodeRequire = createRequire(path.join(JS, 'runtime-require.js'));
  const ovRequire = function (spec) { return nodeRequire(spec); };
  ovRequire.__ovNodeNative = true; // module.js defers to this instead of clobbering
  ovRequire.load = function (modPath) {          // mod-root loader for addon.js
    const full = path.join(MOD, modPath);
    delete nodeRequire.cache[full];              // fresh each call (hot-reload)
    return nodeRequire(full);
  };
  ovRequire.reload = ovRequire.load;
  ovRequire.resolve = (s) => { try { return nodeRequire.resolve(s); } catch { return null; } };
  ovRequire.cache = nodeRequire.cache;
  return ovRequire;
}

// ---- addon/gamemode npm dependency sync (node backend only) ----
// addons/<name>/addon.json and js/gamemodes/<name>/manifest.json may declare
//   "npm": { "nanoid": "^5", "ov-leftpad": "file:vendor/ov-leftpad" }
// At framework load we diff every declared dep against js/package.json +
// js/node_modules and batch-install ONLY what's missing via runNpm (execFile
// arg array — never a shell). Install is non-blocking: the realm keeps
// loading, and runNpm's post-install reload re-resolves the new packages.
// file: ranges resolve relative to js/ (the npm root, runNpm's cwd).
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_RANGE_RE = /^[-a-zA-Z0-9^~><=. *|&_@/:!]+$/;
// What runNpm's per-arg filter accepts — anything else would be silently
// dropped from the argv (yielding a bare `npm install`), so refuse it here.
const NPM_ARG_SAFE_RE = /^[-@a-zA-Z0-9._/^~:]+$/;
const npmDepsAttempted = new Set(); // specs already tried this process (no retry loops on failure)
let npmDepsLastSig = '';            // last logged "all satisfied" dep set

function collectDeclaredNpmDeps() {
  const deps = Object.create(null); // name -> { range, from }
  const scanManifest = (file, label) => {
    let m;
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!m || typeof m.npm !== 'object' || m.npm === null || Array.isArray(m.npm)) return;
    for (const [name, range] of Object.entries(m.npm)) {
      if (typeof range !== 'string' || name.length > 214 || !NPM_NAME_RE.test(name) ||
          range.length > 128 || !NPM_RANGE_RE.test(range) ||
          (range.startsWith('file:') && range.includes('..'))) {
        warn(`npm-deps: refusing invalid dep "${name}": "${range}" (${label})`);
        continue;
      }
      if (deps[name]) {
        if (deps[name].range !== range) {
          warn(`npm-deps: conflicting ranges for ${name}: "${deps[name].range}" (${deps[name].from}) vs "${range}" (${label}) — keeping the first`);
        }
        continue;
      }
      deps[name] = { range, from: label };
    }
  };
  const scanDir = (base, manifestName) => {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const f = path.join(base, e.name, manifestName);
      if (fs.existsSync(f)) scanManifest(f, path.relative(MOD, f));
    }
  };
  scanDir(path.join(MOD, 'addons'), 'addon.json');
  scanDir(path.join(JS, 'gamemodes'), 'manifest.json');
  return deps;
}

function syncDeclaredNpmDeps() {
  let declared;
  try { declared = collectDeclaredNpmDeps(); } catch (e) { warn('npm-deps: scan failed:', e.message); return; }
  const names = Object.keys(declared);
  if (!names.length) return;
  let pkgDeps = {};
  try { pkgDeps = JSON.parse(fs.readFileSync(path.join(JS, 'package.json'), 'utf8')).dependencies || {}; } catch { /* no npm root manifest */ }
  const missing = [];
  for (const name of names) {
    // Satisfied = actually installed (require() will resolve it). package.json
    // alone isn't enough — a listed-but-uninstalled dep still needs the install.
    const installed = fs.existsSync(path.join(JS, 'node_modules', ...name.split('/'), 'package.json'));
    if (installed && pkgDeps[name] !== undefined) continue;
    if (installed) continue; // resolvable already; don't churn package.json
    const spec = `${name}@${declared[name].range}`;
    if (npmDepsAttempted.has(spec)) continue; // already tried (in flight or failed)
    if (!NPM_ARG_SAFE_RE.test(spec)) {
      warn(`npm-deps: spec not safely passable to npm, skipping: ${spec} (${declared[name].from})`);
      npmDepsAttempted.add(spec);
      continue;
    }
    missing.push(spec);
  }
  if (!missing.length) {
    const sig = names.slice().sort().join(', ');
    if (sig !== npmDepsLastSig) {
      npmDepsLastSig = sig;
      log(`npm-deps: ${names.length} declared dep(s) satisfied (${sig})`);
    }
    return;
  }
  if (npmBusy) return; // an install is running; its post-install reload re-checks
  for (const s of missing) npmDepsAttempted.add(s);
  log(`npm-deps: installing ${missing.length} missing dep(s): ${missing.join(' ')}`);
  runNpm(['install', ...missing], (r) => {
    if (r.ok) log(`npm-deps: install finished (${missing.length} dep(s)) — framework reloaded`);
    else warn(`npm-deps: install failed — realm continues without: ${r.error}`);
  });
}

// ---- (re)load the framework in Node's MAIN global context ----
// Everything (framework core, gamemodes, addons via require, npm) shares one
// real global so OV/hook/require are visible everywhere — unlike a vm sandbox,
// whose globals Node's require() cannot see.
function loadFramework() {
  // Re-bootstraps (hot-reload, game hello, post-npm) demote per-library boot
  // chatter; the very first load stays verbose.
  quietBoot = frameworkLoads++ > 0;
  try { loadFrameworkInner(); } finally { quietBoot = false; }
  // Node backend only: addon/gamemode manifests may declare npm deps —
  // install whatever is missing in the background (non-blocking, never fatal).
  try { syncDeclaredNpmDeps(); } catch (e) { warn('npm-deps:', e.message); }
}

function loadFrameworkInner() {
  // Clear framework globals so re-eval redefines them (core files guard against
  // re-init, which would otherwise no-op a hot-reload).
  for (const g of ['hook', 'gamemode', 'GM', 'GAMEMODE', 'net', 'util', 'command', 'concommand',
    'timer', 'Addon', 'module', 'OVSandbox', 'Entity', 'Player', 'player', 'ents',
    'scripted_ents', 'file', 'OVLoader', 'include', 'AddCSJSFile', 'AddCSLuaFile',
    'SERVER', 'CLIENT', 'MENU', 'NULL', 'LocalPlayer', 'RunConsoleCommand',
    'DeriveGamemode', 'baseclass', 'IsValid', 'CurTime', 'ENT']) {
    try { delete global[g]; } catch {}
  }
  global.OV = buildOV();
  global.require = buildRequire();

  // Core files in the same order the embedded C++ loader uses; bridge.js
  // bootstraps the remaining core libraries (realm/util/net/entity/ents/
  // player/file/concommand/addon/loader).
  const order = ['core/hook.js', 'core/gamemode.js', 'bridge.js', 'core/command.js', 'core/timer.js'];
  for (const f of order) {
    const full = path.join(JS, f);
    if (!fs.existsSync(full)) continue;
    try { vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: f }); }
    catch (e) { warn(`load ${f}: ${e.message}`); }
  }
  ctx = global;

  // GMod loading order: autorun -> gamemode chain -> entities -> addons.
  if (ctx.OVLoader && typeof ctx.OVLoader.loadAll === 'function') {
    try { ctx.OVLoader.loadAll({ mode: MODE }); }
    catch (e) { warn('OVLoader.loadAll:', e.message); }
  } else {
    // Fallback for a stripped js/ tree (old layout).
    for (const f of ['gamemodes/base/server.js', `gamemodes/${MODE}/shared.js`,
      `gamemodes/${MODE}/${IS_SERVER ? 'server' : 'client'}.js`]) {
      const full = path.join(JS, f);
      if (!fs.existsSync(full)) continue;
      try { vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: f }); }
      catch (e) { warn(`load ${f}: ${e.message}`); }
    }
  }
  log(`framework loaded (mode=${MODE}, realm=${REALM})`);
}

// ---- hot reload: watch js + addons, filter noise, debounce, reload ----
// Only real code/config changes re-bootstrap the realm: *.js / *.json, no
// dotfiles or dot-directories, no editor temp/backup files (extension-less
// scratch names like "XXT8vqwZ", trailing ~, .swp, .tmp, .bak, ...). A 500ms
// debounce collapses an editor save storm (write + rename + metadata, or an
// npm install touching hundreds of files) into ONE full re-bootstrap.
function isReloadWorthy(f) {
  if (!f) return false;                                     // unnamed events are watch noise
  const parts = String(f).split(/[\\/]/);
  for (const seg of parts) { if (seg.startsWith('.')) return false; }  // .git/, .addon.json.swp, ...
  const base = parts[parts.length - 1];
  if (/(~|\.(swp|swo|swx|tmp|bak|part|orig|new))$/i.test(base)) return false;
  return /\.(js|json)$/i.test(base);                        // drops README.md, LICENSE, "XXT8vqwZ", ...
}
function setupHotReload() {
  watchers.forEach((w) => { try { w.close(); } catch {} });
  watchers = [];
  let timer = null;
  let why = '';
  const trigger = (f) => {
    if (!isReloadWorthy(f)) return;
    why = String(f);
    clearTimeout(timer);
    timer = setTimeout(() => { log('hot-reload:', why); loadFramework(); fire('Initialize'); }, 500);
  };
  for (const dir of [JS, path.join(MOD, 'addons')]) {
    if (!fs.existsSync(dir)) continue;
    try { watchers.push(fs.watch(dir, { recursive: true }, (_e, f) => trigger(f))); }
    catch (e) { warn('watch failed', dir, e.message); }
  }
  log('hot-reload watching js/ + addons/ (*.js|*.json only, 500ms debounce)');
}

// ---- fire a hook into the framework's gamemode ----
function fire(name, ...args) {
  if (!ctx || !ctx.gamemode) return undefined;
  try { return ctx.gamemode.call(name, ...args); }
  catch (e) { warn(`hook ${name}: ${e.message}`); }
}

// ---- handle a message from the game DLL ----
function onGameMessage(msg) {
  switch (msg.t) {
    case 'hello':
      state.map = msg.map || state.map;
      log(`game connected (map=${state.map})`);
      loadFramework();
      setupHotReload();
      fire('Initialize');
      if (state.map) fire('MapInitialize', state.map);
      break;
    case 'event': {
      // Generic engine event -> gamemode hook. Player args are userIds we wrap.
      const args = (msg.args || []).map((a) =>
        (a && typeof a === 'object' && a.__player && state.players[a.userId]) ? wrapPlayer(state.players[a.userId]) : a);
      fire(msg.name, ...args);
      break;
    }
    case 'player_connect':
      state.players[msg.userId] = { userId: msg.userId, name: msg.name, steamId: msg.steamId, entIndex: msg.entIndex };
      if (msg.local) state.localUserId = msg.userId;
      fire('PlayerConnect', msg.name, msg.ip || '');
      break;
    case 'player_disconnect':
      fire('PlayerDisconnected', state.players[msg.userId] ? wrapPlayer(state.players[msg.userId]) : null);
      delete state.players[msg.userId];
      break;
    case 'local_player':
      state.localUserId = msg.userId;
      if (!state.players[msg.userId]) state.players[msg.userId] = { userId: msg.userId, name: msg.name, steamId: msg.steamId, entIndex: msg.entIndex };
      break;
    case 'net': {
      // client->server (or server->client) net message -> OVNetReceive hook
      const ply = ensurePlayer(msg.userId, msg.name_) ;
      if (ctx && ctx.hook) { try { ctx.hook.Run('OVNetReceive', msg.name, msg.payload, ply); } catch (e) { warn(e.message); } }
      break;
    }
    case 'say':
      if (ctx && ctx.hook) {
        const ply = ensurePlayer(msg.userId, msg.playerName);
        try { ctx.hook.Run('PlayerSay', ply, msg.text); } catch (e) { warn(e.message); }
      }
      break;
    case 'think':
      if (ctx && ctx.hook) { try { ctx.hook.Run('Think'); } catch {} }
      break;
    case 'conline':
      // Engine console line mirrored from the game client's spew tap —
      // republish on the SSE log stream so every GUI console host sees it.
      if (msg.line) pushLog('engine', String(msg.line));
      break;
    case 'concommand':
      // ov_js_cmd_cl (engine keybinds / openvibe:// bridge) -> JS-realm
      // console command. Dispatched exactly like the GUI console /exec path.
      if (ctx && ctx.concommand && typeof ctx.concommand.Dispatch === 'function' && msg.text) {
        const lp = (!IS_SERVER && state.localUserId != null && state.players[state.localUserId])
          ? wrapPlayer(state.players[state.localUserId]) : null;
        try {
          const handled = ctx.concommand.Dispatch(lp, String(msg.text));
          if (!handled && ctx.command && typeof ctx.command.dispatchConsole === 'function') {
            ctx.command.dispatchConsole(String(msg.text));
          }
        } catch (e) { warn('concommand:', e.message); }
      }
      break;
    case 'eval':
      // js_run / js_run_cl from the game console.
      if (ctx && ctx.OVLoader && typeof ctx.OVLoader.runString === 'function') {
        try { ctx.OVLoader.runString(msg.code, 'console'); } catch (e) { warn('eval:', e.message); }
      }
      break;
    case 'openscript':
      // js_openscript / js_openscript_cl from the game console.
      if (ctx && ctx.OVLoader && typeof ctx.OVLoader.openScript === 'function') {
        try { ctx.OVLoader.openScript(msg.path); } catch (e) { warn('openscript:', e.message); }
      }
      break;
    case 'npm':
      // ov_npm from the game console (server realm).
      runNpm(msg.args || [], () => {});
      break;
    default:
      break;
  }
}

// ---- runtime control HTTP server (GUI console / options / tooling) ----
// GET  /logs   SSE stream of runtime log lines (plus a small backlog)
// GET  /state  realm/mode/map/players/gamemode/hooks summary
// POST /eval   { code }            js_run equivalent in this realm
// POST /exec   { command }         concommand dispatch or engine forward
// POST /npm    { args: ["install", "pkg"] }  npm in the js/ tree + hot reload
// GET  /health
const http = require('http');
const { execFile: cpExecFile } = require('child_process');

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1 << 20) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

let npmBusy = false;
function runNpm(args, cb) {
  if (npmBusy) return cb({ ok: false, error: 'npm already running' });
  const allowed = ['install', 'i', 'update', 'uninstall', 'remove', 'ls', 'list'];
  if (!args.length || !allowed.includes(args[0])) return cb({ ok: false, error: `npm subcommand not allowed: ${args[0] || '(none)'}` });
  const safe = args.filter((a) => /^[-@a-zA-Z0-9._/^~:]+$/.test(String(a)));
  npmBusy = true;
  log('npm', safe.join(' '));
  cpExecFile('npm', [...safe, '--no-fund', '--no-audit'], { cwd: JS, timeout: 120000 }, (err, stdout, stderr) => {
    npmBusy = false;
    const out = String(stdout || '') + String(stderr || '');
    out.split('\n').filter(Boolean).slice(0, 40).forEach((l) => pushLog('npm', l));
    if (err) return cb({ ok: false, error: err.message, output: out });
    // fs.watch on js/ picks up node_modules changes and hot-reloads; force one
    // anyway so `npm ls`-style no-op writes still refresh requires.
    loadFramework();
    fire('Initialize');
    fire('OnReloaded');
    cb({ ok: true, output: out });
  });
}

const ctrl = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'ov-runtime', realm: REALM, mode: MODE });
  }
  if (req.method === 'GET' && url.pathname === '/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    for (const entry of logRing.slice(-100)) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    let gm = null, hooks = 0, entities = 0;
    try {
      gm = ctx && ctx.GAMEMODE ? { mode: ctx.GAMEMODE.mode, name: ctx.GAMEMODE.name } : null;
      if (ctx && ctx.hook) hooks = Object.keys(ctx.hook.GetTable()).length;
      if (ctx && ctx.ents) entities = ctx.ents.GetCount();
    } catch {}
    return json(res, 200, {
      ok: true, realm: REALM, mode: MODE, map: state.map, gameConnected: !!(sock && !sock.destroyed),
      players: Object.values(state.players).map((p) => ({ userId: p.userId, name: p.name, team: p.team || 0 })),
      gamemode: gm, hookEvents: hooks, entities,
    });
  }
  if (req.method === 'POST' && url.pathname === '/eval') {
    const body = await readBody(req);
    if (typeof body.code !== 'string') return json(res, 400, { ok: false, error: 'missing code' });
    let out;
    if (ctx && ctx.OVLoader && ctx.OVLoader.runString) out = ctx.OVLoader.runString(body.code, 'console-eval');
    else { try { out = { ok: true, result: vm.runInThisContext(body.code, { filename: 'console-eval' }) }; } catch (e) { out = { ok: false, error: e.message }; } }
    let rendered = null;
    try { rendered = out.result === undefined ? null : JSON.parse(JSON.stringify(out.result)); }
    catch { rendered = String(out.result); }
    pushLog('eval', `> ${body.code}`);
    if (out.ok) pushLog('eval', `= ${rendered === null ? 'undefined' : JSON.stringify(rendered)}`);
    else pushLog('error', out.error);
    return json(res, 200, { ok: out.ok, result: rendered, error: out.error || null });
  }
  if (req.method === 'POST' && url.pathname === '/exec') {
    const body = await readBody(req);
    const line = String(body.command || '').trim();
    if (!line) return json(res, 400, { ok: false, error: 'missing command' });
    pushLog('cmd', `] ${line}`);
    let handled = false;
    try {
      if (ctx && ctx.concommand && ctx.concommand.Dispatch) handled = !!ctx.concommand.Dispatch(null, line);
      if (!handled && ctx && ctx.command && ctx.command.dispatchConsole) {
        const r = ctx.command.dispatchConsole(line);
        handled = r !== undefined;
      }
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    if (!handled) {
      // Forward to the engine (the DLL applies its ov_*/say allowlist).
      if (!sock || sock.destroyed) {
        pushLog('warn', `engine command dropped (game not connected to this runtime): ${line}`);
        return json(res, 200, { ok: false, handled: false, error: 'game not connected to the ' + REALM + ' runtime — in-game use the console directly; the engine realm needs ov_js_backend node for launcher-side forwarding' });
      }
      sendToGame({ t: 'concmd', cmd: line });
      handled = 'forwarded';
    }
    return json(res, 200, { ok: true, handled });
  }
  if (req.method === 'POST' && url.pathname === '/npm') {
    const body = await readBody(req);
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    return runNpm(args, (result) => json(res, result.ok ? 200 : 400, result));
  }
  if (req.method === 'GET' && url.pathname === '/maps') {
    let maps = [];
    try {
      maps = fs.readdirSync(path.join(MOD, 'maps'))
        .filter((f) => f.endsWith('.bsp'))
        .map((f) => f.replace(/\.bsp$/, ''))
        .sort();
    } catch { /* no maps dir */ }
    return json(res, 200, { ok: true, maps });
  }
  if (req.method === 'GET' && url.pathname === '/scripts') {
    // js/-relative script paths for js_openscript autocomplete.
    const out = [];
    const walk = (dir, rel, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(path.join(JS, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(dir + '/' + e.name, r, depth + 1);
        else if (e.name.endsWith('.js')) out.push(r);
      }
    };
    walk('.', '', 0);
    return json(res, 200, { ok: true, scripts: out.sort().slice(0, 500) });
  }
  if (req.method === 'POST' && url.pathname === '/openscript') {
    const body = await readBody(req);
    const p = String(body.path || '');
    if (!p) return json(res, 400, { ok: false, error: 'missing path' });
    const ok = !!(ctx && ctx.OVLoader && ctx.OVLoader.openScript(p));
    return json(res, 200, { ok });
  }
  return json(res, 404, { ok: false, error: 'not found' });
});
ctrl.on('error', (e) => warn('control server error:', e.message));
ctrl.listen(CTRL_PORT, '127.0.0.1', () => log(`control server on 127.0.0.1:${CTRL_PORT}`));

// ---- TCP server ----
const server = net.createServer((s) => {
  if (sock && !sock.destroyed) { warn('replacing existing game connection'); try { sock.destroy(); } catch {} }
  sock = s;
  rxBuf = '';
  log('game DLL connected from', s.remoteAddress + ':' + s.remotePort);
  s.setEncoding('utf8');
  s.on('data', (chunk) => {
    rxBuf += chunk;
    let nl;
    while ((nl = rxBuf.indexOf('\n')) >= 0) {
      const line = rxBuf.slice(0, nl).trim();
      rxBuf = rxBuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { warn('bad json:', line.slice(0, 80)); continue; }
      try { onGameMessage(msg); } catch (e) { warn('handler:', e.message); }
    }
  });
  s.on('close', () => { if (sock === s) sock = null; log('game DLL disconnected'); });
  s.on('error', (e) => warn('socket error', e.message));
});

server.on('error', (e) => { console.error(`[ov-runtime/${REALM}] server error:`, e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT}  root=${ROOT}`);
  // Load the framework immediately so hotload/npm work even before the game
  // connects (useful for standalone testing).
  loadFramework();
  setupHotReload();
});

// Standalone self-test: `node ov-runtime.js --selftest`
if (process.argv.includes('--selftest')) {
  setTimeout(() => {
    log('SELFTEST: firing Initialize + PlayerSay(!q)');
    fire('Initialize');
    const ply = wrapPlayer(state.players[1] = { userId: 1, name: 'Tester' });
    if (ctx && ctx.hook) ctx.hook.Run('PlayerSay', ply, '!q');
    log('SELFTEST done');
    process.exit(0);
  }, 400);
}
