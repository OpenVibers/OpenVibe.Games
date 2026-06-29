#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
#include "hl2mp_player.h"
#include "openvibe_js_server.h"

#include "tier0/memdbgon.h"

static ConVar ov_mode(
    "ov_mode",
    "hub",
    FCVAR_GAMEDLL,
    "OpenVibe mode: hub, prophunt, deathrun, fortwars, traitortown." );

static ConVar ov_js_enabled(
    "ov_js_enabled",
    "0",
    FCVAR_GAMEDLL,
    "Enable OpenVibe JavaScript runtime. Windows server CI uses a stub runtime." );

void OpenVibeJS_ServerInit()
{
    Msg("[OV JS] Windows server CI stub active; runtime disabled, mode=%s\n", ov_mode.GetString());
}

void OpenVibeJS_ServerShutdown() {}
void OpenVibeJS_ServerThink() {}
void OpenVibeJS_Server_PlayerInitialSpawn(CHL2MP_Player *player) {}
void OpenVibeJS_Server_PlayerSpawn(CHL2MP_Player *player) {}
void OpenVibeJS_Server_PlayerDeath(CHL2MP_Player *victim, CBaseEntity *attacker, CBaseEntity *inflictor) {}
void OpenVibeJS_Server_PlayerDisconnected(CHL2MP_Player *player) {}
bool OpenVibeJS_Server_PlayerSay(CHL2MP_Player *player, const char *text) { return false; }

static void OV_JSReload_f()
{
    Msg("[OV JS] Windows server CI stub: ov_js_reload ignored, mode=%s\n", ov_mode.GetString());
}

static ConCommand ov_js_reload(
    "ov_js_reload",
    OV_JSReload_f,
    "Reload OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);

static void OV_JSStatus_f()
{
    Msg("[OV JS] enabled=%d started=0 running=0 mode=%s backend=windows-server-stub\n",
        ov_js_enabled.GetBool() ? 1 : 0,
        ov_mode.GetString() );
}

static ConCommand ov_js_status(
    "ov_js_status",
    OV_JSStatus_f,
    "Print OpenVibe JavaScript runtime status.",
    FCVAR_GAMEDLL
);

static void OV_JSFire_f(const CCommand &args)
{
    Msg("[OV JS] Windows server CI stub: ov_js_fire ignored. Usage: ov_js_fire <HookName>\n");
}

static ConCommand ov_js_fire(
    "ov_js_fire",
    OV_JSFire_f,
    "Fire an OpenVibe JavaScript hook with no arguments.",
    FCVAR_GAMEDLL
);

static void OV_JSCmd_f(const CCommand &args)
{
    Msg("[OV JS] Windows server CI stub: ov_js_cmd %s\n", args.ArgS());
}

static ConCommand ov_js_cmd(
    "ov_js_cmd",
    OV_JSCmd_f,
    "Send a ConsoleCommand event into the embedded OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);
#else
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
#endif
