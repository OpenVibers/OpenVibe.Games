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

let mainWindow = null;
let gameProcess = null;

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

// ── Game launch ────────────────────────────────────────────────────────────────
function launchGame(serverIp, serverPort) {
  const root = path.resolve(__dirname, '..');
  const mod = path.join(root, 'game/openvibe.games');

  // Prefer the Proton-based launcher (Windows hl2.exe via GE-Proton)
  const protonScript = path.join(root, 'tools/run-client-proton.sh');
  const steamRoot = process.env.HOME + '/.steam/steam';
  const hl2Exe = '/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe';

  const hasProton = fs.existsSync(path.join(steamRoot, 'compatibilitytools.d/GE-Proton10-34/proton'));
  const hasHl2 = fs.existsSync(hl2Exe);

  if (!hasProton || !hasHl2) {
    dialog.showErrorBox('Game Not Found',
      !hasHl2
        ? `hl2.exe not found at:\n${hl2Exe}`
        : 'GE-Proton10-34 not found.\nInstall it via ProtonUp-Qt or manually.');
    return false;
  }

  // Build arguments to pass through the shell script
  const scriptArgs = serverIp && serverPort ? [serverIp, String(serverPort)] : [];

  console.log('[launcher] spawning via Proton:', protonScript, scriptArgs.join(' '));

  gameProcess = spawn('bash', [protonScript, ...scriptArgs], {
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
  });

  // Detach so the game keeps running if Electron is closed
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

ipcMain.handle('game:launch', (_e, { ip, port }) => {
  return launchGame(ip, port);
});

ipcMain.handle('game:launch-direct', (_e, mode) => {
  // Look up the mode's port from local server list
  // Use 127.0.1.1 (workstation hostname) instead of 127.0.0.1 since that's where
  // the Source engine binds the server when resolving localhost via /etc/hosts
  const serverMap = {
    hub: { ip: '127.0.1.1', port: 27015 },
    prophunt: { ip: '127.0.1.1', port: 27016 },
    deathrun: { ip: '127.0.1.1', port: 27017 },
    fortwars: { ip: '127.0.1.1', port: 27018 },
    traitortown: { ip: '127.0.1.1', port: 27019 },
  };
  const srv = serverMap[mode] || serverMap.hub;
  return launchGame(srv.ip, srv.port);
});

ipcMain.handle('game:status', () => ({
  running: gameProcess !== null,
  pid: gameProcess?.pid ?? null,
}));

ipcMain.on('open-url', (_e, url) => shell.openExternal(url));

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

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
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
  if (process.platform !== 'darwin') app.quit();
});

// Titlebar controls via IPC
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
