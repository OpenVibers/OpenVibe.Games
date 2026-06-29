// renderer.js — OpenVibe Launcher frontend logic
// Runs inside Electron's Chromium renderer process
'use strict';

// ── Mode metadata ────────────────────────────────────────────────────────────
const MODES = {
  hub:          { label: 'Hub',          port: 27015, color: '#00c8ff' },
  prophunt:     { label: 'Prop Hunt',    port: 27016, color: '#06ffa5' },
  deathrun:     { label: 'Deathrun',     port: 27017, color: '#ff3366' },
  fortwars:     { label: 'Fort Wars',    port: 27018, color: '#ffaa00' },
  traitortown:  { label: 'Traitor Town', port: 27019, color: '#a855f7' },
};

const API_BASE = 'http://127.0.0.1:3000';
const isElectron = !!window.OV;
const isEmbedded = new URLSearchParams(window.location.search).get('embedded') === '1' || !isElectron;

document.documentElement.classList.toggle('embedded', isEmbedded);
document.body.classList.toggle('embedded', isEmbedded);

const PLAYER_IDS = {
  hub: 'hub-players', prophunt: 'ph-players',
  deathrun: 'dr-players', fortwars: 'fw-players', traitortown: 'tt-players',
};

let currentTab = 'portal';
let serverData  = [];
let apiOnline   = false;

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Accept': 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const Bridge = {
  health: () => isElectron ? window.OV.health() : apiFetch('/health'),
  servers: async () => {
    if (isElectron) return window.OV.servers();
    const data = await apiFetch('/v1/servers');
    return Array.isArray(data) ? data : (data.servers ?? []);
  },
  leaderboard: async (limit) => {
    if (isElectron) return window.OV.leaderboard(limit);
    const data = await apiFetch(`/v1/leaderboard?limit=${limit}`);
    return Array.isArray(data) ? data : (data.players ?? []);
  },
  launchMode: async (mode) => {
    if (isElectron) return window.OV.launchMode(mode);
    window.location.href = `openvibe://join?mode=${encodeURIComponent(mode)}`;
    return true;
  },
  gameStatus: () => isElectron ? window.OV.gameStatus() : Promise.resolve({ running: true, pid: null }),
  focusGame: () => isElectron ? window.OV.focusGame() : Promise.resolve(false),
  close: () => {
    if (isElectron) window.OV.close();
    else window.location.href = 'openvibe://close';
  },
  minimize: () => { if (isElectron) window.OV.minimize(); },
  maximize: () => { if (isElectron) window.OV.maximize(); },
};

// ── Toast helper ─────────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, isErr = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = 'toast show' + (isErr ? ' error' : '');
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3500);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (!tab) return;
    setTab(tab);
  });
});

function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tab}`);
  });
  if (tab === 'servers')     refreshServers();
  if (tab === 'leaderboard') refreshLeaderboard();
}

// ── Titlebar controls ────────────────────────────────────────────────────────
document.getElementById('btn-min')?.addEventListener('click', () => Bridge.minimize());
document.getElementById('btn-max')?.addEventListener('click', () => Bridge.maximize());
document.getElementById('btn-close')?.addEventListener('click', () => Bridge.close());
document.getElementById('embedded-close')?.addEventListener('click', () => Bridge.close());

// ── Launch overlay ───────────────────────────────────────────────────────────
const launchOverlay = document.getElementById('launch-overlay');
const launchLabel   = document.getElementById('launch-label');

document.getElementById('launch-cancel')?.addEventListener('click', () => {
  launchOverlay.classList.remove('show');
});

document.getElementById('launch-focus-game')?.addEventListener('click', async () => {
  const ok = await Bridge.focusGame();
  toast(ok ? 'Focused Source window.' : 'Source window not found yet.', !ok);
});

function showLaunchOverlay(msg) {
  launchLabel.textContent = msg;
  launchOverlay.classList.add('show');
}
function hideLaunchOverlay() {
  launchOverlay.classList.remove('show');
}

// ── Game launch ───────────────────────────────────────────────────────────────
async function launchMode(mode) {
  const info = MODES[mode];
  if (!info) return;

  showLaunchOverlay(`Launching ${info.label}…`);
  toast(`Connecting to ${info.label}…`);

  try {
    const ok = await Bridge.launchMode(mode);
    if (ok) {
      toast(`✓ ${info.label} launched — port ${info.port}`);
      updateGameStatus(true);
    } else {
      hideLaunchOverlay();
      toast('Game binary not found. Build the SDK first.', true);
    }
  } catch (e) {
    hideLaunchOverlay();
    toast('Launch failed: ' + e.message, true);
  }
}

// Portal card play buttons
document.querySelectorAll('.card-play-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    launchMode(btn.dataset.mode);
  });
});

// Portal card click (anywhere on card)
document.querySelectorAll('.portal-card').forEach((card) => {
  card.addEventListener('click', () => launchMode(card.dataset.mode));
});

// Settings launch button
document.getElementById('settings-launch')?.addEventListener('click', () => {
  const mode = document.getElementById('set-launch-mode')?.value || 'hub';
  launchMode(mode);
});

// Game exit callback
if (isElectron) {
  window.OV.onGameStart?.(() => {
    updateGameStatus(true);
  });
  window.OV.onLaunchPhase?.((info) => {
    const label = document.getElementById('launch-label');
    const help = document.getElementById('launch-help');
    if (label && info?.message) label.textContent = info.message;
    if (help) {
      if (info?.phase === 'ready') {
        help.textContent = 'The game window is available. Because the Proton client may not load the custom client DLL, keep this launcher open as the reliable OpenVibe UI.';
      } else if (info?.phase === 'slow') {
        help.textContent = 'The game may still be loading or frozen. The launcher is staying visible so you can retry, focus the game, or inspect logs.';
      } else {
        help.textContent = 'OpenVibe is waiting for the Source window to appear and stabilize before switching focus.';
      }
    }
    launchOverlay?.classList.add('show');
  });
  window.OV.onGameExit((code) => {
    hideLaunchOverlay();
    updateGameStatus(false);
    toast(`Game exited (code ${code})`);
  });
}

// ── API health ────────────────────────────────────────────────────────────────
const apiDot    = document.getElementById('api-dot');
const apiLabel  = document.getElementById('api-label');
const srvCount  = document.getElementById('server-count');

async function checkApiHealth() {
  try {
    const data = await Bridge.health();
    if (data.ok) {
      apiOnline = true;
      apiDot.className = 'status-dot up';
      apiLabel.textContent = data.service || 'API online';
      return true;
    }
  } catch {}
  apiOnline = false;
  apiDot.className = 'status-dot down';
  apiLabel.textContent = 'API offline';
  return false;
}

function updateGameStatus(running) {
  const el = document.getElementById('game-status-label');
  if (el) el.textContent = running ? 'Game: running' : 'Game: idle';
}

// ── Server browser ────────────────────────────────────────────────────────────
async function refreshServers() {
  const tbody = document.getElementById('server-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" class="loading-row">Loading…</td></tr>';

  try {
    const servers = await Bridge.servers();
    serverData = servers;

    if (!servers || servers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No servers online</td></tr>';
      srvCount.textContent = '0 servers';
      return;
    }

    srvCount.textContent = `${servers.length} server${servers.length !== 1 ? 's' : ''}`;

    tbody.innerHTML = servers.map((s) => {
      const mode    = s.mode || 'unknown';
      const players = s.playerCount != null ? `${s.playerCount}/${s.maxPlayers}` : '—';
      const ip      = s.publicHost || '127.0.0.1';
      const port    = s.port || 27015;
      const map     = s.mapName || '—';
      return `<tr>
        <td>${escHtml(s.serverId || ip + ':' + port)}</td>
        <td><span class="mode-badge mode-${mode}">${escHtml(mode)}</span></td>
        <td>${escHtml(map)}</td>
        <td>${players}</td>
        <td><span class="${pingClass(s.ping)}">—</span></td>
        <td><button class="connect-btn" data-ip="${escHtml(ip)}" data-port="${port}" data-mode="${mode}">Connect</button></td>
      </tr>`;
    }).join('');

    // Wire connect buttons
    tbody.querySelectorAll('.connect-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        launchMode(mode in MODES ? mode : 'hub');
      });
    });

    // Update portal card player counts
    servers.forEach((s) => {
      const el = document.getElementById(PLAYER_IDS[s.mode]);
      if (el && s.playerCount != null) {
        el.textContent = `⬤ ${s.playerCount}/${s.maxPlayers} players`;
      }
    });

  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Failed to load: ${escHtml(e.message)}</td></tr>`;
  }
}

function pingClass(ms) {
  if (ms == null) return '';
  if (ms < 60)  return 'ping-ok';
  if (ms < 120) return 'ping-mid';
  return 'ping-bad';
}

document.getElementById('refresh-servers')?.addEventListener('click', refreshServers);

// ── Leaderboard ───────────────────────────────────────────────────────────────
async function refreshLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  list.innerHTML = '<li class="loading-row">Loading…</li>';

  try {
    const data = await Bridge.leaderboard(20);

    if (!data || data.length === 0) {
      list.innerHTML = '<li class="loading-row">No rankings yet — play some games!</li>';
      return;
    }

    list.innerHTML = data.map((entry, i) => {
      const rank  = i + 1;
      const cls   = rank === 1 ? 'lb-rank-1' : rank === 2 ? 'lb-rank-2' : rank === 3 ? 'lb-rank-3' : 'lb-rank-n';
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const xp    = Number(entry.xp || 0).toLocaleString();
      const lvl   = entry.level != null ? `Lv ${entry.level}` : '';
      return `<li>
        <span class="lb-rank ${cls}">${medal}</span>
        <span class="lb-name">${escHtml(entry.name || entry.steamId || 'Unknown')}</span>
        <span class="lb-xp">${xp} XP</span>
        <span class="lb-level">${lvl}</span>
      </li>`;
    }).join('');

  } catch (e) {
    list.innerHTML = `<li class="loading-row">Failed: ${escHtml(e.message)}</li>`;
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Initial health check
  await checkApiHealth();

  // Load server player counts for portal cards
  try {
    const servers = await Bridge.servers();
    serverData = servers;
    srvCount.textContent = `${servers.length} server${servers.length !== 1 ? 's' : ''}`;
    servers.forEach((s) => {
      const el = document.getElementById(PLAYER_IDS[s.mode]);
      if (el) {
        el.textContent = s.playerCount != null
          ? `⬤ ${s.playerCount}/${s.maxPlayers} players`
          : `⬤ 0/${s.maxPlayers} players`;
      }
    });
  } catch {}

  // Poll health + game status every 10s
  setInterval(async () => {
    await checkApiHealth();
    try {
      const status = await Bridge.gameStatus();
      updateGameStatus(status.running);
    } catch {}
  }, 10_000);
}

init();


// Launcher-aware Source startup status. This keeps Electron useful while Proton
// shows the default Source loading window and before a native client DLL exists.
if (isElectron && window.OV.onLaunchState) {
  window.OV.onLaunchState((state) => {
    const label = document.getElementById('launch-label');
    const sub = document.getElementById('launch-sub');
    if (label && state?.message) label.textContent = state.message;
    if (sub) {
      sub.textContent = state?.phase === 'ready'
        ? 'Game window is ready. Use Focus Game Window, or keep Electron open as the custom menu.'
        : 'Electron remains open so you are not left staring at a frozen/default Source loading screen.';
    }
    if (state?.phase && state.phase !== 'idle') launchOverlay?.classList.add('show');
  });
}
