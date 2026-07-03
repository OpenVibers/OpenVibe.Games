/*
 * OpenVibe unified shell sync (client/ui-sync.js).
 *
 * Runs in every host of the unified app:
 *   - Electron launcher Chromium  (?electron=1&shell=electron)
 *   - Source/VGUI embedded panel  (?embedded=1&shell=source)
 *   - Plain browser (backend :3000 /client/, or dev server :5173)
 *
 * Keeps the route/state contract identical across hosts:
 *   - location.hash
 *   - localStorage["openvibe.ui.state.v1"]
 *   - BroadcastChannel("openvibe-ui-sync-v1")
 *
 * Adapted from launcher/openvibe-ui-sync.js with the extended route set
 * (options, console, hud) for the GModJS platform.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'openvibe.ui.state.v1';
  const CHANNEL_NAME = 'openvibe-ui-sync-v1';
  const ROUTES = new Set([
    'portal', 'servers', 'leaderboard', 'inventory', 'shop',
    'settings', 'options', 'console', 'hud',
  ]);

  const url = new URL(window.location.href);
  // window.OV exists in BOTH hosts (preload bridge in Electron, inline app
  // object in-game), so detect Electron by query params / preload-only API.
  const isElectron =
    url.searchParams.get('shell') === 'electron' ||
    url.searchParams.get('electron') === '1' ||
    !!(window.OV && typeof window.OV.launchMode === 'function' && typeof window.OV.minimize === 'function');
  const isEmbedded =
    url.searchParams.get('embedded') === '1' ||
    url.searchParams.get('shell') === 'source';

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
    if (url.searchParams.get('hud') === '1') return 'hud';
    const route = url.searchParams.get('route');
    return ROUTES.has(route) ? route : null;
  }

  function currentRoute() {
    return routeFromHash() || routeFromQuery() || readState().route || 'portal';
  }

  function applyRouteToDom(route) {
    // Unified app exposes routeTo (client/index.html); prefer it.
    if (typeof window.routeTo === 'function') {
      try { window.routeTo(route); return; } catch {}
    }
    if (typeof window.setTab === 'function') {
      try { window.setTab(route); return; } catch {}
    }
    // Generic fallback for both markup dialects.
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.route === route);
    });
    document.querySelectorAll('.route').forEach((p) => {
      p.classList.toggle('active', p.id === `route-${route}`);
    });
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === route);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${route}`);
    });
  }

  function setRoute(route, opts = {}) {
    if (!ROUTES.has(route)) route = 'portal';

    applyRouteToDom(route);

    if (!opts.silentHash && window.location.hash !== `#${route}`) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${route}`);
    }

    writeState({ route, embedded: isEmbedded, electron: isElectron }, !opts.fromRemote);

    const evt = new CustomEvent('openvibe:route', { detail: { route, host: isElectron ? 'electron' : 'source' } });
    window.dispatchEvent(evt);
  }

  function installKeyboard() {
    window.addEventListener('keydown', (ev) => {
      const key = (ev.key || '').toLowerCase();
      const target = ev.target;
      const typing = !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));

      if (key === 'escape' && isEmbedded) {
        ev.preventDefault();
        window.location.href = 'openvibe://close';
        return;
      }

      if (ev.ctrlKey && key === 'r') {
        ev.preventDefault();
        if (isEmbedded) window.location.href = 'openvibe://reload';
        else window.location.reload();
        return;
      }

      // ` (backquote) or F10 toggles the console route.
      if (key === '`' || key === 'f10') {
        if (key === '`' && typing) return; // let people type backticks
        ev.preventDefault();
        setRoute(currentRoute() === 'console' ? 'portal' : 'console');
        return;
      }

      if (typing) return;

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
      // Sync UI prefs (openvibe.options.v1) to the other host.
      syncOptions(options) {
        if (!options || typeof options !== 'object') return;
        writeState({ options });
      },
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

  function applyRemoteState(state) {
    if (!state || typeof state !== 'object') return;
    if (state.options && window.OVApp && typeof window.OVApp.applyOptions === 'function') {
      try { window.OVApp.applyOptions(state.options, true); } catch {}
    }
    // Never yank the other host into HUD-overlay mode remotely.
    if (ROUTES.has(state.route) && state.route !== 'hud') {
      setRoute(state.route, { fromRemote: true, silentHash: false });
    }
  }

  function installRemoteState() {
    if (channel) {
      channel.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type !== 'state' || !msg.state) return;
        if (msg.state.host === (isElectron ? 'electron' : 'source')) return;
        applyRemoteState(msg.state);
      };
    }

    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_KEY || !ev.newValue) return;
      try {
        applyRemoteState(JSON.parse(ev.newValue));
      } catch {}
    });
  }

  function boot() {
    document.documentElement.classList.toggle('ov-host-electron', isElectron);
    document.documentElement.classList.toggle('ov-host-source', !isElectron);
    document.documentElement.classList.toggle('ov-embedded', isEmbedded);

    installBridge();
    installKeyboard();
    installRemoteState();

    setRoute(currentRoute(), { silentHash: false });

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
