/*
 * OpenVibe unified shell sync.
 *
 * This script runs in both hosts:
 *   - Electron launcher Chromium
 *   - Source/VGUI embedded HTML panel
 *
 * It keeps the route/theme/state shape identical and communicates navigation
 * through hash routes so Source can open specific panels with commands such as
 * ov_menu_servers, while Electron can load the exact same UI from the local
 * dev UI server.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'openvibe.ui.state.v1';
  const CHANNEL_NAME = 'openvibe-ui-sync-v1';
  const ROUTES = new Set(['portal', 'servers', 'leaderboard', 'inventory', 'shop', 'settings']);
  const isElectron = !!window.OV;
  const url = new URL(window.location.href);
  const isEmbedded = url.searchParams.get('embedded') === '1' || (!isElectron && url.protocol.startsWith('http'));

  let channel = null;
  try {
    channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    channel = null;
  }

  function readState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  function writeState(patch, broadcast = true) {
    const next = {
      ...readState(),
      ...patch,
      updatedAt: Date.now(),
      host: isElectron ? 'electron' : 'source'
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}

    if (broadcast && channel) {
      try {
        channel.postMessage({ type: 'state', state: next });
      } catch {}
    }

    return next;
  }

  function routeFromHash() {
    const hash = (window.location.hash || '').replace(/^#\/?/, '').trim();
    const first = hash.split(/[/?&]/)[0] || '';
    return ROUTES.has(first) ? first : null;
  }

  function routeFromQuery() {
    const route = url.searchParams.get('route');
    return ROUTES.has(route) ? route : null;
  }

  function currentRoute() {
    return routeFromHash() || routeFromQuery() || readState().route || 'portal';
  }

  function setRoute(route, opts = {}) {
    if (!ROUTES.has(route)) route = 'portal';

    if (typeof window.setTab === 'function') {
      try { window.setTab(route); } catch {}
    } else {
      document.querySelectorAll('.nav-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === route);
      });
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${route}`);
      });
    }

    if (!opts.silentHash && window.location.hash !== `#${route}`) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${route}`);
    }

    writeState({ route, embedded: isEmbedded, electron: isElectron }, !opts.fromRemote);

    const evt = new CustomEvent('openvibe:route', { detail: { route, host: isElectron ? 'electron' : 'source' } });
    window.dispatchEvent(evt);
  }

  function installNavSync() {
    document.querySelectorAll('.nav-btn[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const route = btn.dataset.tab;
        if (ROUTES.has(route)) setRoute(route);
      }, { capture: true });
    });
  }

  function installKeyboard() {
    window.addEventListener('keydown', (ev) => {
      const key = ev.key.toLowerCase();

      if (key === 'escape' && isEmbedded) {
        ev.preventDefault();
        window.location.href = 'openvibe://close';
        return;
      }

      if (ev.ctrlKey && key === 'r') {
        ev.preventDefault();
        if (isEmbedded) window.location.href = 'openvibe://reload';
        else window.location.reload();
      }

      if (key === 'f1') {
        ev.preventDefault();
        setRoute('portal');
      }

      if (key === 'f2') {
        ev.preventDefault();
        setRoute('servers');
      }
    });
  }

  function installBridge() {
    window.OpenVibeShell = {
      isElectron,
      isEmbedded,
      routes: Array.from(ROUTES),
      getState: readState,
      setRoute,
      openMode(mode) {
        if (isElectron && window.OV?.launchMode) {
          return window.OV.launchMode(mode);
        }
        window.location.href = `openvibe://join?mode=${encodeURIComponent(mode)}`;
        return true;
      },
      close() {
        if (isElectron && window.OV?.close) window.OV.close();
        else window.location.href = 'openvibe://close';
      },
      reload() {
        if (isEmbedded) window.location.href = 'openvibe://reload';
        else window.location.reload();
      }
    };
  }

  function installRemoteState() {
    if (channel) {
      channel.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type !== 'state' || !msg.state) return;
        if (msg.state.host === (isElectron ? 'electron' : 'source')) return;
        if (ROUTES.has(msg.state.route)) {
          setRoute(msg.state.route, { fromRemote: true, silentHash: false });
        }
      };
    }

    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_KEY || !ev.newValue) return;
      try {
        const state = JSON.parse(ev.newValue);
        if (ROUTES.has(state.route)) setRoute(state.route, { fromRemote: true, silentHash: false });
      } catch {}
    });
  }

  async function hydrateManifestBadge() {
    try {
      const res = await fetch('openvibe-ui-manifest.json', { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      const build = document.querySelector('.sidebar-build');
      if (build && manifest.version) build.textContent = manifest.version;
    } catch {}
  }

  function boot() {
    document.documentElement.classList.toggle('ov-host-electron', isElectron);
    document.documentElement.classList.toggle('ov-host-source', !isElectron);
    document.documentElement.classList.toggle('ov-embedded', isEmbedded);

    installBridge();
    installNavSync();
    installKeyboard();
    installRemoteState();

    setRoute(currentRoute(), { silentHash: false });
    hydrateManifestBadge();

    window.addEventListener('hashchange', () => {
      setRoute(currentRoute(), { silentHash: true });
    });

    console.log(`[OpenVibeShell] ready host=${isElectron ? 'electron' : 'source'} embedded=${isEmbedded} route=${currentRoute()}`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
