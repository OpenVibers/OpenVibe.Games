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

// GMod's sv_allowcslua equivalent: gates js_run_cl / js_openscript_cl on
// clients. Replicated so the client bridge can read it. Default 1 for dev.
static ConVar sv_allowcsjs(
    "sv_allowcsjs",
    "1",
    FCVAR_REPLICATED | FCVAR_NOTIFY,
    "Allow clients to run their own JavaScript (js_run_cl / js_openscript_cl)." );

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

static void OV_JSRun_f(const CCommand &args)
{
    Msg("[OV JS] Windows server CI stub: js_run ignored\n");
}

static ConCommand js_run(
    "js_run",
    OV_JSRun_f,
    "Run JavaScript in the server realm: js_run <code>.",
    FCVAR_GAMEDLL
);

static void OV_JSOpenScript_f(const CCommand &args)
{
    Msg("[OV JS] Windows server CI stub: js_openscript ignored\n");
}

static ConCommand js_openscript(
    "js_openscript",
    OV_JSOpenScript_f,
    "Run a script file in the server realm: js_openscript <path relative to js/>.",
    FCVAR_GAMEDLL
);

static void OV_Npm_f(const CCommand &args)
{
    Warning("ov_npm requires ov_js_backend node\n");
}

static ConCommand ov_npm(
    "ov_npm",
    OV_Npm_f,
    "Run npm in the mod js/ tree via the Node runtime: ov_npm <install|update|...> [args].",
    FCVAR_GAMEDLL
);

void OpenVibeJS_Server_RoundStart(int roundNumber)
{
    Msg("[OV JS] Windows server CI stub: RoundStart round=%d\n", roundNumber);
}

void OpenVibeJS_Server_RoundEnd(int roundNumber, const char *reason)
{
    Msg("[OV JS] Windows server CI stub: RoundEnd round=%d reason=%s\n",
        roundNumber, reason ? reason : "");
}

static void OV_RoundStart_f(const CCommand &args)
{
    const int round = args.ArgC() >= 2 ? Q_atoi(args[1]) : 1;
    OpenVibeJS_Server_RoundStart(round);
}

static ConCommand ov_round_start(
    "ov_round_start",
    OV_RoundStart_f,
    "Fire the RoundStart hook into the OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);

static void OV_RoundEnd_f(const CCommand &args)
{
    const int round        = args.ArgC() >= 2 ? Q_atoi(args[1]) : 1;
    const char *pszReason  = args.ArgC() >= 3 ? args[2] : "time";
    OpenVibeJS_Server_RoundEnd(round, pszReason);
}

static ConCommand ov_round_end(
    "ov_round_end",
    OV_RoundEnd_f,
    "Fire the RoundEnd hook into the OpenVibe JavaScript runtime. Usage: ov_round_end <round> [reason]",
    FCVAR_GAMEDLL
);
#else
#include "hl2mp_player.h"
#include "openvibe_js_server.h"
#include "openvibe/ov_js_runtime.h"
#include "openvibe/ov_js_player.h"
#include "openvibe/ov_ipc.h"
#include "recipientfilter.h"
#include "openvibe/third_party/quickjs/quickjs.h"

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

// Backend for the server JS framework: "embedded" = in-process QuickJS (default,
// always works on Linux); "node" = forward events to the Node.js runtime host
// (ov-runtime.js) over IPC for full npm + hot-reload.
static ConVar ov_js_backend(
    "ov_js_backend", "embedded", FCVAR_GAMEDLL,
    "OpenVibe server JS backend: embedded | node" );
static ConVar ov_js_node_port(
    "ov_js_node_port", "41999", FCVAR_GAMEDLL,
    "TCP port of the OpenVibe server Node.js runtime host." );

// GMod's sv_allowcslua equivalent: gates js_run_cl / js_openscript_cl on
// clients. Replicated so the client bridge can read it. Default 1 for dev.
static ConVar sv_allowcsjs(
    "sv_allowcsjs", "1", FCVAR_REPLICATED | FCVAR_NOTIFY,
    "Allow clients to run their own JavaScript (js_run_cl / js_openscript_cl)." );

static COpenVibeJSRuntime g_OVServerJS;
static bool g_OVServerJSStarted = false;

// ---------------------------------------------------------------------------
// Node.js runtime bridge (server realm). Active when ov_js_backend == "node".
// ---------------------------------------------------------------------------
static COpenVibeIPC g_ServerIPC;
static bool OVServer_UseNode() { return !Q_stricmp( ov_js_backend.GetString(), "node" ); }

static bool OVJSONGetStr( const char *json, const char *key, char *out, int outSize )
{
    char needle[64]; Q_snprintf( needle, sizeof( needle ), "\"%s\":\"", key );
    const char *s = Q_strstr( json, needle );
    if ( !s ) return false;
    s += Q_strlen( needle );
    int i = 0;
    while ( *s && *s != '"' && i < outSize - 1 ) { if ( *s == '\\' && s[1] ) s++; out[i++] = *s++; }
    out[i] = '\0';
    return true;
}
static int OVJSONGetInt( const char *json, const char *key, int def )
{
    char needle[64]; Q_snprintf( needle, sizeof( needle ), "\"%s\":", key );
    const char *s = Q_strstr( json, needle );
    if ( !s ) return def;
    return atoi( s + Q_strlen( needle ) );
}
static void OVJSONAppendEsc( char *dst, int cap, const char *src )
{
    int len = Q_strlen( dst );
    for ( const char *p = src; p && *p && len < cap - 3; ++p )
    {
        char c = *p;
        if ( c == '"' || c == '\\' ) { dst[len++] = '\\'; dst[len++] = c; }
        else if ( c == '\n' || c == '\r' ) { dst[len++] = ' '; }
        else dst[len++] = c;
    }
    dst[len] = '\0';
}

// Apply a command line from the Node runtime.
static void OVServer_OnLine( const char *line )
{
    char t[32];
    if ( !OVJSONGetStr( line, "t", t, sizeof( t ) ) ) return;

    if ( !Q_strcmp( t, "chat" ) )
    {
        char msg[512]; if ( !OVJSONGetStr( line, "msg", msg, sizeof( msg ) ) ) return;
        int uid = OVJSONGetInt( line, "userId", -1 );
        if ( uid >= 0 ) { CBasePlayer *p = UTIL_PlayerByUserId( uid ); if ( p ) ClientPrint( p, HUD_PRINTTALK, msg ); }
        else UTIL_ClientPrintAll( HUD_PRINTTALK, msg );
    }
    else if ( !Q_strcmp( t, "concmd" ) )
    {
        char cmd[512]; if ( OVJSONGetStr( line, "cmd", cmd, sizeof( cmd ) ) ) engine->ServerCommand( UTIL_VarArgs( "%s\n", cmd ) );
    }
    else if ( !Q_strcmp( t, "runcmd" ) )
    {
        // Run an ov_* command as a specific player (e.g. ov_fortwars_spawn crate).
        char cmd[512]; int uid = OVJSONGetInt( line, "userId", -1 );
        if ( uid >= 0 && OVJSONGetStr( line, "cmd", cmd, sizeof( cmd ) ) )
        {
            CBasePlayer *p = UTIL_PlayerByUserId( uid );
            if ( p ) { engine->ClientCommand( p->edict(), "%s", cmd ); }
        }
    }
    else if ( !Q_strcmp( t, "eval-result" ) )
    {
        // js_run result echoed back by the runtime — already logged there.
    }
    else if ( !Q_strcmp( t, "net" ) )
    {
        // server -> client net: OVNet usermessage. ids: CSV of userIds, -1 = all.
        char ids[256], name[128], payload[8192];
        OVJSONGetStr( line, "ids", ids, sizeof( ids ) );
        if ( !OVJSONGetStr( line, "name", name, sizeof( name ) ) ) return;
        OVJSONGetStr( line, "payload", payload, sizeof( payload ) );
        bool broadcast = ( Q_strstr( ids, "-1" ) != NULL ) || ids[0] == '\0';
        if ( broadcast )
        {
            CBroadcastRecipientFilter f;
            UserMessageBegin( f, "OVNet" ); WRITE_STRING( name ); WRITE_STRING( payload ); MessageEnd();
        }
        else
        {
            for ( char *tok = strtok( ids, "," ); tok; tok = strtok( NULL, "," ) )
            {
                CBasePlayer *p = UTIL_PlayerByUserId( atoi( tok ) );
                if ( !p ) continue;
                CSingleUserRecipientFilter f( p );
                UserMessageBegin( f, "OVNet" ); WRITE_STRING( name ); WRITE_STRING( payload ); MessageEnd();
            }
        }
    }
}

static void OVServer_SendHello()
{
    char hello[256];
    Q_snprintf( hello, sizeof( hello ), "{\"t\":\"hello\",\"realm\":\"server\",\"mode\":\"%s\",\"map\":\"%s\"}",
        ov_mode.GetString(), gpGlobals ? STRING( gpGlobals->mapname ) : "" );
    g_ServerIPC.SendLine( hello );
}

// Append a {"__player":true,"userId":N} marker (or null) to an outbound
// {"t":"event"} line — ov-runtime.js onGameMessage wraps these back into
// Player objects before firing the hook.
static void OVServer_AppendPlayerMarker( char *out, int cap, CHL2MP_Player *player )
{
    if ( !player )
    {
        Q_strncat( out, "null", cap, COPY_ALL_CHARACTERS );
        return;
    }

    char marker[64];
    Q_snprintf( marker, sizeof( marker ), "{\"__player\":true,\"userId\":%d}", player->GetUserID() );
    Q_strncat( out, marker, cap, COPY_ALL_CHARACTERS );
}

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

    if ( OVServer_UseNode() )
    {
        g_ServerIPC.Configure( "127.0.0.1", ov_js_node_port.GetInt(), OVServer_OnLine );
        g_ServerIPC.Poll();
        OVServer_SendHello();
        Msg( "[OV JS] server backend=node (runtime bridge port %d)\n", ov_js_node_port.GetInt() );
        return; // embedded QuickJS not used in node mode
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

    if ( OVServer_UseNode() )
    {
        g_ServerIPC.Poll();
        static float s_flNextThink = 0.0f;
        if ( gpGlobals && gpGlobals->curtime >= s_flNextThink )
        {
            s_flNextThink = gpGlobals->curtime + 0.1f; // 10Hz think to Node
            if ( g_ServerIPC.IsConnected() ) g_ServerIPC.SendLine( "{\"t\":\"think\"}" );
        }
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
        return;

    g_OVServerJS.CallHookVoid( "Think" );
}

void OpenVibeJS_Server_PlayerInitialSpawn( CHL2MP_Player *player )
{
    OpenVibeJS_EnsureStarted();

    if ( OVServer_UseNode() )
    {
        if ( !player || !g_ServerIPC.IsConnected() )
            return;
        const char *netid = engine->GetPlayerNetworkIDString( player->edict() );
        char out[512];
        Q_snprintf( out, sizeof( out ), "{\"t\":\"player_connect\",\"userId\":%d,\"name\":\"", player->GetUserID() );
        OVJSONAppendEsc( out, sizeof( out ), player->GetPlayerName() );
        Q_strncat( out, "\",\"steamId\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
        OVJSONAppendEsc( out, sizeof( out ), netid ? netid : "" );
        char tail[48];
        Q_snprintf( tail, sizeof( tail ), "\",\"entIndex\":%d}", player->entindex() );
        Q_strncat( out, tail, sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        return;
    }

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

    if ( OVServer_UseNode() )
    {
        if ( !player || !g_ServerIPC.IsConnected() )
            return;
        char out[256] = "{\"t\":\"event\",\"name\":\"PlayerSpawn\",\"args\":[";
        OVServer_AppendPlayerMarker( out, sizeof( out ), player );
        Q_strncat( out, "]}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        return;
    }

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

    if ( OVServer_UseNode() )
    {
        if ( !victim || !g_ServerIPC.IsConnected() )
            return;
        CHL2MP_Player *attackerPlayer = ( attacker && attacker->IsPlayer() )
            ? ToHL2MPPlayer( static_cast<CBasePlayer *>( attacker ) ) : NULL;
        char out[256] = "{\"t\":\"event\",\"name\":\"PlayerDeath\",\"args\":[";
        OVServer_AppendPlayerMarker( out, sizeof( out ), victim );
        Q_strncat( out, ",", sizeof( out ), COPY_ALL_CHARACTERS );
        OVServer_AppendPlayerMarker( out, sizeof( out ), attackerPlayer );
        Q_strncat( out, "]}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        return;
    }

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

    if ( OVServer_UseNode() )
    {
        if ( !player || !g_ServerIPC.IsConnected() )
            return;
        char out[64];
        Q_snprintf( out, sizeof( out ), "{\"t\":\"player_disconnect\",\"userId\":%d}", player->GetUserID() );
        g_ServerIPC.SendLine( out );
        return;
    }

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

    if ( OVServer_UseNode() )
    {
        if ( !player || !text || !g_ServerIPC.IsConnected() ) return false;
        char out[1024] = "{\"t\":\"say\",\"userId\":";
        char num[16]; Q_snprintf( num, sizeof( num ), "%d", player->GetUserID() );
        Q_strncat( out, num, sizeof( out ), COPY_ALL_CHARACTERS );
        Q_strncat( out, ",\"text\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
        OVJSONAppendEsc( out, sizeof( out ), text );
        Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        // Chat commands (leading '!') are handled by JS; suppress them from public chat.
        return text[0] == '!';
    }

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

// ---------------------------------------------------------------------------
// GModJS script commands — js_run / js_openscript / ov_npm (server realm).
// Embedded backend evals in-process; node backend forwards over IPC.
// Results are echoed to the invoking client's console (the HTML GUI console
// mirrors the client console through the spew tap, so this is what makes
// js_run output visible in-game).
// ---------------------------------------------------------------------------
static void OV_JSEchoToCaller( const char *pszLine )
{
    if ( !pszLine || !pszLine[0] )
        return;

    CBasePlayer *pPlayer = UTIL_GetCommandClient();
    if ( pPlayer )
    {
        char szMsg[512];
        Q_snprintf( szMsg, sizeof( szMsg ), "[OV JS] %s\n", pszLine );
        ClientPrint( pPlayer, HUD_PRINTCONSOLE, szMsg );
    }
}

static void OV_JSRun_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: js_run <code>\n" );
        return;
    }

    OpenVibeJS_EnsureStarted();

    if ( OVServer_UseNode() )
    {
        if ( !g_ServerIPC.IsConnected() )
        {
            Warning( "[OV JS] node runtime not connected; js_run ignored\n" );
            OV_JSEchoToCaller( "node runtime not connected; js_run ignored" );
            return;
        }
        char out[4096] = "{\"t\":\"eval\",\"code\":\"";
        OVJSONAppendEsc( out, sizeof( out ), args.ArgS() );
        Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        OV_JSEchoToCaller( "sent to node runtime (result in runtime log / GUI console)" );
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
    {
        Warning( "[OV JS] runtime is not running\n" );
        OV_JSEchoToCaller( "runtime is not running" );
        return;
    }

    char szResult[480];
    g_OVServerJS.RunStringResult( args.ArgS(), szResult, sizeof( szResult ) );
    OV_JSEchoToCaller( szResult );
}

static ConCommand js_run(
    "js_run",
    OV_JSRun_f,
    "Run JavaScript in the server realm: js_run <code>.",
    FCVAR_GAMEDLL
);

static void OV_JSOpenScript_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: js_openscript <path relative to js/>\n" );
        return;
    }

    OpenVibeJS_EnsureStarted();

    if ( OVServer_UseNode() )
    {
        if ( !g_ServerIPC.IsConnected() )
        {
            Warning( "[OV JS] node runtime not connected; js_openscript ignored\n" );
            OV_JSEchoToCaller( "node runtime not connected; js_openscript ignored" );
            return;
        }
        char out[1024] = "{\"t\":\"openscript\",\"path\":\"";
        OVJSONAppendEsc( out, sizeof( out ), args[1] );
        Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        OV_JSEchoToCaller( "sent to node runtime" );
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
    {
        Warning( "[OV JS] runtime is not running\n" );
        OV_JSEchoToCaller( "runtime is not running" );
        return;
    }

    char code[1024] = "OVLoader.openScript(\"";
    OVJSONAppendEsc( code, sizeof( code ), args[1] );
    Q_strncat( code, "\")", sizeof( code ), COPY_ALL_CHARACTERS );
    char szResult[480];
    g_OVServerJS.RunStringResult( code, szResult, sizeof( szResult ) );
    char szEcho[512];
    Q_snprintf( szEcho, sizeof( szEcho ), "js_openscript %s -> %s", args[1], szResult );
    OV_JSEchoToCaller( szEcho );
}

static ConCommand js_openscript(
    "js_openscript",
    OV_JSOpenScript_f,
    "Run a script file in the server realm: js_openscript <path relative to js/>.",
    FCVAR_GAMEDLL
);

static void OV_Npm_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: ov_npm <install|update|uninstall|ls> [args]\n" );
        return;
    }

    OpenVibeJS_EnsureStarted();

    if ( !OVServer_UseNode() )
    {
        Warning( "ov_npm requires ov_js_backend node\n" );
        return;
    }

    if ( !g_ServerIPC.IsConnected() )
    {
        Warning( "[OV JS] node runtime not connected; ov_npm ignored\n" );
        return;
    }

    char out[1024] = "{\"t\":\"npm\",\"args\":[";
    for ( int i = 1; i < args.ArgC(); ++i )
    {
        if ( i > 1 )
            Q_strncat( out, ",", sizeof( out ), COPY_ALL_CHARACTERS );
        Q_strncat( out, "\"", sizeof( out ), COPY_ALL_CHARACTERS );
        OVJSONAppendEsc( out, sizeof( out ), args[i] );
        Q_strncat( out, "\"", sizeof( out ), COPY_ALL_CHARACTERS );
    }
    Q_strncat( out, "]}", sizeof( out ), COPY_ALL_CHARACTERS );
    g_ServerIPC.SendLine( out );
}

static ConCommand ov_npm(
    "ov_npm",
    OV_Npm_f,
    "Run npm in the mod js/ tree via the Node runtime: ov_npm <install|update|...> [args].",
    FCVAR_GAMEDLL
);

// ---------------------------------------------------------------------------
// net library — client->server transport.
// The client forwards net messages as: ov_net <name> <payloadBase64>
// We fire the "OVNetReceive" hook into server JS with the sending player, and
// net.js dispatches to the matching net.Receive(name, fn) handler.
// ---------------------------------------------------------------------------
static void OV_Net_f( const CCommand &args )
{
    if ( args.ArgC() < 3 )
    {
        Msg( "Usage: ov_net <name> <payloadBase64>\n" );
        return;
    }

    OpenVibeJS_EnsureStarted();

    CHL2MP_Player *cmdPlayer = ToHL2MPPlayer( UTIL_GetCommandClient() );

    if ( OVServer_UseNode() )
    {
        if ( !g_ServerIPC.IsConnected() ) return;
        char out[9000] = "{\"t\":\"net\",\"userId\":";
        char num[16]; Q_snprintf( num, sizeof( num ), "%d", cmdPlayer ? cmdPlayer->GetUserID() : -1 );
        Q_strncat( out, num, sizeof( out ), COPY_ALL_CHARACTERS );
        Q_strncat( out, ",\"name\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
        OVJSONAppendEsc( out, sizeof( out ), args[1] );
        Q_strncat( out, "\",\"payload\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
        OVJSONAppendEsc( out, sizeof( out ), args[2] );
        Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
        return;

    JSContext *ctx = g_OVServerJS.Context();

    JSValue name    = JS_NewString( ctx, args[1] );
    JSValue payload = JS_NewString( ctx, args[2] );

    // UTIL_GetCommandClient() is the player who ran the command (null on the
    // server console). DON'T TRUST THE CLIENT — net.Receive handlers must
    // validate, per the GMod net guide.
    CHL2MP_Player *player = cmdPlayer;
    JSValue ply = player ? OVJS_NewPlayer( ctx, player ) : JS_NULL;

    JSValueConst argv[] = { name, payload, ply };
    g_OVServerJS.CallHookVoid( "OVNetReceive", 3, argv );

    JS_FreeValue( ctx, name );
    JS_FreeValue( ctx, payload );
    JS_FreeValue( ctx, ply );
}

static ConCommand ov_net(
    "ov_net",
    OV_Net_f,
    "OpenVibe net library client->server transport: ov_net <name> <payloadBase64>.",
    FCVAR_GAMEDLL
);

void OpenVibeJS_Server_RoundStart( int roundNumber )
{
    OpenVibeJS_EnsureStarted();

    if ( OVServer_UseNode() )
    {
        if ( !g_ServerIPC.IsConnected() )
            return;
        char out[96];
        Q_snprintf( out, sizeof( out ), "{\"t\":\"event\",\"name\":\"RoundStart\",\"args\":[%d]}", roundNumber );
        g_ServerIPC.SendLine( out );
        Msg( "[OV JS] RoundStart forwarded round=%d\n", roundNumber );
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue jsRound = JS_NewInt32( ctx, roundNumber );
    JSValueConst argv[] = { jsRound };
    g_OVServerJS.CallHookVoid( "RoundStart", 1, argv );
    JS_FreeValue( ctx, jsRound );

    Msg( "[OV JS] RoundStart fired round=%d\n", roundNumber );
}

void OpenVibeJS_Server_RoundEnd( int roundNumber, const char *reason )
{
    OpenVibeJS_EnsureStarted();

    if ( OVServer_UseNode() )
    {
        if ( !g_ServerIPC.IsConnected() )
            return;
        char out[256];
        Q_snprintf( out, sizeof( out ), "{\"t\":\"event\",\"name\":\"RoundEnd\",\"args\":[%d,\"", roundNumber );
        OVJSONAppendEsc( out, sizeof( out ), reason ? reason : "time" );
        Q_strncat( out, "\"]}", sizeof( out ), COPY_ALL_CHARACTERS );
        g_ServerIPC.SendLine( out );
        Msg( "[OV JS] RoundEnd forwarded round=%d reason=%s\n", roundNumber, reason ? reason : "time" );
        return;
    }

    if ( !OpenVibeJS_IsRunning() )
        return;

    JSContext *ctx = g_OVServerJS.Context();
    JSValue jsRound  = JS_NewInt32( ctx, roundNumber );
    JSValue jsReason = JS_NewString( ctx, reason ? reason : "time" );
    JSValueConst argv[] = { jsRound, jsReason };
    g_OVServerJS.CallHookVoid( "RoundEnd", 2, argv );
    JS_FreeValue( ctx, jsRound );
    JS_FreeValue( ctx, jsReason );

    Msg( "[OV JS] RoundEnd fired round=%d reason=%s\n", roundNumber, reason ? reason : "time" );
}

static void OV_RoundStart_f( const CCommand &args )
{
    const int round = args.ArgC() >= 2 ? Q_atoi( args[1] ) : 1;
    OpenVibeJS_Server_RoundStart( round );
}

static ConCommand ov_round_start(
    "ov_round_start",
    OV_RoundStart_f,
    "Fire the RoundStart hook into the OpenVibe JavaScript runtime.",
    FCVAR_GAMEDLL
);

static void OV_RoundEnd_f( const CCommand &args )
{
    const int round        = args.ArgC() >= 2 ? Q_atoi( args[1] ) : 1;
    const char *pszReason  = args.ArgC() >= 3 ? args[2] : "time";
    OpenVibeJS_Server_RoundEnd( round, pszReason );
}

static ConCommand ov_round_end(
    "ov_round_end",
    OV_RoundEnd_f,
    "Fire the RoundEnd hook into the OpenVibe JavaScript runtime. Usage: ov_round_end <round> [reason]",
    FCVAR_GAMEDLL
);
#endif
