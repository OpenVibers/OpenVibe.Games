#!/usr/bin/env node
/**
 * ov-sidecar.mjs
 * OpenVibe: Source — API bridge sidecar process.
 *
 * Watches the SRCDS log directory for the latest log file, tails it for
 * [OV]-prefixed event lines, and bridges them to the OpenVibe backend API.
 *
 * Also sends periodic server heartbeats so the backend considers this
 * server "alive" in the registry.
 *
 * Usage:
 *   node tools/ov-sidecar.mjs \
 *     --server-id  local-prophunt-27016 \
 *     --server-secret dev-secret \
 *     --mode prophunt \
 *     --port 27016 \
 *     --max-players 24 \
 *     --host 127.0.0.1 \
 *     --log-dir /path/to/game/openvibe.games/logs \
 *     --api-url http://127.0.0.1:3000
 *
 * [OV] event protocol (printed by VScript via printl):
 *   [OV] BOOT     serverId mode
 *   [OV] HEARTBEAT serverId playerCount maxPlayers state
 *   [OV] REWARD   matchId serverId serverSecret steamId mode currency xp
 *   [OV] SAY      message...
 */

import { readdir, open, stat } from "node:fs/promises";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const name = key.slice(2);
      const val  = argv[i + 1];
      if (val && !val.startsWith("--")) {
        args[name] = val;
        i++;
      } else {
        args[name] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const SERVER_ID     = args["server-id"]     ?? process.env.OV_SERVER_ID     ?? "local-hub-27015";
const SERVER_SECRET = args["server-secret"] ?? process.env.OV_SERVER_SECRET ?? "dev-secret";
const MODE          = args["mode"]          ?? process.env.OV_MODE          ?? "hub";
const PORT          = Number(args["port"]   ?? process.env.OV_PORT          ?? 27015);
const MAX_PLAYERS   = Number(args["max-players"] ?? process.env.OV_MAX_PLAYERS ?? 48);
const PUBLIC_HOST   = args["host"]          ?? process.env.OV_HOST          ?? "127.0.0.1";
const API_URL       = args["api-url"]       ?? process.env.OV_API_URL       ?? "http://127.0.0.1:3000";
const LOG_DIR       = args["log-dir"]       ?? process.env.OV_LOG_DIR       ??
                      resolve(import.meta.dirname, "../game/openvibe.games/logs");

const HEARTBEAT_INTERVAL_MS = 30_000;
const LOG_POLL_MS            = 500;
const REGISTER_RETRY_DELAY   = 5_000;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg)  { console.log(`[ov-sidecar/${SERVER_ID}] ${msg}`); }
function warn(msg) { console.warn(`[ov-sidecar/${SERVER_ID}] WARN: ${msg}`); }
function err(msg)  { console.error(`[ov-sidecar/${SERVER_ID}] ERROR: ${msg}`); }

// ---------------------------------------------------------------------------
// Backend API client
// ---------------------------------------------------------------------------

async function apiPost(path, body) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      warn(`POST ${path} ${res.status}: ${JSON.stringify(json)}`);
      return null;
    }
    return json;
  } catch (e) {
    warn(`POST ${path} failed: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server registration
// ---------------------------------------------------------------------------

let g_Registered = false;

async function registerServer() {
  log(`Registering as ${MODE} server on port ${PORT}…`);
  const result = await apiPost("/v1/servers/register", {
    serverId:    SERVER_ID,
    serverSecret: SERVER_SECRET,
    mode:        MODE,
    mapName:     `${modeDefaultMap(MODE)}`,
    publicHost:  PUBLIC_HOST,
    port:        PORT,
    maxPlayers:  MAX_PLAYERS,
  });

  if (result) {
    g_Registered = true;
    log(`Registered: ${result.serverId} state=${result.state}`);
  } else {
    warn("Registration failed; will retry…");
  }
  return result != null;
}

function modeDefaultMap(mode) {
  const maps = {
    hub: "ov_hub",
    prophunt: "ph_openvibe_dev",
    deathrun: "dr_openvibe_dev",
    fortwars: "fw_openvibe_dev",
    traitortown: "tt_openvibe_dev",
  };
  return maps[mode] ?? mode;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

let g_PlayerCount = 0;
let g_State       = "open";
let g_MapName     = modeDefaultMap(MODE);

async function sendHeartbeat() {
  if (!g_Registered) {
    const ok = await registerServer();
    if (!ok) return;
  }

  const result = await apiPost("/v1/servers/heartbeat", {
    serverId:     SERVER_ID,
    serverSecret: SERVER_SECRET,
    mapName:      g_MapName,
    playerCount:  g_PlayerCount,
    maxPlayers:   MAX_PLAYERS,
    state:        g_State,
  });

  if (result) {
    log(`Heartbeat sent: players=${result.playerCount}/${result.maxPlayers} state=${result.state}`);
  } else {
    // Server might have been deregistered; try re-registration next tick
    g_Registered = false;
  }
}

// ---------------------------------------------------------------------------
// Match reward handling
// ---------------------------------------------------------------------------

async function handleReward(parts) {
  // REWARD matchId serverId serverSecret steamId mode currency xp
  if (parts.length < 8) {
    warn("REWARD event missing fields: " + parts.join(" "));
    return;
  }
  const [matchId, serverId, serverSecret, steamId, mode, currencyStr, xpStr] = parts;

  // Only process if this event is for our server (VScript uses uid, not full steamId)
  // The steamId field from VScript is actually the user ID integer.
  // Map it via /v1/me if needed, but for now we pass it through directly.

  const result = await apiPost("/v1/matches/end", {
    matchId,
    serverId,
    serverSecret,
    steamId,       // numeric user ID; backend accepts any numeric string
    mode,
    rewardCurrency: Number(currencyStr) || 0,
    rewardXp:       Number(xpStr)       || 0,
  });

  if (result) {
    log(`Reward processed: matchId=${matchId} steamId=${steamId} ` +
        `coins=${result.player?.currencyBalance} xp=${result.player?.xp}`);
  }
}

// ---------------------------------------------------------------------------
// [OV] event dispatcher
// ---------------------------------------------------------------------------

async function dispatchOvEvent(line) {
  // Strip SRCDS log prefix: "L MM/DD/YYYY - HH:MM:SS: [OV] ..."
  const ovIdx = line.indexOf("[OV] ");
  if (ovIdx === -1) return;

  const payload = line.slice(ovIdx + 5).trim();
  const parts   = payload.split(/\s+/);
  if (parts.length === 0) return;

  const eventType = parts[0];
  const eventData = parts.slice(1);

  switch (eventType) {
    case "BOOT": {
      // [OV] BOOT serverId mode
      const [srvId, mode] = eventData;
      log(`BOOT received from ${srvId} (${mode})`);
      if (srvId === SERVER_ID) {
        g_Registered = false;  // Force re-register
        await sendHeartbeat();
      }
      break;
    }

    case "HEARTBEAT": {
      // [OV] HEARTBEAT serverId playerCount maxPlayers state
      const [srvId, countStr, maxStr, state] = eventData;
      if (srvId === SERVER_ID) {
        g_PlayerCount = Number(countStr) || 0;
        g_State       = state || "open";
        // Heartbeat will be sent on next interval
      }
      break;
    }

    case "REWARD": {
      await handleReward(eventData);
      break;
    }

    case "SAY": {
      log("SERVER SAY: " + eventData.join(" "));
      break;
    }

    default:
      // Ignore unknown events; VScript may emit debug lines
      break;
  }
}

// ---------------------------------------------------------------------------
// Log file tailer
// ---------------------------------------------------------------------------

/**
 * Finds the most recently modified .log file in the log directory.
 */
async function findLatestLog(logDir) {
  let files;
  try {
    files = await readdir(logDir);
  } catch {
    return null;
  }

  const logs = files.filter((f) => f.endsWith(".log"));
  if (logs.length === 0) return null;

  let latest = null;
  let latestTime = 0;

  for (const f of logs) {
    try {
      const s = await stat(resolve(logDir, f));
      if (s.mtimeMs > latestTime) {
        latestTime = s.mtimeMs;
        latest = f;
      }
    } catch {
      // ignore
    }
  }

  return latest ? resolve(logDir, latest) : null;
}

/** Continuously tail the latest log file, yielding new lines. */
async function* tailLog(logDir) {
  let currentPath = null;
  let fileHandle  = null;
  let position    = 0;
  let buf         = "";

  while (true) {
    // Find latest log (SRCDS rotates logs; we need to follow the newest)
    const latest = await findLatestLog(logDir);

    if (latest !== currentPath) {
      // Switched to a new log file
      if (fileHandle) {
        try { await fileHandle.close(); } catch {}
      }
      currentPath = latest;
      position    = 0;
      buf         = "";

      if (latest) {
        try {
          fileHandle = await open(latest, "r");
          log(`Tailing log: ${latest}`);
        } catch (e) {
          warn(`Could not open log ${latest}: ${e.message}`);
          fileHandle = null;
        }
      }
    }

    if (!fileHandle) {
      await sleep(LOG_POLL_MS * 4);
      continue;
    }

    // Read new bytes
    const chunk = Buffer.alloc(65536);
    let bytesRead = 0;
    try {
      const result = await fileHandle.read(chunk, 0, chunk.length, position);
      bytesRead = result.bytesRead;
    } catch (e) {
      warn(`Read error on ${currentPath}: ${e.message}`);
      try { await fileHandle.close(); } catch {}
      fileHandle  = null;
      currentPath = null;
      continue;
    }

    if (bytesRead > 0) {
      position += bytesRead;
      buf      += chunk.slice(0, bytesRead).toString("utf8");

      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length > 0) yield line;
      }
    } else {
      await sleep(LOG_POLL_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  log(`Starting — mode=${MODE} serverId=${SERVER_ID} api=${API_URL}`);

  // Initial registration attempt
  await registerServer();

  // Start heartbeat timer
  const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Log tailer
  log(`Watching log directory: ${LOG_DIR}`);
  for await (const line of tailLog(LOG_DIR)) {
    if (line.includes("[OV] ")) {
      await dispatchOvEvent(line);
    }
  }

  clearInterval(heartbeatTimer);
}

main().catch((e) => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
