#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_BUILD="${RUN_BUILD:-1}"
RUN_SETUP="${RUN_SETUP:-1}"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

echo "[openvibe] continue after QuickJS build pass"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

mkdir -p tools sdk/openvibe/shared sdk/openvibe/server/hl2mp game/openvibe.games/js/gamemodes/base game/openvibe.games/js/gamemodes/hub

echo "[openvibe] clean local generated junk from git tracking if present"
git rm -f .tmp/quickjs-smoke/smoke-quickjs 2>/dev/null || true
git rm -f tools/apply-openvibe-sdk.sh.bak.* 2>/dev/null || true

touch .gitignore
grep -qxF '.tmp/' .gitignore || cat >> .gitignore <<'GITIGNORE_ADD'

# OpenVibe local/generated build junk
.tmp/
*.bak.*
tools/*.bak.*
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/
GITIGNORE_ADD

echo "[openvibe] write canonical tools/build-quickjs-lib.sh"

cat > tools/build-quickjs-lib.sh <<'BUILDQJS'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

SRC_QJS="$ROOT/sdk/openvibe/third_party/quickjs"
SDK_QJS="$SDK/src/game/shared/openvibe/third_party/quickjs"
OUT="$SDK_QJS/build"

if [[ ! -f "$SRC_QJS/quickjs.c" ]]; then
  echo "Missing $SRC_QJS/quickjs.c" >&2
  echo "Run: tools/vendor-quickjs.sh" >&2
  exit 1
fi

mkdir -p "$SDK_QJS"

# Exclude build/ so rsync does not delete object/library output.
rsync -a --delete --exclude='build/' "$SRC_QJS/" "$SDK_QJS/"

mkdir -p "$OUT"

sources=(
  quickjs.c
  libregexp.c
  libunicode.c
  cutils.c
)

[[ -f "$SDK_QJS/dtoa.c" ]] && sources+=(dtoa.c)
[[ -f "$SDK_QJS/libbf.c" ]] && sources+=(libbf.c)

rm -f "$OUT"/*.o "$OUT"/libquickjs_openvibe.a

for src in "${sources[@]}"; do
  obj="$OUT/${src%.c}.o"
  echo "[openvibe-qjs] cc $src -> $obj"

  cc \
    -std=gnu11 \
    -O2 \
    -fPIC \
    -D_GNU_SOURCE \
    -DCONFIG_VERSION=\"openvibe\" \
    -I"$SDK_QJS" \
    -c "$SDK_QJS/$src" \
    -o "$obj"
done

ar rcs "$OUT/libquickjs_openvibe.a" "$OUT"/*.o

echo "[openvibe-qjs] built $OUT/libquickjs_openvibe.a"
ls -lh "$OUT/libquickjs_openvibe.a"
BUILDQJS

chmod +x tools/build-quickjs-lib.sh

echo "[openvibe] write clean canonical tools/apply-openvibe-sdk.sh"

backup_file tools/apply-openvibe-sdk.sh

cat > tools/apply-openvibe-sdk.sh <<'APPLY'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

if [[ ! -d "$SDK/src/game/client/hl2mp" || ! -d "$SDK/src/game/server/hl2mp" ]]; then
  echo "Source SDK 2013 checkout not found at $SDK" >&2
  echo "Set OPENVIBE_SDK=/path/to/source-sdk-2013 if it lives elsewhere." >&2
  exit 1
fi

copy_file() {
  local src="$1"
  local dst="$2"
  install -D -m 0644 "$src" "$dst"
  echo "[openvibe-sdk] copied ${dst#$SDK/}"
}

copy_tree() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  rsync -a --delete "$src/" "$dst/"
  echo "[openvibe-sdk] copied tree ${dst#$SDK/}"
}

copy_file "$ROOT/sdk/openvibe/client/hl2mp/openvibe_client.cpp" \
  "$SDK/src/game/client/hl2mp/openvibe_client.cpp"
copy_file "$ROOT/sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp" \
  "$SDK/src/game/client/hl2mp/vgui_openvibe_menu.cpp"
copy_file "$ROOT/sdk/openvibe/server/hl2mp/openvibe_server.cpp" \
  "$SDK/src/game/server/hl2mp/openvibe_server.cpp"

copy_file "$ROOT/sdk/openvibe/shared/ov_js_runtime.h" \
  "$SDK/src/game/shared/openvibe/ov_js_runtime.h"
copy_file "$ROOT/sdk/openvibe/shared/ov_js_runtime.cpp" \
  "$SDK/src/game/shared/openvibe/ov_js_runtime.cpp"
copy_file "$ROOT/sdk/openvibe/shared/ov_js_bindings.h" \
  "$SDK/src/game/shared/openvibe/ov_js_bindings.h"
copy_file "$ROOT/sdk/openvibe/shared/ov_js_bindings.cpp" \
  "$SDK/src/game/shared/openvibe/ov_js_bindings.cpp"
copy_file "$ROOT/sdk/openvibe/shared/ov_js_player.h" \
  "$SDK/src/game/shared/openvibe/ov_js_player.h"
copy_file "$ROOT/sdk/openvibe/shared/ov_js_player.cpp" \
  "$SDK/src/game/shared/openvibe/ov_js_player.cpp"

copy_file "$ROOT/sdk/openvibe/server/hl2mp/openvibe_js_server.h" \
  "$SDK/src/game/server/hl2mp/openvibe_js_server.h"
copy_file "$ROOT/sdk/openvibe/server/hl2mp/openvibe_js_server.cpp" \
  "$SDK/src/game/server/hl2mp/openvibe_js_server.cpp"

copy_tree "$ROOT/sdk/openvibe/third_party/quickjs" \
  "$SDK/src/game/shared/openvibe/third_party/quickjs"

"$ROOT/tools/build-quickjs-lib.sh"

CLIENT_VPC="$SDK/src/game/client/client_hl2mp.vpc"
SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"
HL2MP_CLIENT="$SDK/src/game/server/hl2mp/hl2mp_client.cpp"
HL2MP_CLIENTMODE="$SDK/src/game/client/hl2mp/clientmode_hl2mpnormal.cpp"
GAMEINTERFACE="$SDK/src/game/server/gameinterface.cpp"
HL2MP_PLAYER="$SDK/src/game/server/hl2mp/hl2mp_player.cpp"

perl -0pi -e '
  s/^.*hl2mp\\openvibe_client\.cpp.*\n//mg;
  s/^.*hl2mp\\vgui_openvibe_menu\.cpp.*\n//mg;
  s/(\$File\s+"hl2mp\\clientmode_hl2mpnormal\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_client.cpp"\n\t\t\t\$File\t"hl2mp\\vgui_openvibe_menu.cpp"\n/s;
' "$CLIENT_VPC"
echo "[openvibe-sdk] patched client_hl2mp.vpc"

perl -0pi -e '
  s/^.*hl2mp\\openvibe_server\.cpp.*\n//mg;
  s/^.*hl2mp\\openvibe_js_server\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_runtime\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_bindings\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_player\.cpp.*\n//mg;
  s/^.*quickjs\\quickjs\.c.*\n//mg;
  s/^.*quickjs\\libregexp\.c.*\n//mg;
  s/^.*quickjs\\libunicode\.c.*\n//mg;
  s/^.*quickjs\\cutils\.c.*\n//mg;
  s/^.*quickjs\\dtoa\.c.*\n//mg;
  s/^.*quickjs\\libbf\.c.*\n//mg;
  s/^.*libquickjs_openvibe(?:\.a)?".*\n//mg;
  s/(\$File\s+"hl2mp\\hl2mp_player\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_server.cpp"\n\t\t\t\$File\t"hl2mp\\openvibe_js_server.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_runtime.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_bindings.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_player.cpp"\n\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe"\n/s;
' "$SERVER_VPC"
echo "[openvibe-sdk] patched server_hl2mp.vpc"

if ! grep -q 'OpenVibe_OnClientActive' "$HL2MP_CLIENT"; then
  sed -i '/void Host_Say/a void OpenVibe_OnClientActive( CHL2MP_Player *pPlayer );' "$HL2MP_CLIENT"
  sed -i '/FinishClientPutInServer( pPlayer );/a \	OpenVibe_OnClientActive( pPlayer );' "$HL2MP_CLIENT"
  echo "[openvibe-sdk] patched hl2mp_client.cpp arrival hook"
fi

perl -0pi -e 's/[^\S\r\n]*\x0boid OpenVibe_OnClientActive/void OpenVibe_OnClientActive/g; s/\\tOpenVibe_OnClientActive/\tOpenVibe_OnClientActive/g; s/^[ \t]*void OpenVibe_OnClientActive/void OpenVibe_OnClientActive/m' "$HL2MP_CLIENT"

if ! grep -q 'OpenVibe_OnClientModeInit' "$HL2MP_CLIENTMODE"; then
  sed -i '/#include "ienginevgui.h"/a void OpenVibe_OnClientModeInit();' "$HL2MP_CLIENTMODE"
  sed -i '/BaseClass::Init();/a \    OpenVibe_OnClientModeInit();' "$HL2MP_CLIENTMODE"
  echo "[openvibe-sdk] patched clientmode_hl2mpnormal.cpp OpenVibe menu hook"
fi

perl -0pi -e 's/^[ \t]*tOpenVibe_OnClientModeInit\(\);/    OpenVibe_OnClientModeInit();/m' "$HL2MP_CLIENTMODE"

if [[ -f "$GAMEINTERFACE" ]]; then
  if ! grep -q 'OpenVibe_OnFrame' "$GAMEINTERFACE"; then
    sed -i '/CServerGameDLL::GameFrame/i #ifdef HL2MP\nvoid OpenVibe_OnFrame();\n#endif' "$GAMEINTERFACE"
    sed -i '/VPROF( "CServerGameDLL::GameFrame" );/a #ifdef HL2MP\n\tOpenVibe_OnFrame();\n#endif' "$GAMEINTERFACE"
    echo "[openvibe-sdk] patched gameinterface.cpp frame hook"
  fi

  if ! grep -q 'OpenVibe_OnClientDisconnect' "$GAMEINTERFACE"; then
    perl -pi -e 's/void CServerGameClients::ClientDisconnect/#ifdef HL2MP\nvoid OpenVibe_OnClientDisconnect( CBasePlayer *pPlayer );\n#endif\nvoid CServerGameClients::ClientDisconnect/' "$GAMEINTERFACE"
    perl -0777 -pi -e 's/(void CServerGameClients::ClientDisconnect\( edict_t \*pEdict \)\s*\{\s*extern bool\s+g_fGameOver;\s*CBasePlayer \*player = \( CBasePlayer \* \)CBaseEntity::Instance\( pEdict \);)/$1\n#ifdef HL2MP\n\tif ( player ) { OpenVibe_OnClientDisconnect( player ); }\n#endif/g' "$GAMEINTERFACE"
    echo "[openvibe-sdk] patched gameinterface.cpp disconnect hook"
  fi
fi

if [[ -f "$HL2MP_PLAYER" ]]; then
  if ! grep -q 'OpenVibe_OnPlayerDeath' "$HL2MP_PLAYER"; then
    sed -i '/CHL2MP_Player::Event_Killed/i void OpenVibe_OnPlayerDeath( CHL2MP_Player *pPlayer, CBaseEntity *pKiller );' "$HL2MP_PLAYER"
    sed -i '/CTakeDamageInfo subinfo = info;/i \	OpenVibe_OnPlayerDeath( this, info.GetAttacker() );' "$HL2MP_PLAYER"
    echo "[openvibe-sdk] patched hl2mp_player.cpp death hook"
  fi

  if ! grep -q 'OpenVibeJS_Server_PlayerSpawn' "$HL2MP_PLAYER"; then
    sed -i '/CHL2MP_Player::Spawn/i void OpenVibeJS_Server_PlayerSpawn( CHL2MP_Player *pPlayer );' "$HL2MP_PLAYER"
    sed -i '0,/BaseClass::Spawn();/s//BaseClass::Spawn();\n\tOpenVibeJS_Server_PlayerSpawn( this );/' "$HL2MP_PLAYER"
    echo "[openvibe-sdk] patched hl2mp_player.cpp spawn hook"
  fi
fi

if [[ -f "$HL2MP_CLIENT" ]] && ! grep -q 'OpenVibeJS_Server_PlayerSay' "$HL2MP_CLIENT"; then
  sed -i '/void Host_Say/a bool OpenVibeJS_Server_PlayerSay( CHL2MP_Player *pPlayer, const char *pszText );' "$HL2MP_CLIENT"
  python3 - "$HL2MP_CLIENT" <<'PY'
from pathlib import Path
import re, sys

p = Path(sys.argv[1])
s = p.read_text()

if "OpenVibeJS_Server_PlayerSay( client," not in s:
    s2 = re.sub(
        r'(const char \*p\s*=\s*args\.ArgS\(\);\s*)',
        r'\1\n\tif ( client && OpenVibeJS_Server_PlayerSay( client, p ) )\n\t\treturn;\n',
        s,
        count=1,
    )
    if s2 != s:
        s = s2
        print("[openvibe-sdk] patched hl2mp_client.cpp PlayerSay hook")
    else:
        print("[openvibe-sdk] WARNING: could not auto-patch Host_Say PlayerSay body")
p.write_text(s)
PY
fi

echo "[openvibe-sdk] Source SDK OpenVibe patch applied"
APPLY

chmod +x tools/apply-openvibe-sdk.sh

echo "[openvibe] remove legacy Node bridge from sdk/openvibe/server/hl2mp/openvibe_server.cpp"

backup_file sdk/openvibe/server/hl2mp/openvibe_server.cpp

python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/server/hl2mp/openvibe_server.cpp")
s = p.read_text()

if '#include "openvibe_js_server.h"' not in s:
    s = re.sub(
        r'(#include\s+"hl2mp_player\.h"\s*\n)',
        r'\1#include "openvibe_js_server.h"\n',
        s,
        count=1,
    )

start = s.find("// =========================================")
bridge = s.find("OpenVibe.JS - Scripting Engine C++ Bridge")
if start != -1 and bridge != -1 and start < bridge:
    end = s.find("void OpenVibe_OnClientDisconnect", bridge)
    if end != -1:
        s = s[:start].rstrip() + "\n\n" + s[end:]
        print("[openvibe] removed legacy OpenVibe.JS Node bridge block")

s = re.sub(r'\n\s*static\s+COpenVibeJsBridge\s+g_OpenVibeJsBridge\s*;\s*\n', '\n', s)

legacy_cmd = re.compile(
    r'\nstatic\s+void\s+OV_JsCmd_f\s*\([^)]*\)\s*\{.*?\nstatic\s+ConCommand\s+ov_js_cmd\s*\(.*?\);\s*',
    re.S,
)
s2 = legacy_cmd.sub('\n', s)
if s2 != s:
    s = s2
    print("[openvibe] removed legacy ov_js_cmd command")

def replace_func(src, name, args, body):
    m = re.search(rf'void\s+{name}\s*\({args}\)\s*\{{', src)
    if not m:
        return src
    brace = src.find("{", m.end() - 1)
    depth = 0
    end = None
    for i in range(brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        return src
    return src[:brace + 1] + "\n" + body.rstrip() + "\n" + src[end:]

s = replace_func(
    s,
    "OpenVibe_OnClientDisconnect",
    r'\s*CBasePlayer\s*\*\s*pPlayer\s*',
    '''
    CHL2MP_Player *pHL2MP = ToHL2MPPlayer( pPlayer );
    if ( pHL2MP )
        OpenVibeJS_Server_PlayerDisconnected( pHL2MP );
'''
)

s = replace_func(
    s,
    "OpenVibe_OnPlayerDeath",
    r'\s*CHL2MP_Player\s*\*\s*pPlayer\s*,\s*CBaseEntity\s*\*\s*pKiller\s*',
    '''
    OpenVibeJS_Server_PlayerDeath( pPlayer, pKiller, NULL );
'''
)

s = replace_func(
    s,
    "OpenVibe_OnFrame",
    r'\s*',
    '''
    OpenVibeJS_ServerThink();
'''
)

if "OpenVibeJS_Server_PlayerInitialSpawn( pPlayer );" not in s:
    m = re.search(r'void\s+OpenVibe_OnClientActive\s*\(\s*CHL2MP_Player\s*\*\s*pPlayer\s*\)\s*\{', s)
    if m:
        brace = s.find("{", m.end() - 1)
        depth = 0
        end = None
        for i in range(brace, len(s)):
            if s[i] == "{":
                depth += 1
            elif s[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is not None:
            s = s[:end] + "\n    OpenVibeJS_Server_PlayerInitialSpawn( pPlayer );\n" + s[end:]

p.write_text(s)
PY

echo "[openvibe] add embedded JS console commands to openvibe_js_server.cpp"

backup_file sdk/openvibe/server/hl2mp/openvibe_js_server.cpp

python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/server/hl2mp/openvibe_js_server.cpp")
s = p.read_text()

s = re.sub(r'\nstatic void OV_JSStatus_f\(\).*?static ConCommand ov_js_status\s*\(.*?\);\s*', '\n', s, flags=re.S)
s = re.sub(r'\nstatic void OV_JSFire_f\(.*?static ConCommand ov_js_fire\s*\(.*?\);\s*', '\n', s, flags=re.S)
s = re.sub(r'\nstatic void OV_JSCmd_f\(.*?static ConCommand ov_js_cmd\s*\(.*?\);\s*', '\n', s, flags=re.S)

block = r'''
static void OV_JSStatus_f()
{
    Msg("[OV JS] enabled=%d running=%d mode=%s\n",
        ov_js_enabled.GetBool() ? 1 : 0,
        OpenVibeJS_IsRunning() ? 1 : 0,
        ov_mode.GetString());
}

static ConCommand ov_js_status(
    "ov_js_status",
    OV_JSStatus_f,
    "Print OpenVibe JavaScript runtime status.",
    FCVAR_GAMEDLL
);

static void OV_JSFire_f(const CCommand &args)
{
    if (args.ArgC() < 2)
    {
        Msg("Usage: ov_js_fire <HookName>\n");
        return;
    }

    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning())
    {
        Warning("[OV JS] runtime is not running.\n");
        return;
    }

    g_OVServerJS.CallHookVoid(args[1]);
}

static ConCommand ov_js_fire(
    "ov_js_fire",
    OV_JSFire_f,
    "Fire an OpenVibe JavaScript hook with no arguments.",
    FCVAR_GAMEDLL
);

static void OV_JSCmd_f(const CCommand &args)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning())
    {
        Warning("[OV JS] runtime is not running.\n");
        return;
    }

    JSContext *ctx = g_OVServerJS.Context();
    JSValue payload = JS_NewString(ctx, args.ArgS() ? args.ArgS() : "");

    JSValueConst argv[] = { payload };
    g_OVServerJS.CallHookVoid("ConsoleCommand", 1, argv);

    JS_FreeValue(ctx, payload);
}

static ConCommand ov_js_cmd(
    "ov_js_cmd",
    OV_JSCmd_f,
    "Send text to the OpenVibe embedded JavaScript ConsoleCommand hook.",
    FCVAR_GAMEDLL
);
'''

s = s.rstrip() + "\n\n" + block.lstrip()
p.write_text(s)
PY

echo "[openvibe] normalize base/hub JS ConsoleCommand handlers"

cat > game/openvibe.games/js/gamemodes/base/server.js <<'JS_BASE'
const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    OV.log("Base Initialize fired");
  },

  MapInitialize(mapName) {
    OV.log(`Base MapInitialize: ${mapName}`);
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source.");
  },

  PlayerSpawn(_ply) {},

  PlayerDeath(_victim, _attacker) {},

  PlayerDisconnected(_ply) {},

  PlayerSay(_ply, _text) {
    return undefined;
  },

  ConsoleCommand(text) {
    OV.log(`ConsoleCommand: ${text}`);
    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
JS_BASE

cat > game/openvibe.games/js/gamemodes/hub/server.js <<'JS_HUB'
const GM = {
  mode: "hub",
  name: "OpenVibe Hub",

  Initialize() {
    OV.log("Hub Initialize fired");
  },

  MapInitialize(mapName) {
    OV.log(`Map initialized: ${mapName}`);
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source JS runtime.");
    OV.broadcast(`${ply.name()} joined the hub.`);
  },

  PlayerSpawn(ply) {
    ply.chat("PlayerSpawn hook fired.");
  },

  PlayerSay(ply, text) {
    if (text === "!js") {
      ply.chat("JavaScript hooks are working.");
      return false;
    }

    if (text === "!hp") {
      ply.chat(`Health: ${ply.health()}`);
      return false;
    }

    if (text === "!players") {
      ply.chat(`Players online: ${OV.players().length}`);
      return false;
    }

    return undefined;
  },

  ConsoleCommand(text) {
    OV.log(`Hub ConsoleCommand: ${text}`);

    if (text === "smoke") {
      OV.broadcast("OpenVibe embedded JS smoke test passed.");
      return false;
    }

    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
JS_HUB

echo "[openvibe] apply SDK patch"
tools/apply-openvibe-sdk.sh

if [[ "$RUN_BUILD" = "1" ]]; then
  echo "[openvibe] run SDK build"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"
  tail -80 "$HOME/ov-build.log"
else
  echo "[openvibe] skipping build because RUN_BUILD=$RUN_BUILD"
fi

if [[ "$RUN_SETUP" = "1" && -x tools/setup-openvibe-bin.sh ]]; then
  echo "[openvibe] setup OpenVibe binaries"
  tools/setup-openvibe-bin.sh
fi

echo
echo "[openvibe] done."
echo
echo "Next manual test:"
echo "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
echo
echo "In server console:"
echo "  ov_js_status"
echo "  ov_js_fire Initialize"
echo "  ov_js_cmd smoke"
echo
echo "In client:"
echo "  connect 127.0.0.1:27015"
echo "  say !js"
echo "  say !hp"
echo "  say !players"
