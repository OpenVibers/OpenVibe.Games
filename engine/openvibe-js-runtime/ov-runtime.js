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
const ROOT = path.resolve(arg('root', path.join(__dirname, '..', '..')));
const MOD = path.join(ROOT, 'game', 'openvibe.games');
const JS = path.join(MOD, 'js');
const IS_SERVER = REALM === 'server';

function log(...a) { console.log(`[ov-runtime/${REALM}]`, ...a); }
function warn(...a) { console.warn(`[ov-runtime/${REALM}] WARN`, ...a); }

// ---- IPC: one connected game client at a time ----
let sock = null;
let rxBuf = '';
function sendToGame(obj) {
  if (sock && !sock.destroyed) {
    try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) { warn('send failed', e.message); }
  }
}

// ---- the sandboxed JS world (same globals the embedded build provides) ----
let ctx = null;          // vm context (globalThis of the framework)
let watchers = [];       // fs watchers for hot-reload

function modRel(p) {
  // Resolve a mod-relative path safely (no escaping MOD).
  const norm = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  return path.join(MOD, norm);
}

function buildOV() {
  // OV.* the js/core/* files expect, backed by Node + IPC.
  return {
    log: (m) => { log('[js]', m); },
    warn: (m) => { warn('[js]', m); },
    error: (m) => { console.error(`[ov-runtime/${REALM}] [js ERROR]`, m); },
    isServer: () => IS_SERVER,
    getMode: () => MODE,
    getMapName: () => state.map,
    time: () => Date.now() / 1000,
    readFile: (p) => { try { return fs.readFileSync(modRel(p), 'utf8'); } catch { return null; } },
    fileExists: (p) => { try { return fs.statSync(modRel(p)).isFile(); } catch { return false; } },
    listDir: (d /*, wildcard */) => { try { return fs.readdirSync(modRel(d)); } catch { return []; } },
    freeMem: () => {},
    players: () => Object.values(state.players).map(wrapPlayer),
    playerByUserId: (id) => state.players[id] ? wrapPlayer(state.players[id]) : null,
    broadcast: (msg) => sendToGame({ t: 'chat', msg: String(msg) }),
    serverCommand: (cmd) => sendToGame({ t: 'concmd', cmd: String(cmd) }),
    netEmit: (idsCsv, name, payloadB64) => sendToGame({ t: 'net', ids: String(idsCsv), name: String(name), payload: String(payloadB64) }),
    netSendToServer: (name, payloadB64) => sendToGame({ t: 'net', toServer: true, name: String(name), payload: String(payloadB64) }),
    fireHook: (name, ...args) => { try { return ctx.hook.Run(name, ...args); } catch (e) { warn('fireHook', e.message); } },
    reward: () => {},
    endMatch: () => {},
  };
}

// Live game state mirrored from IPC events.
const state = { map: '', players: {} /* userId -> {userId,name,steamId,...} */ };
function wrapPlayer(p) {
  return {
    userId: () => p.userId, entIndex: () => p.entIndex || p.userId,
    steamId: () => p.steamId || '', name: () => p.name || ('Player' + p.userId),
    health: () => p.health || 100, setHealth: (v) => sendToGame({ t: 'player', userId: p.userId, setHealth: v }),
    team: () => p.team || 0, setTeam: (v) => { p.team = v; sendToGame({ t: 'player', userId: p.userId, setTeam: v }); },
    chat: (m) => sendToGame({ t: 'chat', userId: p.userId, msg: String(m) }),
    runCommand: (c) => sendToGame({ t: 'runcmd', userId: p.userId, cmd: String(c) }),
  };
}

// Build the Node require npm + the addon loader use. Resolved from the mod's js
// dir so bare specifiers hit game/openvibe.games/node_modules (Node searches
// upward) — full npm incl. native modules.
function buildRequire() {
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

// ---- (re)load the framework in Node's MAIN global context ----
// Everything (framework core, gamemodes, addons via require, npm) shares one
// real global so OV/hook/require are visible everywhere — unlike a vm sandbox,
// whose globals Node's require() cannot see.
function loadFramework() {
  // Clear framework globals so re-eval redefines them (core files guard against
  // re-init, which would otherwise no-op a hot-reload).
  for (const g of ['hook', 'gamemode', 'GM', 'GAMEMODE', 'net', 'util', 'command', 'concommand', 'timer', 'Addon', 'module', 'OVSandbox']) {
    try { delete global[g]; } catch {}
  }
  global.OV = buildOV();
  global.require = buildRequire();

  const order = [
    'core/hook.js', 'core/gamemode.js', 'bridge.js', 'core/command.js', 'core/timer.js',
    'gamemodes/base/server.js',
    `gamemodes/${MODE}/shared.js`,
    `gamemodes/${MODE}/${IS_SERVER ? 'server' : 'client'}.js`,
  ];
  for (const f of order) {
    const full = path.join(JS, f);
    if (!fs.existsSync(full)) continue;
    try { vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: f }); }
    catch (e) { warn(`load ${f}: ${e.message}`); }
  }
  ctx = global;
  log(`framework loaded (mode=${MODE}, realm=${REALM})`);
}

// ---- hot reload: watch js + addons, debounce, reload framework ----
function setupHotReload() {
  watchers.forEach((w) => { try { w.close(); } catch {} });
  watchers = [];
  let timer = null;
  const trigger = (why) => {
    clearTimeout(timer);
    timer = setTimeout(() => { log('hot-reload:', why); loadFramework(); fire('Initialize'); }, 200);
  };
  for (const dir of [JS, path.join(MOD, 'addons')]) {
    if (!fs.existsSync(dir)) continue;
    try { watchers.push(fs.watch(dir, { recursive: true }, (_e, f) => trigger(f || dir))); }
    catch (e) { warn('watch failed', dir, e.message); }
  }
  log('hot-reload watching js/ + addons/');
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
      state.players[msg.userId] = { userId: msg.userId, name: msg.name, steamId: msg.steamId };
      break;
    case 'player_disconnect':
      delete state.players[msg.userId];
      break;
    case 'net': {
      // client->server (or server->client) net message -> OVNetReceive hook
      const ply = msg.userId != null && state.players[msg.userId] ? wrapPlayer(state.players[msg.userId]) : null;
      if (ctx && ctx.hook) { try { ctx.hook.Run('OVNetReceive', msg.name, msg.payload, ply); } catch (e) { warn(e.message); } }
      break;
    }
    case 'say':
      if (ctx && ctx.hook) {
        const ply = state.players[msg.userId] ? wrapPlayer(state.players[msg.userId]) : null;
        try { ctx.hook.Run('PlayerSay', ply, msg.text); } catch (e) { warn(e.message); }
      }
      break;
    case 'think':
      if (ctx && ctx.hook) { try { ctx.hook.Run('Think'); } catch {} }
      break;
    default:
      break;
  }
}

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
