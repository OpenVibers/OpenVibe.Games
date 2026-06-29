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
