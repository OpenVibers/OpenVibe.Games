#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_BUILD="${RUN_BUILD:-1}"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

need_file() {
  [[ -f "$1" ]] || { echo "[openvibe] missing required file: $1" >&2; exit 1; }
}

need_file "sdk/openvibe/server/hl2mp/openvibe_server.cpp"
need_file "sdk/openvibe/server/hl2mp/openvibe_js_server.cpp"
need_file "sdk/openvibe/server/hl2mp/openvibe_js_server.h"
need_file "tools/apply-openvibe-sdk.sh"
need_file "tools/build-quickjs-lib.sh"

echo "[openvibe] next phase: remove legacy Node bridge, add embedded JS console hooks, rebuild"

mkdir -p tools

backup_file "sdk/openvibe/server/hl2mp/openvibe_server.cpp"
backup_file "sdk/openvibe/server/hl2mp/openvibe_js_server.cpp"
backup_file "sdk/openvibe/server/hl2mp/openvibe_js_server.h"
backup_file "tools/apply-openvibe-sdk.sh"

python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/server/hl2mp/openvibe_server.cpp")
s = p.read_text()

# Make sure the embedded JS bridge header is included.
if '#include "openvibe_js_server.h"' not in s:
    s = re.sub(
        r'(#include\s+"hl2mp_player\.h"\s*\n)',
        r'\1#include "openvibe_js_server.h"\n',
        s,
        count=1,
    )

# Remove legacy Node/Unix-socket bridge includes that are no longer needed.
for inc in [
    '#include <thread>',
    '#include <mutex>',
    '#include <queue>',
    '#include <string>',
    '#include <condition_variable>',
    '#include <sys/socket.h>',
    '#include <sys/un.h>',
    '#include <unistd.h>',
    '#include <fcntl.h>',
    '#include <sstream>',
    '#include <sys/select.h>',
    '#include <sys/time.h>',
]:
    s = s.replace(inc + "\n", "")

bottom = r'''
// ======================================\n// OpenVibe embedded JavaScript hook bridge\n// ======================================

void OpenVibe_OnClientDisconnect( CBasePlayer *pPlayer )
{
    CHL2MP_Player *pHL2MP = ToHL2MPPlayer( pPlayer );
    if ( pHL2MP )
        OpenVibeJS_Server_PlayerDisconnected( pHL2MP );
}

void OpenVibe_OnPlayerDeath( CHL2MP_Player *pPlayer, CBaseEntity *pKiller )
{
    OpenVibeJS_Server_PlayerDeath( pPlayer, pKiller, NULL );
}

void OpenVibe_OnFrame()
{
    OpenVibeJS_ServerThink();
}
'''

# Remove the huge legacy COpenVibeJsBridge class and old ov_js_cmd that spawned Node.
marker = "// ==========================================\n// OpenVibe.JS - Scripting Engine C++ Bridge"
start = s.find(marker)
if start == -1:
    # The exact banner can vary because of long ===== lines. Fall back to class start.
    start = s.find("class COpenVibeJsBridge")
    if start != -1:
        # Include preceding banner if present.
        banner = s.rfind("// =================================", 0, start)
        if banner != -1:
            start = banner

if start != -1:
    s = s[:start].rstrip() + "\n\n" + bottom + "\n"
else:
    # If already cleaned, normalize the bottom hook functions only.
    def replace_function(src, regex, body):
        m = re.search(regex, src)
        if not m:
            return src
        brace = src.find('{', m.end())
        if brace < 0:
            return src
        depth = 0
        end = None
        for i in range(brace, len(src)):
            if src[i] == '{':
                depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is None:
            return src
        return src[:brace+1] + "\n" + body.strip() + "\n" + src[end:]

    s = replace_function(s, r'void\s+OpenVibe_OnClientDisconnect\s*\(\s*CBasePlayer\s*\*\s*pPlayer\s*\)',
        '    CHL2MP_Player *pHL2MP = ToHL2MPPlayer( pPlayer );\n    if ( pHL2MP )\n        OpenVibeJS_Server_PlayerDisconnected( pHL2MP );')
    s = replace_function(s, r'void\s+OpenVibe_OnPlayerDeath\s*\(\s*CHL2MP_Player\s*\*\s*pPlayer\s*,\s*CBaseEntity\s*\*\s*pKiller\s*\)',
        '    OpenVibeJS_Server_PlayerDeath( pPlayer, pKiller, NULL );')
    s = replace_function(s, r'void\s+OpenVibe_OnFrame\s*\(\s*\)', '    OpenVibeJS_ServerThink();')

p.write_text(s)
print("[openvibe] cleaned legacy Node bridge from openvibe_server.cpp")
PY

cat > sdk/openvibe/server/hl2mp/openvibe_js_server.h <<'CPP_H'
#pragma once

class CHL2MP_Player;
class CBasePlayer;
class CBaseEntity;

void OpenVibeJS_ServerInit();
void OpenVibeJS_ServerShutdown();
void OpenVibeJS_ServerThink();

void OpenVibeJS_Server_PlayerInitialSpawn(CHL2MP_Player *player);
void OpenVibeJS_Server_PlayerSpawn(CHL2MP_Player *player);
void OpenVibeJS_Server_PlayerDeath(CHL2MP_Player *victim, CBaseEntity *attacker, CBaseEntity *inflictor);
void OpenVibeJS_Server_PlayerDisconnected(CHL2MP_Player *player);
bool OpenVibeJS_Server_PlayerSay(CHL2MP_Player *player, const char *text);

void OpenVibeJS_Server_ConsoleCommand(const char *text);
void OpenVibeJS_Server_FireHook(const char *hookName);
CPP_H

python3 <<'PY'
from pathlib import Path

p = Path("sdk/openvibe/server/hl2mp/openvibe_js_server.cpp")
s = p.read_text()

if "OpenVibeJS_Server_ConsoleCommand" not in s:
    insert = r'''
void OpenVibeJS_Server_ConsoleCommand(const char *text)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !text)
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue arg = JS_NewString(ctx, text);

    JSValueConst argv[] = { arg };
    g_OVServerJS.CallHookVoid("ConsoleCommand", 1, argv);

    JS_FreeValue(ctx, arg);
}

void OpenVibeJS_Server_FireHook(const char *hookName)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !hookName || !hookName[0])
        return;

    g_OVServerJS.CallHookVoid(hookName);
}

static void OV_JsCmd_f(const CCommand &args)
{
    if (args.ArgC() < 2)
    {
        Msg("Usage: ov_js_cmd <text>\n");
        return;
    }

    OpenVibeJS_Server_ConsoleCommand(args.ArgS());
}

static ConCommand ov_js_cmd(
    "ov_js_cmd",
    OV_JsCmd_f,
    "Send a string to the embedded OpenVibe JS ConsoleCommand hook.",
    FCVAR_GAMEDLL
);

static void OV_JSFire_f(const CCommand &args)
{
    if (args.ArgC() < 2)
    {
        Msg("Usage: ov_js_fire <HookName>\n");
        return;
    }

    OpenVibeJS_Server_FireHook(args[1]);
}

static ConCommand ov_js_fire(
    "ov_js_fire",
    OV_JSFire_f,
    "Fire an embedded OpenVibe JS hook by name.",
    FCVAR_GAMEDLL
);

static void OV_JSStatus_f()
{
    Msg("[OV JS] enabled=%d running=%d mode=%s map=%s\n",
        ov_js_enabled.GetBool() ? 1 : 0,
        OpenVibeJS_IsRunning() ? 1 : 0,
        ov_mode.GetString(),
        gpGlobals ? STRING(gpGlobals->mapname) : "" );
}

static ConCommand ov_js_status(
    "ov_js_status",
    OV_JSStatus_f,
    "Print embedded OpenVibe JS runtime status.",
    FCVAR_GAMEDLL
);
'''
    # Put commands after ov_js_reload command block.
    s = s.rstrip() + "\n\n" + insert.lstrip() + "\n"

p.write_text(s)
print("[openvibe] added embedded ov_js_cmd / ov_js_fire / ov_js_status commands")
PY

python3 <<'PY'
from pathlib import Path

for path in [
    Path("game/openvibe.games/js/gamemodes/base/server.js"),
    Path("game/openvibe.games/js/gamemodes/hub/server.js"),
]:
    if not path.exists():
        continue
    s = path.read_text()
    if "ConsoleCommand(" in s:
        continue

    snippet = '''

  ConsoleCommand(text) {
    OV.log(`ConsoleCommand: ${text}`);

    if (text === "smoke" || text === "test") {
      OV.broadcast("Embedded JS ConsoleCommand hook is working.");
      return false;
    }

    return undefined;
  },
'''

    marker = "\n  Think()"
    if marker in s:
        s = s.replace(marker, snippet + marker, 1)
    else:
        s = s.replace("\n};", snippet.rstrip(",\n") + "\n};", 1)
    path.write_text(s)
    print(f"[openvibe] added ConsoleCommand hook to {path}")
PY

echo "[openvibe] cleaning apply-openvibe-sdk.sh duplicate stale link block"
python3 <<'PY'
from pathlib import Path
import re

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

# Remove stale block after final echo, if present. It is harmless but confusing.
s = re.sub(
    r'\n\n# Link prebuilt QuickJS C static library\. QuickJS must be compiled as C, not C\+\+\.\nif ! grep -q '\''libquickjs_openvibe'\'' "\$SERVER_VPC"; then\n  perl -0pi -e '\''s/\(\\\$File\\s\+"hl2mp\\\\openvibe_js_server\\\.cpp"\\n\)/\$1\\t\\t\\t\\\$Lib\\t"\.\.\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\build\\\\libquickjs_openvibe"\\n/s'\'' "\$SERVER_VPC"\n  echo "\[openvibe-sdk\] linked QuickJS static library"\nfi\n*',
    '\n',
    s,
    flags=re.S,
)

# Ensure final V2 block exists.
if "OPENVIBE_FIX_QUICKJS_LINK_FINAL_V2" not in s:
    final_block = r'''

# OPENVIBE_FIX_QUICKJS_LINK_FINAL_V2
# QuickJS is C, so do not compile its .c files through Source SDK/VPC C++.
# We build libquickjs_openvibe.a with cc and link it as a library.
if [[ -f "$SERVER_VPC" ]]; then
  perl -0pi -e '
    s/^.*quickjs\\quickjs\.c.*\n//mg;
    s/^.*quickjs\\libregexp\.c.*\n//mg;
    s/^.*quickjs\\libunicode\.c.*\n//mg;
    s/^.*quickjs\\cutils\.c.*\n//mg;
    s/^.*quickjs\\dtoa\.c.*\n//mg;
    s/^.*quickjs\\libbf\.c.*\n//mg;
  ' "$SERVER_VPC"

  perl -0pi -e 's/^.*libquickjs_openvibe(?:\.a)?".*\n//mg' "$SERVER_VPC"

  perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe"\n/s' "$SERVER_VPC"

  echo "[openvibe-sdk] linked QuickJS static library"
fi
'''
    s = s.replace('echo "[openvibe-sdk] Source SDK OpenVibe patch applied"', final_block + '\n\necho "[openvibe-sdk] Source SDK OpenVibe patch applied"')

p.write_text(s)
PY

echo "[openvibe] writing embedded JS runtime smoke helper"
cat > tools/smoke-embedded-js-runtime.sh <<'SMOKE'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

tools/apply-openvibe-sdk.sh
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh

echo
cat <<'MSG'
Embedded JS build/setup completed.

Start the dev stack:
  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh

Then in server console or via rcon/tmux pane, test:
  ov_js_status
  ov_js_fire Initialize
  ov_js_cmd smoke

Then in game:
  connect 127.0.0.1:27015
  say !js
  say !hp
  say !players
MSG
SMOKE
chmod +x tools/smoke-embedded-js-runtime.sh

echo "[openvibe] applying SDK patch"
tools/apply-openvibe-sdk.sh

if [[ "$RUN_BUILD" = "1" ]]; then
  echo "[openvibe] running SDK build"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"
  echo "[openvibe] running setup-openvibe-bin.sh"
  tools/setup-openvibe-bin.sh
fi

echo
echo "[openvibe] next phase complete. Useful checks:"
echo "  grep -R \"COpenVibeJsBridge\|SpawnNodeJs\|system( cmd\" sdk/openvibe/server/hl2mp/openvibe_server.cpp || true"
echo "  grep -nE 'ov_js_cmd|ov_js_fire|ov_js_status' sdk/openvibe/server/hl2mp/openvibe_js_server.cpp"
echo "  tail -80 ~/ov-build.log"
echo
echo "Commit after testing:"
echo "  git add ."
echo "  git commit -m \"Remove legacy Node JS bridge and add embedded JS console hooks\""
echo "  git push"
