#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

echo "[openvibe] next phase: launcher-aware Source loading + client DLL reality guard"
echo "[openvibe] root=$ROOT"

backup() {
  local f="$1"
  [[ -f "$f" ]] && cp "$f" "$f.bak.$(date +%Y%m%d-%H%M%S)"
}

backup launcher/main.js
backup launcher/preload.js
backup launcher/renderer.js
backup launcher/index.html
backup launcher/styles.css
backup tools/run-client-proton.sh

mkdir -p docs game/openvibe.games/resource game/openvibe.games/cfg launcher/assets

cat > docs/CLIENT_DLL_AND_LOADING.md <<'DOC'
# OpenVibe client DLL + loading screen notes

The Proton launcher runs Windows `hl2.exe`. That Windows executable will not load the Linux
`game/openvibe.games/bin/linux64/client.so` produced by the current Source SDK Linux build.

That means native client commands such as `ov_join`, `ov_menu`, `ov_ui`, and the in-game
CEF/HTML menu only exist when a matching client DLL is actually loaded by the game client.
Until we build a Windows `client.dll` or switch to a native Linux client path, the Electron
launcher is the reliable custom Chromium shell.

This phase keeps the Electron launcher visible during Source startup, shows a clear launch
state, and focuses the Source window only after it has appeared and stayed stable for a few
seconds. It also installs best-effort Source resource overrides for the classic loading dialog.
DOC

cat > game/openvibe.games/cfg/autoexec.cfg <<'CFG'
// OpenVibe: Source client defaults
con_enable 1
developer 1
con_timestamp 1
cl_showfps 0

// These are server-side commands unless a matching client DLL is loaded.
echo "[OpenVibe] autoexec loaded. If ov_join/ov_menu are unknown, the custom client DLL is not loaded."
CFG

cat > game/openvibe.games/resource/LoadingDialog.res <<'RES'
"Resource/LoadingDialog.res"
{
    "LoadingDialog"
    {
        "ControlName"       "Frame"
        "fieldName"         "LoadingDialog"
        "xpos"              "0"
        "ypos"              "0"
        "wide"              "f0"
        "tall"              "f0"
        "autoResize"        "0"
        "pinCorner"         "0"
        "visible"           "1"
        "enabled"           "1"
        "tabPosition"       "0"
        "settitlebarvisible" "0"
        "PaintBackgroundType" "2"
        "bgcolor_override"  "7 8 14 255"
    }

    "OpenVibeTitle"
    {
        "ControlName"       "Label"
        "fieldName"         "OpenVibeTitle"
        "xpos"              "c-260"
        "ypos"              "c-72"
        "wide"              "520"
        "tall"              "42"
        "visible"           "1"
        "enabled"           "1"
        "labelText"         "OPENVIBE: SOURCE"
        "textAlignment"     "center"
        "font"              "DefaultVeryLarge"
        "fgcolor_override"  "0 220 255 255"
    }

    "OpenVibeStatus"
    {
        "ControlName"       "Label"
        "fieldName"         "OpenVibeStatus"
        "xpos"              "c-300"
        "ypos"              "c-20"
        "wide"              "600"
        "tall"              "36"
        "visible"           "1"
        "enabled"           "1"
        "labelText"         "Loading OpenVibe shell, servers, and scripts..."
        "textAlignment"     "center"
        "font"              "DefaultLarge"
        "fgcolor_override"  "220 235 255 255"
    }
}
RES

cat > game/openvibe.games/resource/LoadingProgress.res <<'RES'
"Resource/LoadingProgress.res"
{
    "LoadingProgress"
    {
        "ControlName"       "Frame"
        "fieldName"         "LoadingProgress"
        "xpos"              "0"
        "ypos"              "0"
        "wide"              "f0"
        "tall"              "f0"
        "visible"           "1"
        "enabled"           "1"
        "settitlebarvisible" "0"
        "PaintBackgroundType" "2"
        "bgcolor_override"  "7 8 14 255"
    }
}
RES

python3 <<'PY'
from pathlib import Path
import re

p = Path('launcher/main.js')
s = p.read_text()

if 'OPENVIBE_GAME_WINDOW_READY_TIMEOUT_MS' not in s:
    marker = "let appIsQuitting = false;\n"
    helpers = r'''

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
'''
    s = s.replace(marker, marker + helpers)

old = """  mainWindow?.webContents.send('game-started', gameProcess.pid);\n  setTimeout(() => {\n    if (gameProcess && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();\n  }, 750);\n"""
new = """  emitLaunchPhase(\n    'spawned',\n    'Source has started. OpenVibe will keep this launcher visible until the game window is detected and stable.'\n  );\n  mainWindow?.webContents.send('game-started', gameProcess.pid);\n\n  waitForGameWindowReady().then((state) => {\n    if (!gameProcess) return;\n\n    if (state.ready) {\n      emitLaunchPhase(\n        'ready',\n        HIDE_LAUNCHER_ON_GAME_READY\n          ? 'Source window looks ready. Focusing game and hiding launcher.'\n          : 'Source window looks ready. Launcher will stay open so you are not stuck behind a frozen loading screen.',\n        state\n      );\n      focusGameWindow();\n\n      if (HIDE_LAUNCHER_ON_GAME_READY) {\n        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();\n      } else {\n        if (mainWindow && !mainWindow.isDestroyed()) {\n          mainWindow.show();\n          mainWindow.focus();\n        }\n      }\n    } else {\n      emitLaunchPhase(\n        'slow',\n        'Source is taking longer than expected. The launcher is staying visible; use Focus Game when the window appears.',\n        state\n      );\n      if (mainWindow && !mainWindow.isDestroyed()) {\n        mainWindow.show();\n        mainWindow.focus();\n      }\n    }\n  });\n"""
if old in s:
    s = s.replace(old, new)
elif "setTimeout(() =>" in s and "mainWindow.hide" in s:
    s = re.sub(r"\s*mainWindow\?\.webContents\.send\('game-started', gameProcess\.pid\);\s*setTimeout\(\(\) => \{\s*if \(gameProcess && mainWindow && !mainWindow\.isDestroyed\(\)\) mainWindow\.hide\(\);\s*\}, 750\);", "\n" + new, s, count=1, flags=re.S)

if "ipcMain.handle('game:focus'" not in s:
    insert_after = "ipcMain.handle('game:status', () => ({\n  running: gameProcess !== null,\n  pid: gameProcess?.pid ?? null,\n}));\n"
    addition = """

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
"""
    if insert_after in s:
        s = s.replace(insert_after, insert_after + addition)
    else:
        s += addition

p.write_text(s)

p = Path('launcher/preload.js')
s = p.read_text()
if 'focusGame:' not in s:
    s = s.replace("  gameStatus:  ()            => ipcRenderer.invoke('game:status'),", "  gameStatus:  ()            => ipcRenderer.invoke('game:status'),\n  focusGame:   ()            => ipcRenderer.invoke('game:focus'),")
if 'showLauncher:' not in s:
    s = s.replace("  focusGame:   ()            => ipcRenderer.invoke('game:focus'),", "  focusGame:   ()            => ipcRenderer.invoke('game:focus'),\n  showLauncher: ()           => ipcRenderer.invoke('launcher:show'),")
if 'onLaunchPhase:' not in s:
    s = s.replace("  onGameStart: (cb) => ipcRenderer.on('game-started', (_e, pid) => cb(pid)),", "  onGameStart: (cb) => ipcRenderer.on('game-started', (_e, pid) => cb(pid)),\n  onLaunchPhase: (cb) => ipcRenderer.on('game-launch-phase', (_e, info) => cb(info)),")
p.write_text(s)

p = Path('launcher/index.html')
s = p.read_text()
if 'launch-help' not in s:
    s = s.replace(
        '<div class="launch-label" id="launch-label">Launching…</div>\n  <button class="launch-cancel" id="launch-cancel">Cancel</button>',
        '<div class="launch-label" id="launch-label">Launching…</div>\n  <div class="launch-help" id="launch-help">OpenVibe will keep this launcher visible until Source is actually ready.</div>\n  <div class="launch-actions">\n    <button class="launch-cancel" id="launch-focus-game">Focus Game Window</button>\n    <button class="launch-cancel" id="launch-cancel">Dismiss</button>\n  </div>'
    )
p.write_text(s)

p = Path('launcher/styles.css')
s = p.read_text()
if '.launch-help' not in s:
    s += r'''

/* OpenVibe launch guard */
.launch-help {
  margin-top: 10px;
  max-width: 620px;
  color: rgba(220, 235, 255, 0.78);
  font-size: 14px;
  line-height: 1.35;
  text-align: center;
}
.launch-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 18px;
}
'''
p.write_text(s)

p = Path('launcher/renderer.js')
s = p.read_text()
if 'focusGame: () =>' not in s:
    s = s.replace("  gameStatus: () => isElectron ? window.OV.gameStatus() : Promise.resolve({ running: true, pid: null }),", "  gameStatus: () => isElectron ? window.OV.gameStatus() : Promise.resolve({ running: true, pid: null }),\n  focusGame: () => isElectron ? window.OV.focusGame() : Promise.resolve(false),")

if "launch-focus-game" not in s:
    s = s.replace("document.getElementById('launch-cancel')?.addEventListener('click', () => {\n  launchOverlay.classList.remove('show');\n});", "document.getElementById('launch-cancel')?.addEventListener('click', () => {\n  launchOverlay.classList.remove('show');\n});\n\ndocument.getElementById('launch-focus-game')?.addEventListener('click', async () => {\n  const ok = await Bridge.focusGame();\n  toast(ok ? 'Focused Source window.' : 'Source window not found yet.', !ok);\n});")

if 'onLaunchPhase' not in s:
    s = s.replace("  window.OV.onGameStart?.(() => {\n    updateGameStatus(true);\n  });", "  window.OV.onGameStart?.(() => {\n    updateGameStatus(true);\n  });\n  window.OV.onLaunchPhase?.((info) => {\n    const label = document.getElementById('launch-label');\n    const help = document.getElementById('launch-help');\n    if (label && info?.message) label.textContent = info.message;\n    if (help) {\n      if (info?.phase === 'ready') {\n        help.textContent = 'The game window is available. Because the Proton client may not load the custom client DLL, keep this launcher open as the reliable OpenVibe UI.';\n      } else if (info?.phase === 'slow') {\n        help.textContent = 'The game may still be loading or frozen. The launcher is staying visible so you can retry, focus the game, or inspect logs.';\n      } else {\n        help.textContent = 'OpenVibe is waiting for the Source window to appear and stabilize before switching focus.';\n      }\n    }\n    launchOverlay?.classList.add('show');\n  });")
p.write_text(s)
PY

python3 <<'PY'
from pathlib import Path
p = Path('tools/run-client-proton.sh')
s = p.read_text()
if '-condebug' not in s:
    s = s.replace('-console -dev -novid -sw -w 1280 -h 720 \\\n', '-console -condebug -dev -novid -sw -w 1280 -h 720 \\\n')
if '+con_enable 1' not in s:
    s = s.replace('-port 27115 -clientport 27105 \\\n', '-port 27115 -clientport 27105 +con_enable 1 +developer 1 \\\n')
if 'client.so' not in s and 'Windows hl2.exe will not load Linux client.so' not in s:
    s = s.replace('echo "Launching OpenVibe: Source..."', 'echo "Launching OpenVibe: Source..."\necho "NOTE: Proton Windows hl2.exe will not load Linux client.so; Electron launcher remains the reliable custom UI."')
p.write_text(s)
PY

cat > tools/check-openvibe-client-mode.sh <<'CHK'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"

echo "[openvibe] client mode diagnostic"
echo "Windows/Proton launcher: $ROOT/tools/run-client-proton.sh"
echo "Linux client module expected at: $ROOT/game/openvibe.games/bin/linux64/client.so"

if [[ -f "$ROOT/game/openvibe.games/bin/linux64/client.so" ]]; then
  echo "[ok] Linux client.so exists"
else
  echo "[warn] Linux client.so missing; run tools/build-sdk-linux.sh and tools/setup-openvibe-bin.sh"
fi

cat <<'MSG'

If the in-game console says unknown command "ov_join" or "ov_menu", the OpenVibe client DLL is not loaded.
That is expected when launching Windows hl2.exe through Proton while only Linux client.so exists.

Current reliable UI path:
  - Electron launcher / local Chromium UI
  - server-side GameDLL commands

Full in-game HTML menu requires one of:
  1. Run a native Linux Source client that loads bin/linux64/client.so, or
  2. Build a Windows client.dll/server.dll and place them in game/openvibe.games/bin/ for Proton hl2.exe.
MSG
CHK
chmod +x tools/check-openvibe-client-mode.sh

if [[ -x tools/setup-openvibe-bin.sh ]]; then
  tools/setup-openvibe-bin.sh || true
fi

echo
node -c launcher/main.js
node -c launcher/preload.js
node -c launcher/renderer.js

echo
echo "[openvibe] done. Run diagnostics:"
echo "  tools/check-openvibe-client-mode.sh"
echo
echo "[openvibe] restart Electron/game. By default the launcher will stay visible."
echo "[openvibe] To auto-hide only after Source window is stable:"
echo "  OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY=1 npm run dev"
