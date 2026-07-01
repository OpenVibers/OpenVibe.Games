#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

echo "[openvibe] fixing duplicate ov_js_cmd and canonicalizing embedded JS server bridge"

mkdir -p sdk/openvibe/server/hl2mp

backup_file sdk/openvibe/server/hl2mp/openvibe_js_server.cpp
backup_file sdk/openvibe/server/hl2mp/openvibe_server.cpp

cat > sdk/openvibe/server/hl2mp/openvibe_js_server.cpp <<'CPP'
#include "cbase.h"
#include "hl2mp_player.h"
#include "openvibe_js_server.h"
#include "openvibe/ov_js_runtime.h"
#include "openvibe/ov_js_player.h"

#include "tier0/memdbgon.h"

static ConVar ov_mode(
    "ov_mode",
    "hub",
    FCVAR_GAMEDLL,
    "OpenVibe mode: hub, prophunt, deathrun, fortwars, traitortown." );

static ConVar ov_js_enabled(
    "ov_js_enabled",
    "1",
    FCVAR_GAMEDLL,
    "Enable OpenVibe JavaScript runtime." );

static COpenVibeJSRuntime g_OVServerJS;
static bool g_OVServerJSStarted = false;

static bool OpenVibeJS_IsRunning()
{
    return ov_js_enabled.GetBool() && g_OVServerJS.Context() != nullptr;
}

static void OpenVibeJS_EnsureStarted()
{
    if ( g_OVServerJSStarted )
        return;

    g_OVServerJSStarted = true;

    if ( !ov_js_enabled.GetBool() )
    {
        Msg( "[OV JS] disabled by ov_js_enabled=0\n" );
        return;
    }

    if ( g_OVServerJS.Init( true, ov_mode.GetString() ) )
    {
        Msg( "[OV JS] server runtime initialized for mode '%s'\n", ov_mode.GetString() );
        g_OVServerJS.CallHookVoid( "Initialize" );

        JSContext *ctx = g_OVServerJS.Context();
        JSValue mapName = JS_NewString( ctx, gpGlobals ? STRING( gpGlobals->mapname ) : "" );
        JSValueConst argv[] = { mapName };
        g_OVServerJS.CallHookVoid( "MapInitialize", 1, argv );
        JS_FreeValue( ctx, mapName );
    }
    else
    {
        Warning( "[OV JS] server runtime failed to initialize\n" );
    }
}

static void OpenVibeJS_CallConsoleCommand( const char *pszCommand )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() )
    {
        Warning( "[OV JS] runtime is not running; command ignored: %s\n", pszCommand ? pszCommand : "" );
        return;
    }

    JSContext *ctx = g_OVServerJS.Context();
    JSValue command = JS_NewString( ctx, pszCommand ? pszCommand : "" );
    JSValueConst argv[] = { command };

    g_OVServerJS.CallHookVoid( "ConsoleCommand", 1, argv );

    JS_FreeValue( ctx, command );
}

void OpenVibeJS_ServerInit()
{
    OpenVibeJS_EnsureStarted();
}

void OpenVibeJS_ServerShutdown()
{
    if ( OpenVibeJS_IsRunning() )
        g_OVServerJS.CallHookVoid( "Shutdown" );

    g_OVServerJS.Shutdown();
    g_OVServerJSStarted = false;
}

void OpenVibeJS_ServerThink()
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() )
        return;

    g_OVServerJS.CallHookVoid( "Think" );
}

void OpenVibeJS_Server_PlayerInitialSpawn( CHL2MP_Player *player )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() || !player )
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer( ctx, player );

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid( "PlayerInitialSpawn", 1, argv );

    JS_FreeValue( ctx, ply );
}

void OpenVibeJS_Server_PlayerSpawn( CHL2MP_Player *player )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() || !player )
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer( ctx, player );

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid( "PlayerSpawn", 1, argv );

    JS_FreeValue( ctx, ply );
}

void OpenVibeJS_Server_PlayerDeath( CHL2MP_Player *victim, CBaseEntity *attacker, CBaseEntity *inflictor )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() || !victim )
        return;

    JSContext *ctx = g_OVServerJS.Context();

    JSValue jsVictim = OVJS_NewPlayer( ctx, victim );
    JSValue jsAttacker = JS_NULL;

    if ( attacker && attacker->IsPlayer() )
        jsAttacker = OVJS_NewPlayer( ctx, ToHL2MPPlayer( static_cast<CBasePlayer *>( attacker ) ) );

    JSValueConst argv[] = { jsVictim, jsAttacker };
    g_OVServerJS.CallHookVoid( "PlayerDeath", 2, argv );

    JS_FreeValue( ctx, jsVictim );
    JS_FreeValue( ctx, jsAttacker );
}

void OpenVibeJS_Server_PlayerDisconnected( CHL2MP_Player *player )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() || !player )
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer( ctx, player );

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid( "PlayerDisconnected", 1, argv );

    JS_FreeValue( ctx, ply );
}

bool OpenVibeJS_Server_PlayerSay( CHL2MP_Player *player, const char *text )
{
    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() || !player || !text )
        return false;

    JSContext *ctx = g_OVServerJS.Context();

    JSValue ply = OVJS_NewPlayer( ctx, player );
    JSValue msg = JS_NewString( ctx, text );

    JSValueConst argv[] = { ply, msg };

    bool value = false;
    bool returned = g_OVServerJS.CallHookBool( "PlayerSay", &value, 2, argv );

    JS_FreeValue( ctx, ply );
    JS_FreeValue( ctx, msg );

    return returned && value == false;
}

static void OV_JSReload_f()
{
    OpenVibeJS_ServerShutdown();
    OpenVibeJS_ServerInit();
    Msg( "[OV JS] reloaded\n" );
}

static ConCommand ov_js_reload(
    "ov_js_reload",
    OV_JSReload_f,
    "Reload OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);

static void OV_JSStatus_f()
{
    Msg( "[OV JS] enabled=%d started=%d running=%d mode=%s\n",
        ov_js_enabled.GetBool() ? 1 : 0,
        g_OVServerJSStarted ? 1 : 0,
        OpenVibeJS_IsRunning() ? 1 : 0,
        ov_mode.GetString() );
}

static ConCommand ov_js_status(
    "ov_js_status",
    OV_JSStatus_f,
    "Print OpenVibe JavaScript runtime status.",
    FCVAR_GAMEDLL
);

static void OV_JSFire_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: ov_js_fire <HookName>\n" );
        return;
    }

    OpenVibeJS_EnsureStarted();

    if ( !OpenVibeJS_IsRunning() )
    {
        Warning( "[OV JS] runtime is not running\n" );
        return;
    }

    g_OVServerJS.CallHookVoid( args[1] );
}

static ConCommand ov_js_fire(
    "ov_js_fire",
    OV_JSFire_f,
    "Fire an OpenVibe JavaScript hook with no arguments.",
    FCVAR_GAMEDLL
);

static void OV_JSCmd_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: ov_js_cmd <text>\n" );
        return;
    }

    OpenVibeJS_CallConsoleCommand( args.ArgS() );
}

static ConCommand ov_js_cmd(
    "ov_js_cmd",
    OV_JSCmd_f,
    "Send a ConsoleCommand event into the embedded OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);
CPP

echo "[openvibe] canonical openvibe_js_server.cpp written"

echo "[openvibe] removing stale legacy Node bridge remnants from openvibe_server.cpp"

python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/server/hl2mp/openvibe_server.cpp")
s = p.read_text()

# Remove legacy COpenVibeJsBridge class, if present.
s = re.sub(
    r'\n// ={10,}\n// OpenVibe\.JS - Scripting Engine C\+\+ Bridge\n// ={10,}\n\nclass COpenVibeJsBridge\b.*?\nstatic COpenVibeJsBridge g_OpenVibeJsBridge;\n',
    '\n',
    s,
    flags=re.S,
)

# More tolerant fallback if banner text differs.
s = re.sub(
    r'\nclass COpenVibeJsBridge\b.*?\nstatic COpenVibeJsBridge g_OpenVibeJsBridge;\n',
    '\n',
    s,
    flags=re.S,
)

# Remove old Node-bridge ov_js_cmd command if it survived.
s = re.sub(
    r'\nstatic void OV_JsCmd_f\s*\([^)]*\)\s*\{.*?\n\}\n\nstatic ConCommand ov_js_cmd\s*\(.*?\);\n',
    '\n',
    s,
    flags=re.S,
)

# Remove obvious unused Node/socket includes from our tracked patch file.
for inc in [
    '#include <thread>\n',
    '#include <mutex>\n',
    '#include <queue>\n',
    '#include <string>\n',
    '#include <sstream>\n',
    '#include <sys/socket.h>\n',
    '#include <sys/un.h>\n',
    '#include <unistd.h>\n',
]:
    s = s.replace(inc, '')

# Ensure embedded JS include exists.
if '#include "openvibe_js_server.h"' not in s:
    s = re.sub(
        r'(#include\s+"hl2mp_player\.h"\s*\n)',
        r'\1#include "openvibe_js_server.h"\n',
        s,
        count=1,
    )

p.write_text(s)
PY

echo "[openvibe] removing duplicate ov_js_cmd from already-applied SDK file if present"

SDK_SERVER_JS="$SDK/src/game/server/hl2mp/openvibe_js_server.cpp"
if [[ -f "$SDK_SERVER_JS" ]]; then
  cp "$SDK_SERVER_JS" "$SDK_SERVER_JS.bak.$STAMP"
  cp sdk/openvibe/server/hl2mp/openvibe_js_server.cpp "$SDK_SERVER_JS"
fi

echo "[openvibe] ensure JS ConsoleCommand handlers are present"

mkdir -p game/openvibe.games/js/gamemodes/base game/openvibe.games/js/gamemodes/hub

python3 <<'PY'
from pathlib import Path

def ensure_console_handler(path: str, marker: str, handler_src: str):
    p = Path(path)
    s = p.read_text() if p.exists() else "const GM = {\n};\n\ngamemode.set(GM);\n"
    if marker in s:
        return
    idx = s.rfind("};")
    if idx == -1:
        s += "\n" + handler_src + "\n"
    else:
        before = s[:idx].rstrip()
        after = s[idx:]
        if before.endswith("{"):
            before = before + "\n" + handler_src.strip()
        else:
            before = before + ",\n\n" + handler_src.strip()
        s = before + "\n" + after
    p.write_text(s)

ensure_console_handler(
    "game/openvibe.games/js/gamemodes/base/server.js",
    "Base ConsoleCommand",
    '''ConsoleCommand(text) {
    OV.log(`Base ConsoleCommand: ${text}`);
  }'''
)

ensure_console_handler(
    "game/openvibe.games/js/gamemodes/hub/server.js",
    "Hub ConsoleCommand",
    '''ConsoleCommand(text) {
    OV.log(`Hub ConsoleCommand: ${text}`);
    if (text === "smoke") {
      OV.broadcast("Embedded JS smoke command worked.");
    }
  }'''
)
PY

echo "[openvibe] apply SDK patch"
tools/apply-openvibe-sdk.sh

echo "[openvibe] verify only one ov_js_cmd exists in SDK copied source"
grep -n "ConCommand ov_js_cmd" "$SDK/src/game/server/hl2mp/openvibe_js_server.cpp" || true
count="$(grep -c "ConCommand ov_js_cmd" "$SDK/src/game/server/hl2mp/openvibe_js_server.cpp" || true)"
if [[ "$count" != "1" ]]; then
  echo "[openvibe] ERROR: expected exactly one ov_js_cmd, got $count" >&2
  exit 1
fi

echo "[openvibe] build SDK"
tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

echo "[openvibe] setup OpenVibe bin"
if [[ -x tools/setup-openvibe-bin.sh ]]; then
  tools/setup-openvibe-bin.sh
else
  echo "[openvibe] WARNING: tools/setup-openvibe-bin.sh not found/executable; skipping"
fi

echo
echo "[openvibe] phase build complete."
echo
echo "Next runtime test:"
echo "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
echo
echo "Server console tests:"
echo "  ov_js_status"
echo "  ov_js_fire Initialize"
echo "  ov_js_cmd smoke"
echo
echo "Client tests:"
echo "  connect 127.0.0.1:27015"
echo "  say !js"
echo "  say !hp"
echo "  say !players"
