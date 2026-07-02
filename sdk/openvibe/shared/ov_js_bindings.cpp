#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
#include "ov_js_bindings.h"

#include "tier0/memdbgon.h"

void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime) {}
#else
#include "ov_js_bindings.h"
#include "ov_js_runtime.h"
#include "ov_js_player.h"
#include "hl2mp_player.h"
#include "util.h"
#include "filesystem.h"

#include "tier0/memdbgon.h"

static COpenVibeJSRuntime *g_OVRuntime = nullptr;

// Reject paths that could escape the mod directory. The "MOD" search path
// already sandboxes reads to the game folder, but we defensively block
// absolute paths and parent traversal so JS can only touch mod-relative files.
static bool OVJS_IsSafeModPath(const char *pszPath)
{
    if (!pszPath || !pszPath[0]) return false;
    if (pszPath[0] == '/' || pszPath[0] == '\\') return false;
    if (Q_strstr(pszPath, "..")) return false;
    if (Q_strstr(pszPath, ":")) return false; // drive-letter / alt stream
    return true;
}

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

static JSValue OVJS_isServer(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    return (g_OVRuntime && g_OVRuntime->IsServerRealm()) ? JS_TRUE : JS_FALSE;
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

// ---------------------------------------------------------------------------
// File I/O bridge — foundation for the JS require()/addon/npm module loader.
// All reads are sandboxed to the mod ("MOD") search path.
// ---------------------------------------------------------------------------

// OV.readFile(path) -> string | null
static JSValue OVJS_readFile(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_NULL;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_NULL;

    if (!OVJS_IsSafeModPath(path))
    {
        Warning("[OV JS] OV.readFile refused unsafe path: %s\n", path);
        JS_FreeCString(ctx, path);
        return JS_NULL;
    }

    FileHandle_t file = filesystem->Open(path, "rb", "MOD");
    if (!file)
    {
        JS_FreeCString(ctx, path);
        return JS_NULL;
    }

    int size = filesystem->Size(file);
    if (size < 0 || size > 8 * 1024 * 1024)
    {
        filesystem->Close(file);
        Warning("[OV JS] OV.readFile refusing %s size=%d\n", path, size);
        JS_FreeCString(ctx, path);
        return JS_NULL;
    }

    char *buffer = new char[size + 1];
    filesystem->Read(buffer, size, file);
    filesystem->Close(file);
    buffer[size] = '\0';

    JSValue out = JS_NewStringLen(ctx, buffer, size);
    delete[] buffer;
    JS_FreeCString(ctx, path);
    return out;
}

// OV.fileExists(path) -> bool
static JSValue OVJS_fileExists(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    if (argc < 1) return JS_FALSE;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_FALSE;

    bool exists = OVJS_IsSafeModPath(path)
        && filesystem->FileExists(path, "MOD")
        && !filesystem->IsDirectory(path, "MOD");
    JS_FreeCString(ctx, path);
    return exists ? JS_TRUE : JS_FALSE;
}

// OV.listDir(dir, wildcard="*") -> string[] (names only, files and dirs)
static JSValue OVJS_listDir(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    JSValue arr = JS_NewArray(ctx);
    if (argc < 1) return arr;

    const char *dir = JS_ToCString(ctx, argv[0]);
    if (!dir) return arr;

    // Optional wildcard arg; owned separately so freeing is unambiguous.
    const char *wildcardArg = (argc >= 2 && JS_IsString(argv[1])) ? JS_ToCString(ctx, argv[1]) : nullptr;
    const char *wildcard = (wildcardArg && wildcardArg[0]) ? wildcardArg : "*";

    if (!OVJS_IsSafeModPath(dir))
    {
        Warning("[OV JS] OV.listDir refused unsafe path: %s\n", dir);
        if (wildcardArg) JS_FreeCString(ctx, wildcardArg);
        JS_FreeCString(ctx, dir);
        return arr;
    }

    char search[512];
    Q_snprintf(search, sizeof(search), "%s/%s", dir, wildcard);

    FileFindHandle_t findHandle;
    const char *name = filesystem->FindFirstEx(search, "MOD", &findHandle);
    uint32 index = 0;
    while (name)
    {
        if (Q_strcmp(name, ".") != 0 && Q_strcmp(name, "..") != 0)
            JS_SetPropertyUint32(ctx, arr, index++, JS_NewString(ctx, name));
        name = filesystem->FindNext(findHandle);
    }
    filesystem->FindClose(findHandle);

    if (wildcardArg) JS_FreeCString(ctx, wildcardArg);
    JS_FreeCString(ctx, dir);
    return arr;
}

static const JSCFunctionListEntry OVFuncs[] =
{
    JS_CFUNC_DEF("log", 1, OVJS_log),
    JS_CFUNC_DEF("warn", 1, OVJS_warn),
    JS_CFUNC_DEF("error", 1, OVJS_error),
    JS_CFUNC_DEF("getMode", 0, OVJS_getMode),
    JS_CFUNC_DEF("isServer", 0, OVJS_isServer),
    JS_CFUNC_DEF("getMapName", 0, OVJS_getMapName),
    JS_CFUNC_DEF("time", 0, OVJS_time),
    JS_CFUNC_DEF("players", 0, OVJS_players),
    JS_CFUNC_DEF("playerByUserId", 1, OVJS_playerByUserId),
    JS_CFUNC_DEF("broadcast", 1, OVJS_broadcast),
    JS_CFUNC_DEF("serverCommand", 1, OVJS_serverCommand),
    JS_CFUNC_DEF("fireHook", 1, OVJS_fireHook),
    JS_CFUNC_DEF("reward", 4, OVJS_reward),
    JS_CFUNC_DEF("endMatch", 1, OVJS_endMatch),
    JS_CFUNC_DEF("readFile", 1, OVJS_readFile),
    JS_CFUNC_DEF("fileExists", 1, OVJS_fileExists),
    JS_CFUNC_DEF("listDir", 2, OVJS_listDir),
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
#endif
