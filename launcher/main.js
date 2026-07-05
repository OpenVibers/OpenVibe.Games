// OpenVibe Launcher — Electron main process
// Embeds Chromium via Electron for the custom main menu
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const API_BASE = 'http://127.0.0.1:3000';
const DEV = process.env.ELECTRON_IS_DEV === '1';
const CLIENT_UI_PORT = Number(process.env.OPENVIBE_CLIENT_UI_PORT || 5173);

let mainWindow = null;
let gameProcess = null;
let uiServerProcess = null;
let appIsQuitting = false;

let lastLaunchState = { phase: 'idle', message: 'Ready', pid: null };

// ── Shared display preferences ────────────────────────────────────────────────
// {w,h,mode} with mode 'windowed' | 'fullscreen' | 'borderless', persisted in
// launcher/.ov-display.json (gitignored) so the Electron shell, the loading
// overlay and the game client all share one resolution. The in-game client
// page writes these through the 'ov-display-prefs' IPC channel
// (electronOV.setDisplayPrefs / getDisplayPrefs); the game picks them up via
// OPENVIBE_RES_W / OPENVIBE_RES_H / OPENVIBE_RES_MODE env vars consumed by
// tools/run-client-*.sh.
const DISPLAY_PREFS_PATH = path.join(__dirname, '.ov-display.json');
const DISPLAY_MODES = ['windowed', 'fullscreen', 'borderless'];
const DEFAULT_DISPLAY_PREFS = { w: 1280, h: 800, mode: 'windowed' };

function sanitizeDisplayPrefs(raw) {
  const p = { ...DEFAULT_DISPLAY_PREFS };
  if (raw && typeof raw === 'object') {
    const w = Math.floor(Number(raw.w));
    const h = Math.floor(Number(raw.h));
    if (Number.isFinite(w) && w >= 640 && w <= 7680) p.w = w;
    if (Number.isFinite(h) && h >= 480 && h <= 4320) p.h = h;
    if (DISPLAY_MODES.includes(raw.mode)) p.mode = raw.mode;
  }
  return p;
}

let displayPrefs = (() => {
  try {
    return sanitizeDisplayPrefs(JSON.parse(fs.readFileSync(DISPLAY_PREFS_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_DISPLAY_PREFS };
  }
})();

function saveDisplayPrefs() {
  try {
    fs.writeFileSync(DISPLAY_PREFS_PATH, JSON.stringify(displayPrefs, null, 2) + '\n');
  } catch (e) {
    console.error('[launcher] could not save display prefs:', e && e.message);
  }
}

function applyDisplayPrefsToMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (displayPrefs.mode === 'fullscreen') {
    mainWindow.setFullScreen(true);
  } else {
    // 'borderless' behaves like windowed for the launcher shell — the window
    // is already frameless; the distinction matters for the game client args.
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.setSize(displayPrefs.w, displayPrefs.h);
    mainWindow.center();
  }
}

// Bring the launcher back (used when the game exits/errors). Airtight: if the
// window was somehow destroyed while the game ran, recreate it.
function showLauncherWindow() {
  if (appIsQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function broadcastLaunchState(state) {
  lastLaunchState = { ...lastLaunchState, ...state, at: Date.now() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launch-state', lastLaunchState);
  }
}

function sourceWindowVisible() {
  try {
    const out = execSync('wmctrl -lx 2>/dev/null || true', { encoding: 'utf8' });
    return /OpenVibe: Source|Source SDK Base 2013|hl2\.exe|hl2/i.test(out);
  } catch {
    return false;
  }
}

function focusSourceWindow() {
  const commands = [
    "wmctrl -a 'OpenVibe: Source'",
    "wmctrl -a 'Source SDK Base 2013'",
    "wmctrl -a 'hl2.exe'",
  ];
  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch {}
  }
  return false;
}

function waitForStableSourceWindow(timeoutMs = 60000) {
  const started = Date.now();
  let stableTicks = 0;
  return new Promise((resolve) => {
    const tick = () => {
      if (sourceWindowVisible()) stableTicks += 1;
      else stableTicks = 0;

      broadcastLaunchState({
        phase: stableTicks > 0 ? 'window-detected' : 'starting',
        message: stableTicks > 0
          ? `Source window detected (${stableTicks}/5 stable checks)...`
          : 'Starting Source through Proton...',
      });

      if (stableTicks >= 5) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}



const GAME_WINDOW_TITLE = process.env.OPENVIBE_GAME_WINDOW_TITLE || 'OpenVibe: Source';
const GAME_READY_TIMEOUT_MS = Number(process.env.OPENVIBE_GAME_WINDOW_READY_TIMEOUT_MS || 45000);
const GAME_STABLE_MS = Number(process.env.OPENVIBE_GAME_WINDOW_STABLE_MS || 8000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitLaunchPhase(phase, message, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game-launch-phase', { phase, message, ...extra });
  }
}

function safeExec(command) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function findGameWindowId() {
  // Linux desktop helper. If xdotool is not installed, the launcher simply stays visible.
  const escaped = GAME_WINDOW_TITLE.replace(/"/g, '\\"');
  const out = safeExec(`xdotool search --name "${escaped}" 2>/dev/null | tail -n 1`);
  return out || null;
}

function focusGameWindow() {
  const win = findGameWindowId();
  if (!win) return false;
  safeExec(`xdotool windowactivate ${win} 2>/dev/null || true`);
  return true;
}

async function waitForGameWindowReady(timeoutMs = GAME_READY_TIMEOUT_MS) {
  const started = Date.now();
  let firstSeen = 0;

  while (Date.now() - started < timeoutMs) {
    const win = findGameWindowId();
    if (win) {
      if (!firstSeen) {
        firstSeen = Date.now();
        emitLaunchPhase('window-found', 'Source window found. Waiting for it to stop thrashing before switching focus...', { windowId: win });
      }

      if (Date.now() - firstSeen >= GAME_STABLE_MS) {
        return { ready: true, windowId: win, reason: 'window-stable' };
      }
    }

    await sleep(500);
  }

  return { ready: false, windowId: findGameWindowId(), reason: 'timeout' };
}

// ── API helper ────────────────────────────────────────────────────────────────
function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${urlPath}`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function apiGetAuthed(urlPath, token) {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${urlPath}`, {
      timeout: 5000,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 5000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('timeout')));
    req.write(bodyStr);
    req.end();
  });
}


function clientUiUrl(route = 'portal', extraParams = {}) {
  const params = new URLSearchParams({
    electron: '1',
    shell: 'electron',
    ...extraParams,
  });
  return `http://127.0.0.1:${CLIENT_UI_PORT}/client/?${params.toString()}#${encodeURIComponent(route)}`;
}

function waitForHttp(url, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      http.get(url, { timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }).on('error', () => {
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 200);
      }).on('timeout', () => {
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function ensureClientUiServer(root) {
  const healthUrl = `http://127.0.0.1:${CLIENT_UI_PORT}/health`;
  if (await waitForHttp(healthUrl, 500)) return true;

  const serverScript = path.join(root, 'tools/serve-client-ui.mjs');
  if (!fs.existsSync(serverScript)) {
    dialog.showErrorBox('OpenVibe Menu Server Missing', `Could not find:\n${serverScript}`);
    return false;
  }

  uiServerProcess = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      OPENVIBE_ROOT: root,
      OPENVIBE_CLIENT_UI_PORT: String(CLIENT_UI_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  uiServerProcess.stdout.on('data', (d) => console.log('[client-ui]', d.toString().trim()));
  uiServerProcess.stderr.on('data', (d) => console.error('[client-ui]', d.toString().trim()));
  uiServerProcess.on('exit', (code) => {
    console.log('[launcher] client UI server exited with code', code);
    uiServerProcess = null;
  });

  return waitForHttp(healthUrl, 5000);
}

// ── "Waiting for Source" loading overlay ─────────────────────────────────────
// A frameless always-on-top window shown while the Source engine boots.
// Progress is driven by polling the client runtime control server once/second.
//
// Phase state machine (per launch session):
//   starting  → gameProcess spawned, control server not yet reporting connect
//   connected → state.gameConnected === true          ("Loading gamemode…")
//   map       → state.map is non-empty                ("Entering <map>…")
//   ready     → map set AND (players.length > 0 OR 8s elapsed since map set)
// NEVER OPEN TOGETHER: the launcher main window hides the moment the game
// process spawns (the overlay covers the screen from then on). On ready the
// overlay fades out and only the game remains. On game exit/error the launcher
// returns (see launchGame handlers). On the 180s safety timeout the overlay
// closes hard, but the launcher stays hidden while the game process is alive.
const CONTROL_STATE_URL = 'http://127.0.0.1:41996/state';
const LOADING_OVERLAY_MAX_MS = 180_000;      // safety: never cover the screen forever
const LOADING_READY_AFTER_MAP_MS = 8_000;    // ready fallback once a map is set
const LOADING_CLICK_ESCAPE_AFTER_MS = 30_000; // click-to-dismiss once connected this long

let loadingOverlay = null;
let loadingPollTimer = null;
let loadingSafetyTimer = null;
let loadingSession = null;

function controlStateGet() {
  return new Promise((resolve, reject) => {
    const req = http.get(CONTROL_STATE_URL, { timeout: 900 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function sendLoadingPhase(phase, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ov-loading-phase', { phase, message, at: Date.now() });
  }
}

function setOverlayPhaseText(text) {
  if (!loadingOverlay || loadingOverlay.isDestroyed()) return;
  // Works for both the remote /client/?loading=1 page and the local fallback:
  // both are expected to expose window.__ovSetPhase; __ovPhase is stashed so a
  // page that finishes loading late can pick the current phase up itself.
  const js =
    `try { window.__ovPhase = ${JSON.stringify(text)}; ` +
    `window.__ovSetPhase && window.__ovSetPhase(${JSON.stringify(text)}); } catch (e) {}`;
  loadingOverlay.webContents.executeJavaScript(js, true).catch(() => {});
}

// Close the overlay. { fade: true } asks the page to fade to black first and
// destroys the window ~250ms later (used on READY). Timeout/exit/error paths
// call without options and close hard — never risk a stuck fullscreen window.
function closeLoadingOverlay(opts = {}) {
  if (loadingPollTimer) { clearInterval(loadingPollTimer); loadingPollTimer = null; }
  if (loadingSafetyTimer) { clearTimeout(loadingSafetyTimer); loadingSafetyTimer = null; }
  loadingSession = null;

  const win = loadingOverlay;
  loadingOverlay = null;
  if (!win || win.isDestroyed()) return;

  if (opts.fade) {
    // Both the remote loading page and the local fallback fade via this class
    // (the local page transitions body opacity; harmless if the CSS is absent).
    win.webContents.executeJavaScript(
      `try { document.documentElement.classList.add('ov-fade-out'); } catch (e) {}`,
      true
    ).catch(() => {});
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 260);
  } else {
    win.destroy();
  }
}

function openLoadingOverlay(mode) {
  closeLoadingOverlay();

  // Match the shared display prefs: fullscreen-on-primary in fullscreen mode,
  // otherwise a centered window at the same resolution the game will use.
  const overlayFullscreen = displayPrefs.mode === 'fullscreen';
  let bounds = null;
  try { bounds = screen.getPrimaryDisplay().bounds; } catch {}

  const sizing = overlayFullscreen
    ? (bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : { width: 1280, height: 800 })
    : { width: displayPrefs.w, height: displayPrefs.h };

  loadingOverlay = new BrowserWindow({
    ...sizing,
    frame: false,
    fullscreen: overlayFullscreen,
    alwaysOnTop: true,
    backgroundColor: '#0d0d14',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  loadingOverlay.setMenuBarVisibility(false);
  loadingOverlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadingOverlay.once('ready-to-show', () => {
    if (loadingOverlay && !loadingOverlay.isDestroyed()) loadingOverlay.show();
  });
  // The page's "Hide" button (window.close()) or the click escape hatch lands
  // here; polling continues so the launcher still hides once the game is ready.
  loadingOverlay.on('closed', () => { loadingOverlay = null; });

  const remoteUrl = `${API_BASE}/client/?loading=1&mode=${encodeURIComponent(mode || 'hub')}`;
  loadingOverlay.loadURL(remoteUrl).catch(() => {
    // Backend down — fall back to the bundled local page.
    if (loadingOverlay && !loadingOverlay.isDestroyed()) {
      loadingOverlay.loadFile(path.join(__dirname, 'loading.html'), {
        query: { mode: mode || 'hub' },
      }).catch(() => {});
    }
  });

  loadingSession = {
    startedAt: Date.now(),
    connectedAt: 0,
    mapSetAt: 0,
    map: '',
    escapeArmed: false,
    ready: false,
  };

  setOverlayPhaseText('Starting Source engine…');
  sendLoadingPhase('starting', 'Starting Source engine…');

  loadingSafetyTimer = setTimeout(() => {
    console.log('[launcher] loading overlay safety timeout — closing');
    sendLoadingPhase('timeout', 'Still waiting for Source — overlay dismissed.');
    closeLoadingOverlay(); // hard close, no fade — never leave the screen covered
    // Game still alive → launcher stays hidden (the game window is the UI now).
    // Game already gone with no exit event (shouldn't happen) → never strand
    // the user with zero windows: bring the launcher back.
    if (!gameProcess) showLauncherWindow();
  }, LOADING_OVERLAY_MAX_MS);

  loadingPollTimer = setInterval(pollLoadingState, 1000);
}

async function pollLoadingState() {
  const s = loadingSession;
  if (!s || s.ready) return;

  let st = null;
  try { st = await controlStateGet(); }
  catch { /* control server not up yet — keep current phase */ }
  if (loadingSession !== s) return; // session ended while awaiting

  const now = Date.now();

  if (st && st.gameConnected === true && !s.connectedAt) {
    s.connectedAt = now;
    setOverlayPhaseText('Loading gamemode…');
    sendLoadingPhase('connected', 'Loading gamemode…');
  }

  if (st && typeof st.map === 'string' && st.map.length > 0 && !s.mapSetAt) {
    s.mapSetAt = now;
    s.map = st.map;
    setOverlayPhaseText(`Entering ${s.map}…`);
    sendLoadingPhase('map', `Entering ${s.map}…`);
  }

  // Escape hatch: once the game has been connected >30s, a click anywhere on
  // the overlay dismisses it (works for remote page and local fallback alike).
  if (s.connectedAt && !s.escapeArmed && now - s.connectedAt > LOADING_CLICK_ESCAPE_AFTER_MS) {
    s.escapeArmed = true;
    if (loadingOverlay && !loadingOverlay.isDestroyed()) {
      loadingOverlay.webContents.executeJavaScript(
        `try { document.addEventListener('click', function () { window.close(); }, { once: true }); } catch (e) {}`,
        true
      ).catch(() => {});
    }
  }

  const players = st && Array.isArray(st.players) ? st.players : [];
  const ready = s.mapSetAt > 0
    && (players.length > 0 || now - s.mapSetAt >= LOADING_READY_AFTER_MAP_MS);

  if (ready) {
    s.ready = true;
    sendLoadingPhase('ready', s.map ? `In game — ${s.map}` : 'In game');
    // Launcher was already hidden at spawn; the overlay just fades out over
    // the game window.
    closeLoadingOverlay({ fade: true });
  }
}

// ── Game launch ────────────────────────────────────────────────────────────────
async function launchGame(serverIp, serverPort, mode) {
  // A second Source instance always fails on the engine lock — if the game is
  // already running, focus it and toast the UI instead of spawning again.
  if (gameProcess) {
    focusGameWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ov-toast', {
        message: 'OpenVibe is already running — switched to the game window.',
        kind: 'info',
      });
    }
    return { ok: true, alreadyRunning: true, pid: gameProcess.pid };
  }

  const root = path.resolve(__dirname, '..');

  const uiReady = await ensureClientUiServer(root);
  if (!uiReady) {
    dialog.showErrorBox('OpenVibe Menu Server Failed',
      `Could not start http://127.0.0.1:${CLIENT_UI_PORT}/client for the launcher/in-game HTML menu.`);
    return false;
  }

  const scriptArgs = serverIp && serverPort ? [serverIp, String(serverPort)] : [];
  const isWin = process.platform === 'win32';
  const launcherScript = isWin
    ? path.join(root, 'tools', 'run-client-windows.ps1')
    : path.join(root, 'tools', 'run-client-auto.sh');

  if (!fs.existsSync(launcherScript)) {
    dialog.showErrorBox('OpenVibe Launcher Script Missing', `Could not find:\n${launcherScript}`);
    return false;
  }

  const command = isWin ? 'powershell.exe' : 'bash';
  const args = isWin
    ? ['-ExecutionPolicy', 'Bypass', '-File', launcherScript, ...scriptArgs]
    : [launcherScript, ...scriptArgs];

  console.log('[launcher] spawning client:', command, args.join(' '));

  gameProcess = spawn(command, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      OPENVIBE_ROOT: root,
      DISPLAY: process.env.DISPLAY || ':0',
      // Shared display prefs → consumed by tools/run-client-*.sh to build the
      // engine's -w/-h and windowed/fullscreen/borderless flags.
      OPENVIBE_RES_W: String(displayPrefs.w),
      OPENVIBE_RES_H: String(displayPrefs.h),
      OPENVIBE_RES_MODE: displayPrefs.mode,
    },
  });

  gameProcess.stdout.on('data', (d) => console.log('[game]', d.toString().trim()));
  gameProcess.stderr.on('data', (d) => console.error('[game]', d.toString().trim()));
  gameProcess.on('error', (err) => {
    console.error('[launcher] game process error:', err && err.message);
    gameProcess = null;
    closeLoadingOverlay();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-exited', -1);
    }
    showLauncherWindow();
  });
  gameProcess.on('exit', (code) => {
    console.log('[launcher] game exited with code', code);
    gameProcess = null;
    closeLoadingOverlay();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-exited', code);
    }
    showLauncherWindow();
  });

  mainWindow?.webContents.send('game-started', gameProcess.pid);

  // NEVER OPEN TOGETHER: the overlay covers the screen from the moment the
  // game process spawns, and the launcher hides immediately. It comes back
  // only via the exit/error handlers above (or the safety-timeout dead-game
  // fallback in openLoadingOverlay).
  openLoadingOverlay(mode);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  gameProcess.unref();
  return { ok: true, pid: gameProcess.pid };
}

// ── Steam OpenID sign-in ──────────────────────────────────────────────────────
// Opens a popup on the backend's /v1/auth/steam/openid/start route, which
// bounces through steamcommunity.com and redirects back with #ovtoken=<token>.
// Always resolves ({ sessionToken, steamId } or { error }); never rejects.
const STEAM_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

function steamOpenIdLogin() {
  return new Promise((resolve) => {
    let settled = false;
    let tokenCaptured = false;
    let popup = null;
    let timeoutHandle = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (popup && !popup.isDestroyed()) popup.destroy();
      popup = null;
      resolve(result);
    };

    try {
      popup = new BrowserWindow({
        width: 500,
        height: 750,
        parent: (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined,
        autoHideMenuBar: true,
        title: 'Sign in with Steam',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    } catch (e) {
      console.error('[launcher] steam login popup failed:', e.message);
      return finish({ error: 'steam_openid_failed' });
    }

    timeoutHandle = setTimeout(() => finish({ error: 'steam_openid_failed' }), STEAM_LOGIN_TIMEOUT_MS);

    const inspectUrl = (url) => {
      if (settled || tokenCaptured || typeof url !== 'string') return;
      const match = /#ovtoken=([^&]+)/.exec(url);
      if (!match) return;
      tokenCaptured = true;

      let token = '';
      try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }

      // Token captured: close the popup, then verify the session with the API.
      if (popup && !popup.isDestroyed()) popup.destroy();
      if (!token) return finish({ error: 'steam_openid_failed' });

      apiGetAuthed('/v1/auth/session', token).then((info) => {
        if (info && info.valid) {
          finish({ sessionToken: token, steamId: info.steamId || '' });
        } else {
          finish({ error: 'steam_openid_failed' });
        }
      }).catch(() => finish({ error: 'steam_openid_failed' }));
    };

    popup.webContents.on('will-redirect', (_e, url) => inspectUrl(url));
    popup.webContents.on('did-navigate', (_e, url) => inspectUrl(url));
    popup.webContents.on('did-navigate-in-page', (_e, url) => inspectUrl(url));

    popup.on('closed', () => {
      if (!tokenCaptured) finish({ error: 'steam_openid_cancelled' });
    });

    popup.loadURL(`${API_BASE}/v1/auth/steam/openid/start?return=${encodeURIComponent('/client/')}`)
      .catch((e) => {
        console.error('[launcher] steam login navigation failed:', e && e.message);
        if (!tokenCaptured) finish({ error: 'steam_openid_failed' });
      });
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('ov-steam-login', async () => {
  try {
    return await steamOpenIdLogin();
  } catch (e) {
    console.error('[launcher] steam login failed:', e && e.message);
    return { error: 'steam_openid_failed' };
  }
});

ipcMain.handle('api:health', async () => {
  try { return await apiGet('/health'); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('api:servers', async () => {
  try {
    const res = await apiGet('/v1/servers');
    return Array.isArray(res) ? res : (res.servers ?? []);
  } catch { return []; }
});

ipcMain.handle('api:leaderboard', async (_e, limit = 10) => {
  try { return await apiGet(`/v1/leaderboard?limit=${limit}`); }
  catch { return []; }
});

ipcMain.handle('api:travel', async (_e, { steamId, mode }) => {
  try { return await apiPost('/v1/travel/request', { steamId, mode }); }
  catch (e) { return { error: e.message }; }
});

const MODE_SERVER_MAP = {
  hub: { ip: '127.0.0.1', port: 27015 },
  prophunt: { ip: '127.0.0.1', port: 27016 },
  deathrun: { ip: '127.0.0.1', port: 27017 },
  fortwars: { ip: '127.0.0.1', port: 27018 },
  traitortown: { ip: '127.0.0.1', port: 27019 },
};

function modeForPort(port) {
  for (const [mode, srv] of Object.entries(MODE_SERVER_MAP)) {
    if (srv.port === Number(port)) return mode;
  }
  return 'hub';
}

ipcMain.handle('game:launch', async (_e, { ip, port }) => {
  return launchGame(ip, port, modeForPort(port));
});

ipcMain.handle('game:launch-direct', async (_e, mode) => {
  const srv = MODE_SERVER_MAP[mode] || MODE_SERVER_MAP.hub;
  return launchGame(srv.ip, srv.port, mode in MODE_SERVER_MAP ? mode : 'hub');
});

// Shared display preferences. Invoke with a {w,h,mode} object to set (persists
// to launcher/.ov-display.json and applies to the launcher window right away),
// or with no argument to read. Always returns the current prefs.
ipcMain.handle('ov-display-prefs', (_e, prefs) => {
  if (prefs && typeof prefs === 'object') {
    displayPrefs = sanitizeDisplayPrefs(prefs);
    saveDisplayPrefs();
    applyDisplayPrefsToMainWindow();
  }
  return { ...displayPrefs };
});

ipcMain.handle('game:status', () => ({
  running: gameProcess !== null,
  pid: gameProcess?.pid ?? null,
}));


ipcMain.handle('game:focus', async () => {
  return focusGameWindow();
});

ipcMain.handle('launcher:show', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  return true;
});

ipcMain.on('open-url', (_e, url) => shell.openExternal(url));

ipcMain.on('ui:set-route', (_e, route) => {
  const safe = ['portal', 'servers', 'leaderboard', 'inventory', 'shop', 'settings', 'options', 'console'].includes(route) ? route : 'portal';
  mainWindow?.webContents.send('ui:set-route', safe);
});

// ── Window creation ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    // Startup size/mode comes from the shared display prefs (launcher/.ov-display.json).
    width: displayPrefs.w,
    height: displayPrefs.h,
    fullscreen: displayPrefs.mode === 'fullscreen',
    minWidth: 900,
    minHeight: 600,
    frame: false,          // Custom titlebar in HTML
    backgroundColor: '#0d0d14',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  const root = path.resolve(__dirname, '..');
  ensureClientUiServer(root).then((ok) => {
    if (mainWindow?.isDestroyed()) return;

    if (ok) {
      mainWindow.loadURL(clientUiUrl('portal'));
    } else {
      mainWindow.loadFile(path.join(__dirname, 'index.html'));
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('close', (event) => {
    if (gameProcess && !appIsQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (gameProcess) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appIsQuitting = true;
  closeLoadingOverlay();
  if (uiServerProcess) {
    uiServerProcess.kill();
    uiServerProcess = null;
  }
});

// Titlebar controls via IPC
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
