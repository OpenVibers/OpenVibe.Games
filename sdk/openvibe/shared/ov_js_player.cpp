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

// Bridge JS SWEP class names (weapon_ov_*) to a real engine weapon body so the
// player gets a functional weapon in-game while the JS SWEP drives gamemode
// logic. Until the fully JS-driven predicted weapon proxy lands, this is how a
// js/weapons/ definition maps onto something the engine can actually hold.
static const char *OVJS_ResolveWeaponClass(const char *jsClass)
{
    struct Map { const char *js; const char *engine; };
    static const Map s_Map[] =
    {
        { "weapon_ov_pistol",    "weapon_pistol" },
        { "weapon_ov_357",       "weapon_357" },
        { "weapon_ov_smg",       "weapon_smg1" },
        { "weapon_ov_shotgun",   "weapon_shotgun" },
        { "weapon_ov_crowbar",   "weapon_crowbar" },
        { "weapon_ov_stunstick", "weapon_stunstick" },
    };
    for (int i = 0; i < ARRAYSIZE(s_Map); ++i)
        if (!Q_stricmp(jsClass, s_Map[i].js))
            return s_Map[i].engine;
    return jsClass; // stock weapon names (weapon_*) pass through unchanged
}

static JSValue OVJS_Player_give(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_NULL;

    const char *jsClass = JS_ToCString(ctx, argv[0]);
    if (!jsClass)
        return JS_NULL;

    // Only weapon_* classes may be given this way.
    JSValue result = JS_NULL;
    if (!Q_strnicmp(jsClass, "weapon_", 7))
    {
        const char *engineClass = OVJS_ResolveWeaponClass(jsClass);
        CBaseEntity *wep = player->GiveNamedItem(engineClass);
        if (wep)
        {
            JSValue obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, obj, "entIndex", JS_NewInt32(ctx, wep->entindex()));
            result = obj;
        }
    }
    else
    {
        Warning("[OV JS] Player.Give refused non-weapon class: %s\n", jsClass);
    }

    JS_FreeCString(ctx, jsClass);
    return result;
}

static JSValue OVJS_Player_stripWeapons(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (player)
        player->RemoveAllItems(false);
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_stripWeapon(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    const char *jsClass = JS_ToCString(ctx, argv[0]);
    if (jsClass)
    {
        const char *engineClass = OVJS_ResolveWeaponClass(jsClass);
        CBaseCombatWeapon *wep = player->Weapon_OwnsThisType(engineClass);
        if (wep)
        {
            player->Weapon_Drop(wep);
            UTIL_Remove(wep);
        }
        JS_FreeCString(ctx, jsClass);
    }
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_giveAmmo(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 2)
        return JS_UNDEFINED;

    int32 amount = 0;
    JS_ToInt32(ctx, &amount, argv[0]);
    const char *ammoType = JS_ToCString(ctx, argv[1]);
    if (ammoType)
    {
        // Qualified call: the derived player hides the const char* overload.
        player->CBaseCombatCharacter::GiveAmmo((int)amount, ammoType, false);
        JS_FreeCString(ctx, ammoType);
    }
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_getActiveWeapon(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    CBaseCombatWeapon *wep = player ? player->GetActiveWeapon() : NULL;
    if (!wep)
        return JS_NULL;

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "entIndex", JS_NewInt32(ctx, wep->entindex()));
    JS_SetPropertyStr(ctx, obj, "class", JS_NewString(ctx, wep->GetClassname()));
    return obj;
}

static JSValue OVJS_Player_selectWeapon(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player || argc < 1)
        return JS_UNDEFINED;

    const char *jsClass = JS_ToCString(ctx, argv[0]);
    if (jsClass)
    {
        CBaseCombatWeapon *wep = player->Weapon_OwnsThisType(OVJS_ResolveWeaponClass(jsClass));
        if (wep)
            player->Weapon_Switch(wep);
        JS_FreeCString(ctx, jsClass);
    }
    return JS_UNDEFINED;
}

static JSValue OVJS_Player_viewPunch(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv)
{
    CHL2MP_Player *player = OVJS_GetPlayerFromThis(ctx, thisVal);
    if (!player)
        return JS_UNDEFINED;

    double p = 0, y = 0, r = 0;
    if (argc > 0) JS_ToFloat64(ctx, &p, argv[0]);
    if (argc > 1) JS_ToFloat64(ctx, &y, argv[1]);
    if (argc > 2) JS_ToFloat64(ctx, &r, argv[2]);
    player->ViewPunch(QAngle((float)p, (float)y, (float)r));
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
    JS_CFUNC_DEF("give", 1, OVJS_Player_give),
    JS_CFUNC_DEF("stripWeapons", 0, OVJS_Player_stripWeapons),
    JS_CFUNC_DEF("stripWeapon", 1, OVJS_Player_stripWeapon),
    JS_CFUNC_DEF("giveAmmo", 2, OVJS_Player_giveAmmo),
    JS_CFUNC_DEF("getActiveWeapon", 0, OVJS_Player_getActiveWeapon),
    JS_CFUNC_DEF("selectWeapon", 1, OVJS_Player_selectWeapon),
    JS_CFUNC_DEF("viewPunch", 3, OVJS_Player_viewPunch),
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
