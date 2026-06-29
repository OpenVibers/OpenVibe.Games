#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
#include "ov_js_player.h"
#include "hl2mp_player.h"

#include "tier0/memdbgon.h"

void OVJS_RegisterPlayerClass(JSContext *ctx) {}
JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player) { return JS_NULL; }
CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId) { return nullptr; }
CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal) { return nullptr; }
#else
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
#endif
