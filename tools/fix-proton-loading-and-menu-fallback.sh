#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

echo "[openvibe] next phase: Proton-aware loading UX + fallback menu aliases"
echo "[openvibe] root=$ROOT"

mkdir -p game/openvibe.games/cfg game/openvibe.games/resource game/openvibe.games/materialsrc/console game/openvibe.games/materials/console launcher

# -----------------------------------------------------------------------------
# 1) Proton/client fallback aliases.
# Windows hl2.exe cannot load the Linux client.so, so these aliases prevent
# confusing Unknown command spam and keep raw connect flows usable.
# -----------------------------------------------------------------------------
cat > game/openvibe.games/cfg/openvibe_proton_client.cfg <<'CFG'
// OpenVibe Proton client fallback aliases.
// This file is executed by tools/run-client-proton.sh.
// Proton Windows hl2.exe does not load Linux bin/linux64/client.so, so the
// native OpenVibe client DLL commands are not available in this mode.

echo "[OpenVibe] Proton fallback cfg loaded. Electron is the custom menu in Proton mode."

alias ov_help "echo OpenVibe Proton fallback: use ov_join_hub / ov_join_prophunt / ov_join_deathrun / ov_join_fortwars / ov_join_traitortown. Electron remains the full HTML/CSS/JS menu."
alias ov_menu "echo OpenVibe HTML menu is hosted by Electron in Proton mode. Alt-tab to the launcher or run npm run dev."
alias ov_ui "ov_menu"
alias ov_main_menu "ov_menu"
alias ov_menu_main "ov_menu"
alias ov_menu_servers "echo Server browser is in Electron. Quick connects: ov_join_hub, ov_join_prophunt, ov_join_deathrun, ov_join_fortwars, ov_join_traitortown."
alias ov_menu_leaderboard "echo Leaderboard UI is in Electron in Proton mode."
alias ov_menu_inventory "echo Inventory UI is in Electron in Proton mode."
alias ov_menu_shop "echo Shop UI is in Electron in Proton mode."
alias ov_menu_settings "echo Settings UI is in Electron in Proton mode."
alias ov_menu_reload "echo Reload the Electron window with Ctrl+R or restart npm run dev."
alias ov_menu_close "echo Close/minimize the Electron launcher window."

alias ov_join "echo Usage in Proton fallback: ov_join_hub / ov_join_prophunt / ov_join_deathrun / ov_join_fortwars / ov_join_traitortown. The argument-taking ov_join command needs OpenVibe client.dll/client.so."
alias ov_join_hub "connect 127.0.0.1:27015"
alias ov_join_prophunt "connect 127.0.0.1:27016"
alias ov_join_deathrun "connect 127.0.0.1:27017"
alias ov_join_fortwars "connect 127.0.0.1:27018"
alias ov_join_traitortown "connect 127.0.0.1:27019"

alias ov_js_status "cmd ov_js_status"
alias ov_js_reload "cmd ov_js_reload"
alias ov_js_cmd "cmd ov_js_cmd"
alias ov_js_fire "cmd ov_js_fire"

alias ov_prophunt_disguise "cmd ov_prophunt_disguise"
alias ov_prophunt_reset_disguise "cmd ov_prophunt_reset_disguise"
alias ov_fortwars_spawn "cmd ov_fortwars_spawn"
CFG

cat > game/openvibe.games/cfg/autoexec.cfg <<'CFG'
// OpenVibe autoexec. Safe in both native and Proton modes.
exec openvibe_proton_client.cfg
CFG

# Patch Proton launcher to exec aliases early.
python3 <<'PY'
from pathlib import Path
p = Path('tools/run-client-proton.sh')
s = p.read_text()
if '+exec openvibe_proton_client.cfg' not in s:
    s = s.replace(
        '-console -dev -novid -sw -w 1280 -h 720 \\\n',
        '-console -dev -novid -sw -w 1280 -h 720 +exec openvibe_proton_client.cfg \\\n'
    )
if 'OPENVIBE_PROTON_FALLBACK' not in s:
    s = s.replace('export PROTON_LOG=0\n', 'export PROTON_LOG=0\nexport OPENVIBE_PROTON_FALLBACK=1\n')
p.write_text(s)
PY
chmod +x tools/run-client-proton.sh

# -----------------------------------------------------------------------------
# 2) Best-effort loading dialog override resources.
# This won't replace the HL2 background material until VTF files are supplied,
# but it customizes text/layout and adds docs + source art placeholders.
# -----------------------------------------------------------------------------
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
        "visible"           "1"
        "enabled"           "1"
        "title"             "OpenVibe: Source"
        "proportionaltoparent" "1"
        "PaintBackgroundType" "2"
        "bgcolor_override"  "7 8 14 245"
    }
    "LoadingLabel"
    {
        "ControlName"       "Label"
        "fieldName"         "LoadingLabel"
        "xpos"              "cs-260"
        "ypos"              "rs1-92"
        "wide"              "520"
        "tall"              "28"
        "visible"           "1"
        "enabled"           "1"
        "labelText"         "OPENVIBE: SOURCE"
        "textAlignment"     "center"
        "font"              "DefaultLarge"
        "fgcolor_override"  "0 216 255 255"
    }
    "ProgressLabel"
    {
        "ControlName"       "Label"
        "fieldName"         "ProgressLabel"
        "xpos"              "cs-260"
        "ypos"              "rs1-58"
        "wide"              "520"
        "tall"              "24"
        "visible"           "1"
        "enabled"           "1"
        "labelText"         "Loading OpenVibe session..."
        "textAlignment"     "center"
        "font"              "Default"
        "fgcolor_override"  "230 236 255 255"
    }
}
RES

cat > game/openvibe.games/materialsrc/console/openvibe-loading.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <radialGradient id="g" cx="50%" cy="45%" r="75%">
      <stop offset="0" stop-color="#16334a"/>
      <stop offset="0.45" stop-color="#0b1020"/>
      <stop offset="1" stop-color="#05060b"/>
    </radialGradient>
    <linearGradient id="line" x1="0" x2="1">
      <stop offset="0" stop-color="#00d8ff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#00d8ff" stop-opacity="1"/>
      <stop offset="1" stop-color="#a855f7" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <g opacity="0.18" stroke="#00d8ff" fill="none">
    <path d="M0 770 C300 630 520 890 850 730 C1190 560 1390 810 1920 610"/>
    <path d="M0 830 C330 700 560 960 910 780 C1240 610 1480 860 1920 680"/>
  </g>
  <circle cx="960" cy="450" r="155" fill="none" stroke="#00d8ff" stroke-width="8" opacity="0.8"/>
  <circle cx="960" cy="450" r="112" fill="none" stroke="#a855f7" stroke-width="4" opacity="0.7"/>
  <text x="960" y="465" text-anchor="middle" font-family="Orbitron, Rajdhani, sans-serif" font-size="84" fill="#eaf8ff" font-weight="900">OPENVIBE</text>
  <text x="960" y="530" text-anchor="middle" font-family="Rajdhani, sans-serif" font-size="38" fill="#00d8ff" font-weight="700">SOURCE</text>
  <rect x="660" y="620" width="600" height="6" rx="3" fill="url(#line)"/>
  <text x="960" y="680" text-anchor="middle" font-family="Inter, sans-serif" font-size="28" fill="#b9c7e8">Loading connected game session...</text>
</svg>
SVG

cat > game/openvibe.games/materials/console/README.md <<'MD'
# OpenVibe loading background

Source's full-screen loading background is a VTF material, normally:

- `materials/console/background01.vtf`
- `materials/console/background01_widescreen.vtf`

This repo includes source art at:

- `materialsrc/console/openvibe-loading.svg`

To fully replace the HL2 loading image, convert it to the two VTF filenames above using VTFEdit/VTFCmd or Valve's `vtex`, then place the VTFs in this folder.

Until those VTF files exist, `resource/LoadingDialog.res` can restyle text/layout, but the old HL2 image may still appear.
MD

# -----------------------------------------------------------------------------
# 3) Electron launch UX: keep launcher visible, expose focus button, and only
# hide when Source window is stable if env var opts in.
# -----------------------------------------------------------------------------
python3 <<'PY'
from pathlib import Path
p = Path('launcher/main.js')
s = p.read_text()

if 'function sourceWindowVisible' not in s:
    insert_after = "let appIsQuitting = false;\n"
    block = r'''
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
'''
    s = s.replace(insert_after, insert_after + block + "\n")

old = """  mainWindow?.webContents.send('game-started', gameProcess.pid);\n  setTimeout(() => {\n    if (gameProcess && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();\n  }, 750);\n"""
new = """  mainWindow?.webContents.send('game-started', gameProcess.pid);\n  broadcastLaunchState({\n    phase: 'spawned',\n    pid: gameProcess.pid,\n    message: 'Source spawned. Keeping launcher visible until the game window is stable.',\n  });\n\n  waitForStableSourceWindow().then((ready) => {\n    broadcastLaunchState({\n      phase: ready ? 'ready' : 'timeout',\n      pid: gameProcess ? gameProcess.pid : null,\n      message: ready\n        ? 'Source window appears stable. You can focus the game now.'\n        : 'Source is still not confirmed stable. Launcher stayed visible to avoid confusion.',\n    });\n\n    const shouldAutoHide = process.env.OPENVIBE_HIDE_LAUNCHER_ON_GAME_READY === '1';\n    if (ready && shouldAutoHide && gameProcess && mainWindow && !mainWindow.isDestroyed()) {\n      mainWindow.hide();\n      focusSourceWindow();\n    }\n  });\n"""
if old in s:
    s = s.replace(old, new)

if "ipcMain.handle('game:focus'" not in s:
    s = s.replace("ipcMain.handle('game:status', () => ({\n  running: gameProcess !== null,\n  pid: gameProcess?.pid ?? null,\n}));\n",
                  "ipcMain.handle('game:status', () => ({\n  running: gameProcess !== null,\n  pid: gameProcess?.pid ?? null,\n  launchState: lastLaunchState,\n}));\n\nipcMain.handle('game:focus', async () => focusSourceWindow());\n")

p.write_text(s)
PY

python3 <<'PY'
from pathlib import Path
p = Path('launcher/preload.js')
s = p.read_text()
if "focusGame" not in s:
    s = s.replace("gameStatus:  ()            => ipcRenderer.invoke('game:status'),",
                  "gameStatus:  ()            => ipcRenderer.invoke('game:status'),\n  focusGame:   ()            => ipcRenderer.invoke('game:focus'),")
if "onLaunchState" not in s:
    s = s.replace("onGameStart: (cb) => ipcRenderer.on('game-started', (_e, pid) => cb(pid)),",
                  "onGameStart: (cb) => ipcRenderer.on('game-started', (_e, pid) => cb(pid)),\n  onLaunchState: (cb) => ipcRenderer.on('launch-state', (_e, state) => cb(state)),")
p.write_text(s)
PY

python3 <<'PY'
from pathlib import Path
p = Path('launcher/renderer.js')
s = p.read_text()
if 'focusGame:' not in s:
    s = s.replace("gameStatus: () => isElectron ? window.OV.gameStatus() : Promise.resolve({ running: true, pid: null }),",
                  "gameStatus: () => isElectron ? window.OV.gameStatus() : Promise.resolve({ running: true, pid: null }),\n  focusGame: () => isElectron ? window.OV.focusGame() : Promise.resolve(false),")
if 'launch-focus' not in s:
    s = s.replace("document.getElementById('launch-cancel')?.addEventListener('click', () => {\n  launchOverlay.classList.remove('show');\n});",
                  "document.getElementById('launch-cancel')?.addEventListener('click', () => {\n  launchOverlay.classList.remove('show');\n});\n\ndocument.getElementById('launch-focus')?.addEventListener('click', async () => {\n  const ok = await Bridge.focusGame();\n  toast(ok ? 'Focused Source window.' : 'Could not find Source window yet.', !ok);\n});")
if 'onLaunchState' not in s:
    s += r'''

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
'''
p.write_text(s)
PY

python3 <<'PY'
from pathlib import Path
p = Path('launcher/index.html')
s = p.read_text()
if 'id="launch-focus"' not in s:
    s = s.replace('  <button class="launch-cancel" id="launch-cancel">Cancel</button>\n',
                  '  <button class="launch-cancel" id="launch-cancel">Cancel</button>\n  <button class="launch-focus" id="launch-focus">Focus Game Window</button>\n  <div class="launch-sub" id="launch-sub">Electron stays visible until Source is stable.</div>\n')
p.write_text(s)
PY

cat >> launcher/styles.css <<'CSS'

/* OpenVibe launcher-aware Source loading UX */
.launch-focus {
  margin-top: 10px;
  border: 1px solid rgba(0, 216, 255, 0.55);
  background: rgba(0, 216, 255, 0.14);
  color: #eaf8ff;
  border-radius: 10px;
  padding: 9px 16px;
  font-weight: 700;
  cursor: pointer;
}
.launch-focus:hover {
  background: rgba(0, 216, 255, 0.22);
}
.launch-sub {
  margin-top: 10px;
  max-width: 560px;
  color: rgba(230, 236, 255, 0.76);
  font-size: 13px;
  line-height: 1.35;
  text-align: center;
}
CSS

# -----------------------------------------------------------------------------
# 4) Diagnostic.
# -----------------------------------------------------------------------------
cat > tools/check-openvibe-client-mode.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

echo "[openvibe] client mode diagnostic"
echo "Windows/Proton launcher: $ROOT/tools/run-client-proton.sh"
echo "Linux client module: $ROOT/game/openvibe.games/bin/linux64/client.so"
echo "Fallback aliases: $ROOT/game/openvibe.games/cfg/openvibe_proton_client.cfg"
echo
[[ -f game/openvibe.games/bin/linux64/client.so ]] && echo "[ok] Linux client.so exists" || echo "[missing] Linux client.so missing"
[[ -f game/openvibe.games/cfg/openvibe_proton_client.cfg ]] && echo "[ok] Proton fallback aliases exist" || echo "[missing] Proton fallback aliases missing"

echo
cat <<'TXT'
Important:
  Proton Windows hl2.exe loads Windows client.dll, not Linux bin/linux64/client.so.
  If the console says unknown command ov_join/ov_menu, the OpenVibe client DLL is not loaded.

Current reliable custom UI:
  Electron launcher + local Chromium UI.

Current in-game fallback:
  autoexec.cfg loads openvibe_proton_client.cfg aliases.
  Try: ov_help, ov_join_hub, ov_join_prophunt, ov_join_deathrun.

Full in-game HTML/CSS/JS menu requires:
  1) native Linux Source client loading bin/linux64/client.so, or
  2) a Windows client.dll build for Proton hl2.exe.

Full loading image replacement:
  Convert materialsrc/console/openvibe-loading.svg to:
    materials/console/background01.vtf
    materials/console/background01_widescreen.vtf
TXT
SH
chmod +x tools/check-openvibe-client-mode.sh

# Keep setup links current, if build exists.
if [[ -x tools/setup-openvibe-bin.sh ]]; then
  tools/setup-openvibe-bin.sh || true
fi

echo
echo "[openvibe] done. Re-test:"
echo "  tools/check-openvibe-client-mode.sh"
echo "  cd launcher && npm run dev"
echo
echo "In Proton client console, try:"
echo "  exec openvibe_proton_client.cfg"
echo "  ov_help"
echo "  ov_join_hub"
echo "  ov_menu_servers"
