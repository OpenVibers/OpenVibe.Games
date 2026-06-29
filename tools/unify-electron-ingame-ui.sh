#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
RUN_BUILD="${RUN_BUILD:-1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

echo "[openvibe] phase: unified Electron + in-game embedded browser UI"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "[openvibe] missing required file: $file" >&2
    exit 1
  fi
}

require_file "launcher/index.html"
require_file "launcher/renderer.js"
require_file "launcher/main.js"
require_file "launcher/preload.js"
require_file "sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp"
require_file "tools/apply-openvibe-sdk.sh"

mkdir -p launcher/assets game/openvibe.games/resource tools

echo "[openvibe] writing shared UI manifest"
cat > launcher/openvibe-ui-manifest.json <<'JSON'
{
  "name": "OpenVibe Unified Shell",
  "version": "2026.06.28-ui-sync",
  "origin": "openvibe.games",
  "defaultRoute": "portal",
  "routes": [
    { "id": "portal", "label": "Portal", "kind": "play" },
    { "id": "servers", "label": "Servers", "kind": "play" },
    { "id": "leaderboard", "label": "Leaderboard", "kind": "profile" },
    { "id": "inventory", "label": "Inventory", "kind": "profile" },
    { "id": "shop", "label": "Shop", "kind": "profile" },
    { "id": "settings", "label": "Settings", "kind": "system" }
  ],
  "modes": {
    "hub": { "label": "Hub", "port": 27015 },
    "prophunt": { "label": "Prop Hunt", "port": 27016 },
    "deathrun": { "label": "Deathrun", "port": 27017 },
    "fortwars": { "label": "Fort Wars", "port": 27018 },
    "traitortown": { "label": "Traitor Town", "port": 27019 }
  }
}
JSON

echo "[openvibe] writing cross-host UI sync script"
cat > launcher/openvibe-ui-sync.js <<'JS'
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
JS

echo "[openvibe] patching launcher/index.html to load sync script"
backup_file launcher/index.html
python3 <<'PY'
from pathlib import Path

p = Path("launcher/index.html")
s = p.read_text()

if '<script src="openvibe-ui-sync.js"></script>' not in s:
    if '<script src="renderer.js"></script>' in s:
        s = s.replace(
            '<script src="renderer.js"></script>',
            '<script src="renderer.js"></script>\n<script src="openvibe-ui-sync.js"></script>'
        )
    else:
        s = s.replace('</body>', '<script src="renderer.js"></script>\n<script src="openvibe-ui-sync.js"></script>\n</body>')

# Remove external font dependency for in-game CEF/offline use; CSS already has fallbacks.
s = s.replace('  <link rel="preconnect" href="https://fonts.googleapis.com" />\n', '')
s = s.replace('  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Orbitron:wght@700;900&family=Inter:wght@400;500&display=swap" rel="stylesheet" />\n', '')

p.write_text(s)
PY

echo "[openvibe] patching Electron to load the same local UI server URL as the in-game browser"
backup_file launcher/main.js
python3 <<'PY'
from pathlib import Path

p = Path("launcher/main.js")
s = p.read_text()

# Add UI URL helper once.
if "function clientUiUrl" not in s:
    marker = "function waitForHttp(url, timeoutMs = 5000) {"
    idx = s.find(marker)
    if idx == -1:
        raise SystemExit("Could not find waitForHttp in launcher/main.js")
    helper = r'''
function clientUiUrl(route = 'portal', extraParams = {}) {
  const params = new URLSearchParams({
    electron: '1',
    shell: 'electron',
    ...extraParams,
  });
  return `http://127.0.0.1:${CLIENT_UI_PORT}/client/?${params.toString()}#${encodeURIComponent(route)}`;
}

'''
    s = s[:idx] + helper + s[idx:]

# Replace loadFile with ensured local UI server loadURL.
old = "  mainWindow.loadFile(path.join(__dirname, 'index.html'));"
new = r'''  const root = path.resolve(__dirname, '..');
  ensureClientUiServer(root).then((ok) => {
    if (mainWindow?.isDestroyed()) return;

    if (ok) {
      mainWindow.loadURL(clientUiUrl('portal'));
    } else {
      mainWindow.loadFile(path.join(__dirname, 'index.html'));
    }
  });'''
if old in s:
    s = s.replace(old, new)
elif "clientUiUrl('portal')" not in s:
    raise SystemExit("Could not patch launcher/main.js loadFile/loadURL block")

# Add a route IPC for future native route changes.
if "ui:set-route" not in s:
    marker = "ipcMain.on('open-url', (_e, url) => shell.openExternal(url));"
    if marker in s:
        s = s.replace(marker, marker + r'''

ipcMain.on('ui:set-route', (_e, route) => {
  const safe = ['portal', 'servers', 'leaderboard', 'inventory', 'shop', 'settings'].includes(route) ? route : 'portal';
  mainWindow?.webContents.send('ui:set-route', safe);
});''')

p.write_text(s)
PY

echo "[openvibe] patching Electron preload route IPC"
backup_file launcher/preload.js
python3 <<'PY'
from pathlib import Path

p = Path("launcher/preload.js")
s = p.read_text()

if "setRoute:" not in s:
    s = s.replace(
        "  openUrl:     (url)         => ipcRenderer.send('open-url', url),",
        "  openUrl:     (url)         => ipcRenderer.send('open-url', url),\n  setRoute:    (route)       => ipcRenderer.send('ui:set-route', route),"
    )

if "onRoute:" not in s:
    s = s.replace(
        "  onGameExit: (cb) => ipcRenderer.on('game-exited', (_e, code) => cb(code)),",
        "  onGameExit: (cb) => ipcRenderer.on('game-exited', (_e, code) => cb(code)),\n  onRoute:    (cb) => ipcRenderer.on('ui:set-route', (_e, route) => cb(route)),"
    )

p.write_text(s)
PY

echo "[openvibe] patching in-game embedded browser commands/routes"
backup_file sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp
python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp")
s = p.read_text()

# Route the default menu to the shared local web shell.
s = re.sub(
    r'("ov_menu_url",\s*)\n\s*"[^"]+"',
    r'\1\n\t"http://127.0.0.1:5173/client/?embedded=1&shell=source#portal"',
    s,
    count=1
)

# Remove previous route block if rerun.
s = re.sub(
    r'\n// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_BEGIN.*?// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_END\n',
    '\n',
    s,
    flags=re.S
)

route_block = r'''
// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_BEGIN
static void OV_OpenMenuRoute( const char *pszRoute )
{
	char szBase[512];
	Q_strncpy( szBase, ov_menu_url.GetString(), sizeof( szBase ) );

	for ( int i = 0; szBase[i]; ++i )
	{
		if ( szBase[i] == '#' )
		{
			szBase[i] = '\0';
			break;
		}
	}

	const char *pszSafeRoute =
		( pszRoute && pszRoute[0] ) ? pszRoute : "portal";

	char szURL[768];
	Q_snprintf( szURL, sizeof( szURL ), "%s#%s", szBase, pszSafeRoute );

	OV_GetHTMLMenu()->Open( szURL );
}

static void OV_MenuMain_f( const CCommand &args ) { OV_OpenMenuRoute( "portal" ); }
static void OV_MenuServers_f( const CCommand &args ) { OV_OpenMenuRoute( "servers" ); }
static void OV_MenuLeaderboard_f( const CCommand &args ) { OV_OpenMenuRoute( "leaderboard" ); }
static void OV_MenuInventory_f( const CCommand &args ) { OV_OpenMenuRoute( "inventory" ); }
static void OV_MenuShop_f( const CCommand &args ) { OV_OpenMenuRoute( "shop" ); }
static void OV_MenuSettings_f( const CCommand &args ) { OV_OpenMenuRoute( "settings" ); }

static ConCommand ov_ui_cmd(
	"ov_ui",
	OV_MenuMain_f,
	"Open the synced OpenVibe HTML UI.",
	FCVAR_CLIENTDLL );

static ConCommand ov_main_menu_cmd(
	"ov_main_menu",
	OV_MenuMain_f,
	"Open the custom OpenVibe main menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_main_cmd(
	"ov_menu_main",
	OV_MenuMain_f,
	"Open the OpenVibe portal route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_servers_cmd(
	"ov_menu_servers",
	OV_MenuServers_f,
	"Open the OpenVibe server browser route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_leaderboard_cmd(
	"ov_menu_leaderboard",
	OV_MenuLeaderboard_f,
	"Open the OpenVibe leaderboard route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_inventory_cmd(
	"ov_menu_inventory",
	OV_MenuInventory_f,
	"Open the OpenVibe inventory route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_shop_cmd(
	"ov_menu_shop",
	OV_MenuShop_f,
	"Open the OpenVibe shop route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_settings_route_cmd(
	"ov_menu_settings",
	OV_MenuSettings_f,
	"Open the OpenVibe settings route.",
	FCVAR_CLIENTDLL );
// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_END
'''

# Append route commands at EOF.
s = s.rstrip() + "\n" + route_block + "\n"

p.write_text(s)
PY

echo "[openvibe] writing custom Source GameMenu.res override"
backup_file game/openvibe.games/resource/GameMenu.res
cat > game/openvibe.games/resource/GameMenu.res <<'RES'
"GameMenu"
{
    "1"
    {
        "label" "OpenVibe Main Menu"
        "command" "engine ov_menu_main"
        "OnlyInGame" "0"
    }
    "2"
    {
        "label" "Server Browser"
        "command" "engine ov_menu_servers"
        "OnlyInGame" "0"
    }
    "3"
    {
        "label" ""
        "command" ""
        "OnlyInGame" "0"
    }
    "4"
    {
        "label" "Enter Hub"
        "command" "engine ov_join hub"
        "OnlyInGame" "0"
    }
    "5"
    {
        "label" "Prop Hunt"
        "command" "engine ov_join prophunt"
        "OnlyInGame" "0"
    }
    "6"
    {
        "label" "Deathrun"
        "command" "engine ov_join deathrun"
        "OnlyInGame" "0"
    }
    "7"
    {
        "label" "Fort Wars"
        "command" "engine ov_join fortwars"
        "OnlyInGame" "0"
    }
    "8"
    {
        "label" "Traitor Town"
        "command" "engine ov_join traitortown"
        "OnlyInGame" "0"
    }
    "9"
    {
        "label" ""
        "command" ""
        "OnlyInGame" "0"
    }
    "10"
    {
        "label" "Inventory"
        "command" "engine ov_menu_inventory"
        "OnlyInGame" "0"
    }
    "11"
    {
        "label" "Shop"
        "command" "engine ov_menu_shop"
        "OnlyInGame" "0"
    }
    "12"
    {
        "label" "Settings"
        "command" "engine ov_menu_settings"
        "OnlyInGame" "0"
    }
    "13"
    {
        "label" ""
        "command" ""
        "OnlyInGame" "0"
    }
    "14"
    {
        "label" "Options"
        "command" "OpenOptionsDialog"
        "OnlyInGame" "0"
    }
    "15"
    {
        "label" "Quit"
        "command" "Quit"
        "OnlyInGame" "0"
    }
}
RES

echo "[openvibe] adding launcher README for unified UI contract"
cat > launcher/UNIFIED_UI.md <<'MD'
# OpenVibe Unified UI Shell

The Electron launcher and the in-game Source/VGUI embedded browser now load the same web shell.

## Hosts

- Electron loads `http://127.0.0.1:5173/client/?electron=1&shell=electron#portal`
- Source/VGUI loads `http://127.0.0.1:5173/client/?embedded=1&shell=source#portal`

Both are served by `tools/serve-client-ui.mjs` from the `launcher/` folder.

## In-game commands

- `ov_ui`
- `ov_main_menu`
- `ov_menu_main`
- `ov_menu_servers`
- `ov_menu_leaderboard`
- `ov_menu_inventory`
- `ov_menu_shop`
- `ov_menu_settings`
- `ov_menu_close`
- `ov_menu_reload`

## Bridge URLs

The in-game HTML panel accepts allowlisted `openvibe://` actions:

- `openvibe://join?mode=hub`
- `openvibe://join?mode=prophunt`
- `openvibe://join?mode=deathrun`
- `openvibe://join?mode=fortwars`
- `openvibe://join?mode=traitortown`
- `openvibe://close`
- `openvibe://reload`

Electron receives equivalent actions through `window.OV` in `preload.js`.

## Sync model

`launcher/openvibe-ui-sync.js` keeps route state in:

- `location.hash`
- `localStorage["openvibe.ui.state.v1"]`
- `BroadcastChannel("openvibe-ui-sync-v1")`

That gives Electron and in-game the same route/state contract without duplicating UI code.
MD

echo "[openvibe] validating JavaScript syntax"
node --check launcher/openvibe-ui-sync.js
node --check launcher/renderer.js
node --check launcher/main.js
node --check launcher/preload.js
node --check tools/serve-client-ui.mjs

echo "[openvibe] applying SDK patch"
tools/apply-openvibe-sdk.sh

echo "[openvibe] checking generated SDK VGUI commands"
grep -nE 'ov_ui|ov_main_menu|ov_menu_(main|servers|leaderboard|inventory|shop|settings)' \
  "$SDK/src/game/client/hl2mp/vgui_openvibe_menu.cpp" || true

if [[ "$RUN_BUILD" == "1" ]]; then
  echo "[openvibe] building SDK"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

  echo "[openvibe] setup OpenVibe bin"
  tools/setup-openvibe-bin.sh

  echo
  echo "[openvibe] unified UI phase complete."
  echo
  echo "Runtime:"
  echo "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
  echo
  echo "Client console:"
  echo "  ov_ui"
  echo "  ov_menu_main"
  echo "  ov_menu_servers"
  echo "  ov_menu_inventory"
  echo "  ov_menu_shop"
  echo "  ov_menu_settings"
  echo
  echo "Electron:"
  echo "  cd launcher && npm install && npm run dev"
else
  echo "[openvibe] RUN_BUILD=0; skipped SDK build"
fi
