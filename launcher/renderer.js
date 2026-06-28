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

const PLAYER_IDS = {
  hub: 'hub-players', prophunt: 'ph-players',
  deathrun: 'dr-players', fortwars: 'fw-players', traitortown: 'tt-players',
};

let currentTab = 'portal';
let serverData  = [];
let apiOnline   = false;

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
document.getElementById('btn-min')?.addEventListener('click', () => window.OV.minimize());
document.getElementById('btn-max')?.addEventListener('click', () => window.OV.maximize());
document.getElementById('btn-close')?.addEventListener('click', () => window.OV.close());

// ── Launch overlay ───────────────────────────────────────────────────────────
const launchOverlay = document.getElementById('launch-overlay');
const launchLabel   = document.getElementById('launch-label');

document.getElementById('launch-cancel')?.addEventListener('click', () => {
  launchOverlay.classList.remove('show');
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
    const ok = await window.OV.launchMode(mode);
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
window.OV.onGameExit((code) => {
  hideLaunchOverlay();
  updateGameStatus(false);
  toast(`Game exited (code ${code})`);
});

// ── API health ────────────────────────────────────────────────────────────────
const apiDot    = document.getElementById('api-dot');
const apiLabel  = document.getElementById('api-label');
const srvCount  = document.getElementById('server-count');

async function checkApiHealth() {
  try {
    const data = await window.OV.health();
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
    const servers = await window.OV.servers();
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
    const data = await window.OV.leaderboard(20);

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
    const servers = await window.OV.servers();
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
      const status = await window.OV.gameStatus();
      updateGameStatus(status.running);
    } catch {}
  }, 10_000);
}

init();
