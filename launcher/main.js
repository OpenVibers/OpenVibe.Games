// OpenVibe Launcher — Electron main process
// Embeds Chromium via Electron for the custom main menu
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
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
const HIDE_LAUNCHER_ON_GAME_READY = process.env.OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY === '1';

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

// ── Game launch ────────────────────────────────────────────────────────────────
async function launchGame(serverIp, serverPort) {
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
    },
  });

  gameProcess.stdout.on('data', (d) => console.log('[game]', d.toString().trim()));
  gameProcess.stderr.on('data', (d) => console.error('[game]', d.toString().trim()));
  gameProcess.on('exit', (code) => {
    console.log('[launcher] game exited with code', code);
    gameProcess = null;
    mainWindow?.webContents.send('game-exited', code);
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow?.webContents.send('game-started', gameProcess.pid);

  // Keep Electron visible by default so users are not dumped behind a frozen Source loading window.
  // Advanced: set OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY=1 to hide after a conservative delay.
  if (process.env.OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY === '1') {
    setTimeout(() => {
      if (gameProcess && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    }, Number(process.env.OPENVIBE_GAME_READY_HIDE_DELAY_MS || 12000));
  }

  gameProcess.unref();
  return true;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
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

ipcMain.handle('game:launch', async (_e, { ip, port }) => {
  return launchGame(ip, port);
});

ipcMain.handle('game:launch-direct', async (_e, mode) => {
  // Look up the mode's port from local server list
  const serverMap = {
    hub: { ip: '127.0.0.1', port: 27015 },
    prophunt: { ip: '127.0.0.1', port: 27016 },
    deathrun: { ip: '127.0.0.1', port: 27017 },
    fortwars: { ip: '127.0.0.1', port: 27018 },
    traitortown: { ip: '127.0.0.1', port: 27019 },
  };
  const srv = serverMap[mode] || serverMap.hub;
  return launchGame(srv.ip, srv.port);
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
    width: 1280,
    height: 800,
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
