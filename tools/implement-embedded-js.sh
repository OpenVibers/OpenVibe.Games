#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

need_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

mkdir -p \
  tools \
  sdk/openvibe/third_party/quickjs \
  sdk/openvibe/shared \
  sdk/openvibe/server/hl2mp \
  game/openvibe.games/js/core \
  game/openvibe.games/js/autorun/{server,client,shared} \
  game/openvibe.games/js/gamemodes/{base,hub,prophunt,deathrun,fortwars,traitortown} \
  game/openvibe.games/js/addons

need_file "tools/apply-openvibe-sdk.sh"
need_file "sdk/openvibe/server/hl2mp/openvibe_server.cpp"

echo "[openvibe] writing QuickJS vendor script"

cat > tools/vendor-quickjs.sh <<'VENDOR_QJS'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
DEST="$ROOT/sdk/openvibe/third_party/quickjs"
TMP="${TMPDIR:-/tmp}/openvibe-quickjs-vendor"

rm -rf "$TMP"

git clone --depth 1 https://github.com/bellard/quickjs.git "$TMP" || \
git clone --depth 1 https://github.com/quickjs-ng/quickjs.git "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -av \
  --include='quickjs.c' \
  --include='quickjs.h' \
  --include='quickjs-atom.h' \
  --include='quickjs-opcode.h' \
  --include='libregexp.c' \
  --include='libregexp.h' \
  --include='libregexp-opcode.h' \
  --include='libunicode.c' \
  --include='libunicode.h' \
  --include='libunicode-table.h' \
  --include='cutils.c' \
  --include='cutils.h' \
  --include='dtoa.c' \
  --include='dtoa.h' \
  --include='libbf.c' \
  --include='libbf.h' \
  --include='list.h' \
  --include='LICENSE' \
  --include='VERSION' \
  --exclude='*' \
  "$TMP/" \
  "$DEST/"

git -C "$TMP" rev-parse HEAD > "$DEST/UPSTREAM_COMMIT"

cat > "$DEST/README.openvibe.md" <<'DOC'
# QuickJS vendored for OpenVibe: Source

Vendored QuickJS core files for OpenVibe's embedded JavaScript runtime.

Excluded intentionally:
- qjs.c
- qjsc.c
- quickjs-libc.c
- quickjs-libc.h

Reason:
OpenVibe embeds QuickJS as a sandboxed script VM. Community scripts should not
receive raw std/os/filesystem/process APIs.
DOC

echo "[openvibe] vendored QuickJS into $DEST"
echo "[openvibe] upstream commit: $(cat "$DEST/UPSTREAM_COMMIT")"
VENDOR_QJS

chmod +x tools/vendor-quickjs.sh

echo "[openvibe] writing QuickJS smoke test"

cat > tools/smoke-quickjs.sh <<'SMOKE_QJS'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
QJS="$ROOT/sdk/openvibe/third_party/quickjs"
BUILD="$ROOT/.tmp/quickjs-smoke"

rm -rf "$BUILD"
mkdir -p "$BUILD"

cat > "$BUILD/smoke.c" <<'C'
#include <stdio.h>
#include "quickjs.h"

int main(void) {
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);

    JSValue value = JS_Eval(ctx, "1 + 2 + 3", 9, "<smoke>", JS_EVAL_TYPE_GLOBAL);
    int32_t out = 0;
    JS_ToInt32(ctx, &out, value);

    JS_FreeValue(ctx, value);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

    printf("quickjs result=%d\n", out);
    return out == 6 ? 0 : 1;
}
C

cc \
  -std=c11 \
  -D_GNU_SOURCE \
  -DCONFIG_VERSION=\"openvibe\" \
  -I"$QJS" \
  "$BUILD/smoke.c" \
  "$QJS/quickjs.c" \
  "$QJS/libregexp.c" \
  "$QJS/libunicode.c" \
  "$QJS/cutils.c" \
  "$QJS/dtoa.c" \
  "$QJS/libbf.c" \
  -lm \
  -ldl \
  -lpthread \
  -o "$BUILD/smoke-quickjs"

"$BUILD/smoke-quickjs"
SMOKE_QJS

chmod +x tools/smoke-quickjs.sh

if [[ ! -f sdk/openvibe/third_party/quickjs/quickjs.c ]]; then
  echo "[openvibe] vendoring QuickJS"
  tools/vendor-quickjs.sh
else
  echo "[openvibe] QuickJS already vendored; skipping vendor step"
fi

echo "[openvibe] writing JS runtime files"

cat > game/openvibe.games/js/core/hook.js <<'JS_HOOK'
(function () {
  const hooks = new Map();

  function getEvent(name) {
    let map = hooks.get(name);
    if (!map) {
      map = new Map();
      hooks.set(name, map);
    }
    return map;
  }

  globalThis.hook = {
    add(name, id, fn) {
      if (typeof name !== "string" || !name) throw new Error("hook name must be string");
      if (typeof id !== "string" || !id) throw new Error("hook id must be string");
      if (typeof fn !== "function") throw new Error("hook callback must be function");
      getEvent(name).set(id, fn);
    },

    remove(name, id) {
      const map = hooks.get(name);
      return map ? map.delete(id) : false;
    },

    run(name, ...args) {
      const map = hooks.get(name);
      if (!map) return undefined;

      for (const [id, fn] of map.entries()) {
        try {
          const result = fn(...args);
          if (result !== undefined) return result;
        } catch (err) {
          OV.error(`[hook:${name}:${id}] ${err && err.stack ? err.stack : err}`);
        }
      }

      return undefined;
    },

    list() {
      const out = {};
      for (const [eventName, map] of hooks.entries()) out[eventName] = Array.from(map.keys());
      return out;
    },

    clear() {
      hooks.clear();
    }
  };
})();
JS_HOOK

cat > game/openvibe.games/js/core/gamemode.js <<'JS_GM'
(function () {
  let current = null;

  globalThis.gamemode = {
    set(gm) {
      if (!gm || typeof gm !== "object") throw new Error("gamemode.set requires object");
      current = gm;
    },

    get() {
      return current;
    },

    call(name, ...args) {
      const hookResult = hook.run(name, ...args);
      if (hookResult !== undefined) return hookResult;

      if (current && typeof current[name] === "function") {
        return current[name](...args);
      }

      return undefined;
    }
  };
})();
JS_GM

cat > game/openvibe.games/js/bridge.js <<'JS_BRIDGE'
OV.log("bridge.js loaded");

globalThis.console = {
  log: (...args) => OV.log(args.map(String).join(" ")),
  warn: (...args) => OV.warn(args.map(String).join(" ")),
  error: (...args) => OV.error(args.map(String).join(" "))
};

globalThis.game = {
  mode: () => OV.getMode(),
  map: () => OV.getMapName(),
  time: () => OV.time(),
  broadcast: (msg) => OV.broadcast(String(msg)),
  serverCommand: (cmd) => OV.serverCommand(String(cmd))
};

globalThis.round = {
  start: () => OV.fireHook("RoundStart"),
  end: () => OV.fireHook("RoundEnd")
};
JS_BRIDGE

cat > game/openvibe.games/js/gamemodes/base/server.js <<'JS_BASE'
const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    OV.log("Base Initialize fired");
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

  Think() {}
};

gamemode.set(GM);
JS_HUB

cat > game/openvibe.games/js/gamemodes/prophunt/server.js <<'JS_PH'
const props = ["crate", "barrel", "chair", "bucket"];

function randomProp() {
  return props[Math.floor(Math.random() * props.length)];
}

const GM = {
  mode: "prophunt",
  name: "OpenVibe Prop Hunt",

  Initialize() {
    OV.log("Prop Hunt Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Prop Hunt: hide as props or hunt them down.");
  },

  PlayerSay(ply, text) {
    if (text === "!prop") {
      ply.runCommand(`ov_prophunt_disguise ${randomProp()}`);
      return false;
    }

    if (text.startsWith("!prop ")) {
      ply.runCommand(`ov_prophunt_disguise ${text.slice(6).trim()}`);
      return false;
    }

    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
JS_PH

cat > game/openvibe.games/js/gamemodes/deathrun/server.js <<'JS_DR'
const GM = {
  mode: "deathrun",
  name: "OpenVibe Deathrun",

  Initialize() {
    OV.log("Deathrun Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Deathrun: survive the traps and reach the finish.");
  },

  PlayerSay(ply, text) {
    if (text === "!finish") {
      ply.chat("Deathrun finish test.");
      OV.reward(ply, 50, 100, "deathrun_finish");
      return false;
    }

    return undefined;
  }
};

gamemode.set(GM);
JS_DR

cat > game/openvibe.games/js/gamemodes/fortwars/server.js <<'JS_FW'
const allowed = new Set(["crate", "barrel", "pallet", "fence", "sheet"]);

const GM = {
  mode: "fortwars",
  name: "OpenVibe Fort Wars",

  Initialize() {
    OV.log("Fort Wars Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Fort Wars: build first, fight second.");
  },

  PlayerSay(ply, text) {
    if (!text.startsWith("!build ")) return undefined;

    const part = text.slice(7).trim();
    if (!allowed.has(part)) {
      ply.chat("Allowed: crate, barrel, pallet, fence, sheet");
      return false;
    }

    ply.runCommand(`ov_fortwars_spawn ${part}`);
    return false;
  }
};

gamemode.set(GM);
JS_FW

cat > game/openvibe.games/js/gamemodes/traitortown/server.js <<'JS_TT'
const roles = new Map();

const GM = {
  mode: "traitortown",
  name: "OpenVibe Traitor Town",

  Initialize() {
    OV.log("Traitor Town Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Traitor Town: find the traitors before they find you.");
    roles.set(ply.userId(), "innocent");
  },

  PlayerSay(ply, text) {
    if (text === "!role") {
      ply.chat(`Your role: ${roles.get(ply.userId()) || "none"}`);
      return false;
    }

    return undefined;
  },

  PlayerDeath(victim, attacker) {
    OV.broadcast(`${victim.name()} died.`);
  }
};

gamemode.set(GM);
JS_TT

echo "[openvibe] writing C++ embedded JS files"

cat > sdk/openvibe/shared/ov_js_runtime.h <<'CPP_RT_H'
#pragma once

#include "openvibe/third_party/quickjs/quickjs.h"

class COpenVibeJSRuntime
{
public:
    COpenVibeJSRuntime();
    ~COpenVibeJSRuntime();

    bool Init(bool bServerRealm, const char *pszMode);
    void Shutdown();

    bool LoadFile(const char *pszPath);
    bool Eval(const char *pszCode, const char *pszFilename);

    JSValue CallHookRaw(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    void CallHookVoid(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    bool CallHookBool(const char *pszHookName, bool *pOut, int argc = 0, JSValueConst *argv = nullptr);

    JSContext *Context() { return m_pCtx; }
    const char *GetMode() const { return m_szMode; }

private:
    void PrintException(const char *pszWhere);
    bool LoadCoreFiles();
    bool LoadGamemode();

    JSRuntime *m_pRuntime = nullptr;
    JSContext *m_pCtx = nullptr;
    bool m_bServerRealm = false;
    char m_szMode[64]{};
};
CPP_RT_H

cat > sdk/openvibe/shared/ov_js_runtime.cpp <<'CPP_RT_CPP'
#include "cbase.h"
#include "filesystem.h"
#include "ov_js_runtime.h"
#include "ov_js_bindings.h"

#include "tier0/memdbgon.h"

static int OV_JSInterruptHandler(JSRuntime *rt, void *opaque)
{
    return 0;
}

COpenVibeJSRuntime::COpenVibeJSRuntime() {}

COpenVibeJSRuntime::~COpenVibeJSRuntime()
{
    Shutdown();
}

bool COpenVibeJSRuntime::Init(bool bServerRealm, const char *pszMode)
{
    Shutdown();

    m_bServerRealm = bServerRealm;
    Q_strncpy(m_szMode, pszMode && pszMode[0] ? pszMode : "hub", sizeof(m_szMode));

    m_pRuntime = JS_NewRuntime();
    if (!m_pRuntime)
        return false;

    JS_SetMemoryLimit(m_pRuntime, 16 * 1024 * 1024);
    JS_SetMaxStackSize(m_pRuntime, 512 * 1024);
    JS_SetInterruptHandler(m_pRuntime, OV_JSInterruptHandler, this);

    m_pCtx = JS_NewContext(m_pRuntime);
    if (!m_pCtx)
    {
        Shutdown();
        return false;
    }

    OVJS_RegisterNativeBindings(m_pCtx, this);

    if (!LoadCoreFiles())
        return false;

    if (!LoadGamemode())
        return false;

    return true;
}

void COpenVibeJSRuntime::Shutdown()
{
    if (m_pCtx)
    {
        JS_FreeContext(m_pCtx);
        m_pCtx = nullptr;
    }

    if (m_pRuntime)
    {
        JS_FreeRuntime(m_pRuntime);
        m_pRuntime = nullptr;
    }
}

bool COpenVibeJSRuntime::Eval(const char *pszCode, const char *pszFilename)
{
    if (!m_pCtx || !pszCode)
        return false;

    JSValue result = JS_Eval(
        m_pCtx,
        pszCode,
        Q_strlen(pszCode),
        pszFilename ? pszFilename : "<openvibe>",
        JS_EVAL_TYPE_GLOBAL
    );

    if (JS_IsException(result))
    {
        PrintException(pszFilename);
        JS_FreeValue(m_pCtx, result);
        return false;
    }

    JS_FreeValue(m_pCtx, result);
    return true;
}

bool COpenVibeJSRuntime::LoadFile(const char *pszPath)
{
    FileHandle_t file = filesystem->Open(pszPath, "rb", "MOD");
    if (!file)
    {
        Warning("[OV JS] Could not open %s\n", pszPath);
        return false;
    }

    int size = filesystem->Size(file);
    if (size <= 0 || size > 1024 * 1024)
    {
        filesystem->Close(file);
        Warning("[OV JS] Refusing script %s size=%d\n", pszPath, size);
        return false;
    }

    char *buffer = new char[size + 1];
    filesystem->Read(buffer, size, file);
    filesystem->Close(file);
    buffer[size] = '\0';

    bool ok = Eval(buffer, pszPath);
    delete[] buffer;

    return ok;
}

bool COpenVibeJSRuntime::LoadCoreFiles()
{
    if (!LoadFile("js/core/hook.js"))
        return false;

    if (!LoadFile("js/core/gamemode.js"))
        return false;

    if (!LoadFile("js/bridge.js"))
        return false;

    return true;
}

bool COpenVibeJSRuntime::LoadGamemode()
{
    LoadFile("js/gamemodes/base/server.js");

    char path[256];
    Q_snprintf(path, sizeof(path), "js/gamemodes/%s/%s.js", m_szMode, m_bServerRealm ? "server" : "client");

    return LoadFile(path);
}

JSValue COpenVibeJSRuntime::CallHookRaw(const char *pszHookName, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return JS_UNDEFINED;

    JSValue global = JS_GetGlobalObject(m_pCtx);
    JSValue gamemode = JS_GetPropertyStr(m_pCtx, global, "gamemode");
    JSValue call = JS_GetPropertyStr(m_pCtx, gamemode, "call");

    if (!JS_IsFunction(m_pCtx, call))
    {
        JS_FreeValue(m_pCtx, call);
        JS_FreeValue(m_pCtx, gamemode);
        JS_FreeValue(m_pCtx, global);
        return JS_UNDEFINED;
    }

    JSValue *callArgs = new JSValue[argc + 1];
    callArgs[0] = JS_NewString(m_pCtx, pszHookName);

    for (int i = 0; i < argc; ++i)
        callArgs[i + 1] = JS_DupValue(m_pCtx, argv[i]);

    JSValue result = JS_Call(m_pCtx, call, gamemode, argc + 1, callArgs);

    for (int i = 0; i < argc + 1; ++i)
        JS_FreeValue(m_pCtx, callArgs[i]);

    delete[] callArgs;

    JS_FreeValue(m_pCtx, call);
    JS_FreeValue(m_pCtx, gamemode);
    JS_FreeValue(m_pCtx, global);

    if (JS_IsException(result))
    {
        PrintException(pszHookName);
        JS_FreeValue(m_pCtx, result);
        return JS_UNDEFINED;
    }

    return result;
}

void COpenVibeJSRuntime::CallHookVoid(const char *pszHookName, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return;

    JSValue result = CallHookRaw(pszHookName, argc, argv);
    JS_FreeValue(m_pCtx, result);
}

bool COpenVibeJSRuntime::CallHookBool(const char *pszHookName, bool *pOut, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return false;

    JSValue result = CallHookRaw(pszHookName, argc, argv);

    if (JS_IsUndefined(result))
    {
        JS_FreeValue(m_pCtx, result);
        return false;
    }

    if (pOut)
        *pOut = JS_ToBool(m_pCtx, result) != 0;

    JS_FreeValue(m_pCtx, result);
    return true;
}

void COpenVibeJSRuntime::PrintException(const char *pszWhere)
{
    JSValue exception = JS_GetException(m_pCtx);
    const char *pszError = JS_ToCString(m_pCtx, exception);

    Warning("[OV JS] Exception in %s: %s\n", pszWhere ? pszWhere : "<unknown>", pszError ? pszError : "<null>");

    if (pszError)
        JS_FreeCString(m_pCtx, pszError);

    JS_FreeValue(m_pCtx, exception);
}
CPP_RT_CPP

cat > sdk/openvibe/shared/ov_js_bindings.h <<'CPP_BIND_H'
#pragma once

#include "openvibe/third_party/quickjs/quickjs.h"

class COpenVibeJSRuntime;

void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime);
CPP_BIND_H

cat > sdk/openvibe/shared/ov_js_player.h <<'CPP_PLAYER_H'
#pragma once

#include "openvibe/third_party/quickjs/quickjs.h"

class CHL2MP_Player;

void OVJS_RegisterPlayerClass(JSContext *ctx);
JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player);
CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId);
CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal);
CPP_PLAYER_H

cat > sdk/openvibe/shared/ov_js_player.cpp <<'CPP_PLAYER_CPP'
#include "cbase.h"
#include "hl2mp_player.h"
#include "player.h"
#include "util.h"
#include "ov_js_player.h"

#include "tier0/memdbgon.h"

struct OVJSPlayerHandle
{
    int userId;
    int entIndex;
};

static JSClassID g_OVJSPlayerClassID;

CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId)
{
    for (int i = 1; i <= gpGlobals->maxClients; ++i)
    {
        CBasePlayer *base = UTIL_PlayerByIndex(i);
        if (!base)
            continue;

        CHL2MP_Player *player = ToHL2MPPlayer(base);
        if (!player)
            continue;

        if (player->GetUserID() == userId)
            return player;
    }

    return nullptr;
}

static void OVJS_PlayerFinalizer(JSRuntime *rt, JSValue val)
{
    OVJSPlayerHandle *handle = static_cast<OVJSPlayerHandle *>(JS_GetOpaque(val, g_OVJSPlayerClassID));
    delete handle;
}

CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal)
{
    OVJSPlayerHandle *handle = static_cast<OVJSPlayerHandle *>(JS_GetOpaque2(ctx, thisVal, g_OVJSPlayerClassID));
    if (!handle)
        return nullptr;

    CHL2MP_Player *player = OVJS_ResolvePlayerByUserId(handle->userId);
    if (!player)
        return nullptr;

    if (player->entindex() != handle->entIndex)
        return nullptr;

    return player;
}

static JSValue OVJS_Player_userId(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    OVJSPlayerHandle *handle = static_cast<OVJSPlayerHandle *>(JS_GetOpaque2(ctx, thisVal, g_OVJSPlayerClassID));
    return handle ? JS_NewInt32(ctx, handle->userId) : JS_UNDEFINED;
}

static JSValue OVJS_Player_entIndex(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    OVJSPlayerHandle *handle = static_cast<OVJSPlayerHandle *>(JS_GetOpaque2(ctx, thisVal, g_OVJSPlayerClassID));
    return handle ? JS_NewInt32(ctx, handle->entIndex) : JS_UNDEFINED;
}

static JSValue OVJS_Player_name(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    return JS_NewString(ctx, player ? player->GetPlayerName() : "");
}

static JSValue OVJS_Player_steamId(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player)
        return JS_NewString(ctx, "");

    const char *netid = engine->GetPlayerNetworkIDString(player->edict());
    return JS_NewString(ctx, netid ? netid : "");
}

static JSValue OVJS_Player_health(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    return JS_NewInt32(ctx, player ? player->GetHealth() : 0);
}

static JSValue OVJS_Player_setHealth(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    int32 value = 0;
    JS_ToInt32(ctx, &value, argv[0]);

    if (value < 0) value = 0;
    if (value > 1000) value = 1000;

    player->SetHealth(value);
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_team(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    return JS_NewInt32(ctx, player ? player->GetTeamNumber() : 0);
}

static JSValue OVJS_Player_setTeam(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    int32 team = 0;
    JS_ToInt32(ctx, &team, argv[0]);

    if (team >= 0 && team <= 4)
        player->ChangeTeam(team);

    return JS_UNDEFINED;
}

static JSValue OVJS_Player_chat(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    const char *msg = JS_ToCString(ctx, argv[0]);
    if (!msg)
        return JS_UNDEFINED;

    ClientPrint(player, HUD_PRINTTALK, msg);

    JS_FreeCString(ctx, msg);
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_runCommand(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    const char *cmd = JS_ToCString(ctx, argv[0]);
    if (!cmd)
        return JS_UNDEFINED;

    if (!Q_strnicmp(cmd, "ov_", 3))
        engine->ClientCommand(player->edict(), "%s\n", cmd);
    else
        Warning("[OV JS] blocked player command: %s\n", cmd);

    JS_FreeCString(ctx, cmd);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry OVJSPlayerProtoFuncs[] =
{
    JS_CFUNC_DEF("userId", 0, OVJS_Player_userId),
    JS_CFUNC_DEF("entIndex", 0, OVJS_Player_entIndex),
    JS_CFUNC_DEF("steamId", 0, OVJS_Player_steamId),
    JS_CFUNC_DEF("name", 0, OVJS_Player_name),
    JS_CFUNC_DEF("health", 0, OVJS_Player_health),
    JS_CFUNC_DEF("setHealth", 1, OVJS_Player_setHealth),
    JS_CFUNC_DEF("team", 0, OVJS_Player_team),
    JS_CFUNC_DEF("setTeam", 1, OVJS_Player_setTeam),
    JS_CFUNC_DEF("chat", 1, OVJS_Player_chat),
    JS_CFUNC_DEF("runCommand", 1, OVJS_Player_runCommand),
};

void OVJS_RegisterPlayerClass(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(&g_OVJSPlayerClassID);

    JSClassDef cls = {};
    cls.class_name = "OpenVibePlayer";
    cls.finalizer = OVJS_PlayerFinalizer;

    JS_NewClass(rt, g_OVJSPlayerClassID, &cls);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, OVJSPlayerProtoFuncs, ARRAYSIZE(OVJSPlayerProtoFuncs));
    JS_SetClassProto(ctx, g_OVJSPlayerClassID, proto);
}

JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player)
{
    if (!player)
        return JS_NULL;

    JSValue obj = JS_NewObjectClass(ctx, g_OVJSPlayerClassID);
    if (JS_IsException(obj))
        return obj;

    OVJSPlayerHandle *handle = new OVJSPlayerHandle();
    handle->userId = player->GetUserID();
    handle->entIndex = player->entindex();

    JS_SetOpaque(obj, handle);
    return obj;
}
CPP_PLAYER_CPP

cat > sdk/openvibe/shared/ov_js_bindings.cpp <<'CPP_BIND_CPP'
#include "cbase.h"
#include "ov_js_bindings.h"
#include "ov_js_runtime.h"
#include "ov_js_player.h"
#include "hl2mp_player.h"
#include "util.h"

#include "tier0/memdbgon.h"

static COpenVibeJSRuntime *g_OVRuntime = nullptr;

static JSValue OVJS_log(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) { Msg("[OV JS] %s\n", msg); JS_FreeCString(ctx, msg); }
    return JS_UNDEFINED;
}

static JSValue OVJS_warn(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) { Warning("[OV JS] %s\n", msg); JS_FreeCString(ctx, msg); }
    return JS_UNDEFINED;
}

static JSValue OVJS_error(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) { Warning("[OV JS ERROR] %s\n", msg); JS_FreeCString(ctx, msg); }
    return JS_UNDEFINED;
}

static JSValue OVJS_getMode(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, g_OVRuntime ? g_OVRuntime->GetMode() : "unknown");
}

static JSValue OVJS_getMapName(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, gpGlobals ? STRING(gpGlobals->mapname) : "");
}

static JSValue OVJS_time(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    return JS_NewFloat64(ctx, gpGlobals ? gpGlobals->curtime : 0.0);
}

static JSValue OVJS_players(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    JSValue arr = JS_NewArray(ctx);
    uint32 index = 0;

    for (int i = 1; i <= gpGlobals->maxClients; ++i)
    {
        CBasePlayer *base = UTIL_PlayerByIndex(i);
        if (!base) continue;

        CHL2MP_Player *player = ToHL2MPPlayer(base);
        if (!player) continue;

        JS_SetPropertyUint32(ctx, arr, index++, OVJS_NewPlayer(ctx, player));
    }

    return arr;
}

static JSValue OVJS_playerByUserId(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_NULL;

    int32 userId = 0;
    JS_ToInt32(ctx, &userId, argv[0]);

    CHL2MP_Player *player = OVJS_ResolvePlayerByUserId(userId);
    return player ? OVJS_NewPlayer(ctx, player) : JS_NULL;
}

static JSValue OVJS_broadcast(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;

    const char *msg = JS_ToCString(ctx, argv[0]);
    if (!msg) return JS_UNDEFINED;

    UTIL_ClientPrintAll(HUD_PRINTTALK, msg);

    JS_FreeCString(ctx, msg);
    return JS_UNDEFINED;
}

static bool OVJS_IsAllowedServerCommand(const char *cmd)
{
    return cmd && (!Q_strnicmp(cmd, "ov_", 3) || !Q_strnicmp(cmd, "say ", 4));
}

static JSValue OVJS_serverCommand(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_UNDEFINED;

    const char *cmd = JS_ToCString(ctx, argv[0]);
    if (!cmd) return JS_UNDEFINED;

    if (OVJS_IsAllowedServerCommand(cmd))
        engine->ServerCommand(UTIL_VarArgs("%s\n", cmd));
    else
        Warning("[OV JS] blocked serverCommand: %s\n", cmd);

    JS_FreeCString(ctx, cmd);
    return JS_UNDEFINED;
}

static JSValue OVJS_fireHook(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (!g_OVRuntime || argc < 1) return JS_UNDEFINED;

    const char *hookName = JS_ToCString(ctx, argv[0]);
    if (!hookName) return JS_UNDEFINED;

    JSValue result = g_OVRuntime->CallHookRaw(hookName, argc - 1, argv + 1);

    JS_FreeCString(ctx, hookName);
    return result;
}

static JSValue OVJS_reward(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    Warning("[OV JS] OV.reward stubbed; backend reward wiring comes next.\n");
    return JS_UNDEFINED;
}

static JSValue OVJS_endMatch(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    Warning("[OV JS] OV.endMatch stubbed; backend match wiring comes next.\n");
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry OVFuncs[] =
{
    JS_CFUNC_DEF("log", 1, OVJS_log),
    JS_CFUNC_DEF("warn", 1, OVJS_warn),
    JS_CFUNC_DEF("error", 1, OVJS_error),
    JS_CFUNC_DEF("getMode", 0, OVJS_getMode),
    JS_CFUNC_DEF("getMapName", 0, OVJS_getMapName),
    JS_CFUNC_DEF("time", 0, OVJS_time),
    JS_CFUNC_DEF("players", 0, OVJS_players),
    JS_CFUNC_DEF("playerByUserId", 1, OVJS_playerByUserId),
    JS_CFUNC_DEF("broadcast", 1, OVJS_broadcast),
    JS_CFUNC_DEF("serverCommand", 1, OVJS_serverCommand),
    JS_CFUNC_DEF("fireHook", 1, OVJS_fireHook),
    JS_CFUNC_DEF("reward", 4, OVJS_reward),
    JS_CFUNC_DEF("endMatch", 1, OVJS_endMatch),
};

void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime)
{
    g_OVRuntime = runtime;

    OVJS_RegisterPlayerClass(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ov = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, ov, OVFuncs, ARRAYSIZE(OVFuncs));
    JS_SetPropertyStr(ctx, global, "OV", ov);

    JS_FreeValue(ctx, global);
}
CPP_BIND_CPP

cat > sdk/openvibe/server/hl2mp/openvibe_js_server.h <<'CPP_JS_SERVER_H'
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
CPP_JS_SERVER_H

cat > sdk/openvibe/server/hl2mp/openvibe_js_server.cpp <<'CPP_JS_SERVER_CPP'
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
    if (g_OVServerJSStarted)
        return;

    g_OVServerJSStarted = true;

    if (!ov_js_enabled.GetBool())
    {
        Msg("[OV JS] disabled by ov_js_enabled=0\n");
        return;
    }

    if (g_OVServerJS.Init(true, ov_mode.GetString()))
    {
        Msg("[OV JS] server runtime initialized for mode '%s'\n", ov_mode.GetString());
        g_OVServerJS.CallHookVoid("Initialize");

        JSContext *ctx = g_OVServerJS.Context();
        JSValue mapName = JS_NewString(ctx, gpGlobals ? STRING(gpGlobals->mapname) : "");
        JSValueConst argv[] = { mapName };
        g_OVServerJS.CallHookVoid("MapInitialize", 1, argv);
        JS_FreeValue(ctx, mapName);
    }
    else
    {
        Warning("[OV JS] server runtime failed to initialize\n");
    }
}

void OpenVibeJS_ServerInit()
{
    OpenVibeJS_EnsureStarted();
}

void OpenVibeJS_ServerShutdown()
{
    if (OpenVibeJS_IsRunning())
        g_OVServerJS.CallHookVoid("Shutdown");

    g_OVServerJS.Shutdown();
    g_OVServerJSStarted = false;
}

void OpenVibeJS_ServerThink()
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning())
        return;

    g_OVServerJS.CallHookVoid("Think");
}

void OpenVibeJS_Server_PlayerInitialSpawn(CHL2MP_Player *player)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !player)
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer(ctx, player);

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid("PlayerInitialSpawn", 1, argv);

    JS_FreeValue(ctx, ply);
}

void OpenVibeJS_Server_PlayerSpawn(CHL2MP_Player *player)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !player)
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer(ctx, player);

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid("PlayerSpawn", 1, argv);

    JS_FreeValue(ctx, ply);
}

void OpenVibeJS_Server_PlayerDeath(CHL2MP_Player *victim, CBaseEntity *attacker, CBaseEntity *inflictor)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !victim)
        return;

    JSContext *ctx = g_OVServerJS.Context();

    JSValue jsVictim = OVJS_NewPlayer(ctx, victim);
    JSValue jsAttacker = JS_NULL;

    if (attacker && attacker->IsPlayer())
        jsAttacker = OVJS_NewPlayer(ctx, ToHL2MPPlayer(static_cast<CBasePlayer *>(attacker)));

    JSValueConst argv[] = { jsVictim, jsAttacker };
    g_OVServerJS.CallHookVoid("PlayerDeath", 2, argv);

    JS_FreeValue(ctx, jsVictim);
    JS_FreeValue(ctx, jsAttacker);
}

void OpenVibeJS_Server_PlayerDisconnected(CHL2MP_Player *player)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !player)
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue ply = OVJS_NewPlayer(ctx, player);

    JSValueConst argv[] = { ply };
    g_OVServerJS.CallHookVoid("PlayerDisconnected", 1, argv);

    JS_FreeValue(ctx, ply);
}

bool OpenVibeJS_Server_PlayerSay(CHL2MP_Player *player, const char *text)
{
    OpenVibeJS_EnsureStarted();

    if (!OpenVibeJS_IsRunning() || !player || !text)
        return false;

    JSContext *ctx = g_OVServerJS.Context();

    JSValue ply = OVJS_NewPlayer(ctx, player);
    JSValue msg = JS_NewString(ctx, text);

    JSValueConst argv[] = { ply, msg };

    bool value = false;
    bool returned = g_OVServerJS.CallHookBool("PlayerSay", &value, 2, argv);

    JS_FreeValue(ctx, ply);
    JS_FreeValue(ctx, msg);

    return returned && value == false;
}

static void OV_JSReload_f()
{
    OpenVibeJS_ServerShutdown();
    OpenVibeJS_ServerInit();
    Msg("[OV JS] reloaded\n");
}

static ConCommand ov_js_reload(
    "ov_js_reload",
    OV_JSReload_f,
    "Reload OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);
CPP_JS_SERVER_CPP

echo "[openvibe] replacing apply-openvibe-sdk.sh"

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

QJS_C="$SDK/src/game/shared/openvibe/third_party/quickjs/quickjs.c"
if [[ -f "$QJS_C" ]] && ! grep -q 'OPENVIBE_QUICKJS_CONFIG' "$QJS_C"; then
  tmp="$(mktemp)"
  cat > "$tmp" <<'QCFG'
#ifndef OPENVIBE_QUICKJS_CONFIG
#define OPENVIBE_QUICKJS_CONFIG
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef CONFIG_VERSION
#define CONFIG_VERSION "openvibe"
#endif
#endif

QCFG
  cat "$QJS_C" >> "$tmp"
  mv "$tmp" "$QJS_C"
fi

CLIENT_VPC="$SDK/src/game/client/client_hl2mp.vpc"
SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"
HL2MP_CLIENT="$SDK/src/game/server/hl2mp/hl2mp_client.cpp"
HL2MP_CLIENTMODE="$SDK/src/game/client/hl2mp/clientmode_hl2mpnormal.cpp"
GAMEINTERFACE="$SDK/src/game/server/gameinterface.cpp"
HL2MP_PLAYER="$SDK/src/game/server/hl2mp/hl2mp_player.cpp"

perl -0pi -e 's/^.*hl2mp\\openvibe_client\.cpp.*\n//mg; s/^.*hl2mp\\vgui_openvibe_menu\.cpp.*\n//mg; s/(\$File\s+"hl2mp\\clientmode_hl2mpnormal\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_client.cpp"\n\t\t\t\$File\t"hl2mp\\vgui_openvibe_menu.cpp"\n/s' "$CLIENT_VPC"
echo "[openvibe-sdk] patched client_hl2mp.vpc"

perl -0pi -e '
  s/^.*hl2mp\\openvibe_server\.cpp.*\n//mg;
  s/^.*hl2mp\\openvibe_js_server\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_runtime\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_bindings\.cpp.*\n//mg;
  s/^.*openvibe\\ov_js_player\.cpp.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\quickjs\.c.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\libregexp\.c.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\libunicode\.c.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\cutils\.c.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\dtoa\.c.*\n//mg;
  s/^.*openvibe\\third_party\\quickjs\\libbf\.c.*\n//mg;
  s/(\$File\s+"hl2mp\\hl2mp_player\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_server.cpp"\n\t\t\t\$File\t"hl2mp\\openvibe_js_server.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_runtime.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_bindings.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\ov_js_player.cpp"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\quickjs.c"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\libregexp.c"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\libunicode.c"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\cutils.c"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\dtoa.c"\n\t\t\t\$File\t"..\\shared\\openvibe\\third_party\\quickjs\\libbf.c"\n/s;
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

# Best-effort patch for common Source SDK 2013 HL2MP Host_Say shape:
# CHL2MP_Player *client = ...
# const char *p = args.ArgS();
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

echo "[openvibe] patching sdk/openvibe/server/hl2mp/openvibe_server.cpp"

backup_file sdk/openvibe/server/hl2mp/openvibe_server.cpp

python3 <<'PY'
from pathlib import Path
import re

path = Path("sdk/openvibe/server/hl2mp/openvibe_server.cpp")
s = path.read_text()

if '#include "openvibe_js_server.h"' not in s:
    # Put it after hl2mp_player include if possible, else after first include.
    s = re.sub(
        r'(#include\s+"hl2mp_player\.h"\s*\n)',
        r'\1#include "openvibe_js_server.h"\n',
        s,
        count=1,
    )
    if '#include "openvibe_js_server.h"' not in s:
        s = re.sub(r'(#include\s+".*?"\s*\n)', r'\1#include "openvibe_js_server.h"\n', s, count=1)

def replace_function_body(src, signature_regex, new_body):
    m = re.search(signature_regex, src)
    if not m:
        print(f"[openvibe] WARNING: missing function matching {signature_regex}")
        return src

    brace = src.find("{", m.end())
    if brace < 0:
        print(f"[openvibe] WARNING: missing opening brace for {signature_regex}")
        return src

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
        print(f"[openvibe] WARNING: missing closing brace for {signature_regex}")
        return src

    return src[:brace + 1] + "\n" + new_body.rstrip() + "\n" + src[end:]

s = replace_function_body(
    s,
    r'void\s+OpenVibe_OnFrame\s*\(\s*\)',
    """
    OpenVibeJS_ServerThink();
"""
)

s = replace_function_body(
    s,
    r'void\s+OpenVibe_OnClientDisconnect\s*\(\s*CBasePlayer\s*\*\s*pPlayer\s*\)',
    """
    CHL2MP_Player *pHL2MP = ToHL2MPPlayer( pPlayer );
    if ( pHL2MP )
        OpenVibeJS_Server_PlayerDisconnected( pHL2MP );
"""
)

s = replace_function_body(
    s,
    r'void\s+OpenVibe_OnPlayerDeath\s*\(\s*CHL2MP_Player\s*\*\s*pPlayer\s*,\s*CBaseEntity\s*\*\s*pKiller\s*\)',
    """
    OpenVibeJS_Server_PlayerDeath( pPlayer, pKiller, NULL );
"""
)

if "OpenVibeJS_Server_PlayerInitialSpawn( pPlayer );" not in s:
    m = re.search(r'void\s+OpenVibe_OnClientActive\s*\(\s*CHL2MP_Player\s*\*\s*pPlayer\s*\)', s)
    if m:
        brace = s.find("{", m.end())
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
        if end:
            s = s[:end] + "\n    OpenVibeJS_Server_PlayerInitialSpawn( pPlayer );\n" + s[end:]
            print("[openvibe] patched OpenVibe_OnClientActive -> PlayerInitialSpawn")
        else:
            print("[openvibe] WARNING: could not patch OpenVibe_OnClientActive body")
    else:
        print("[openvibe] WARNING: OpenVibe_OnClientActive not found")

path.write_text(s)
PY

echo "[openvibe] running QuickJS smoke test"

tools/smoke-quickjs.sh

echo
echo "[openvibe] embedded JS bootstrap files written."
echo
echo "Next:"
echo "  tools/apply-openvibe-sdk.sh"
echo "  tools/build-sdk-linux.sh"
echo "  tools/setup-openvibe-bin.sh"
echo "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
echo
echo "Then in server console:"
echo "  ov_js_reload"
echo
echo "Then in game:"
echo "  connect 127.0.0.1:27015"
echo "  say !js"
echo "  say !hp"
