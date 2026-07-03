#include "cbase.h"
#include "openvibe_js_client.h"

// Client realm bridge to the OpenVibe Node.js runtime. The client no longer
// embeds a JS engine (that crashed under clang-cl); instead this forwards engine
// events to ov-runtime.js over a local TCP socket and applies the commands it
// sends back. Client-side JS/npm/hooks run in real Node; UI runs in the HTML
// panel. This is a thin, crash-proof bridge.
#include "openvibe/ov_ipc.h"
#include "usermessages.h"
#include "c_baseplayer.h"
#include <stdlib.h>
#include <string.h>

#include "tier0/memdbgon.h"

static ConVar ov_client_js_enabled(
    "ov_client_js_enabled", "1", FCVAR_CLIENTDLL,
    "Enable the OpenVibe client-side Node.js runtime bridge." );
static ConVar ov_client_js_port(
    "ov_client_js_port", "41998", FCVAR_CLIENTDLL,
    "TCP port of the OpenVibe client Node.js runtime host." );
static ConVar ov_client_mode(
    "ov_client_mode", "sandbox", FCVAR_CLIENTDLL,
    "OpenVibe client gamemode realm hint sent to the runtime." );

static COpenVibeIPC g_ClientIPC;
static bool g_bClientBridgeStarted = false;
static bool g_bSentLocalPlayer = false;

// ---- tiny JSON helpers (build + extract) ----
static void OVJSON_AppendEscaped( char *dst, int dstSize, const char *src )
{
    int len = Q_strlen( dst );
    for ( const char *p = src; p && *p && len < dstSize - 2; ++p )
    {
        char c = *p;
        if ( c == '"' || c == '\\' ) { if ( len < dstSize - 3 ) { dst[len++] = '\\'; dst[len++] = c; } }
        else if ( c == '\n' ) { dst[len++] = ' '; }
        else if ( c == '\r' ) { /* skip */ }
        else { dst[len++] = c; }
    }
    dst[len] = '\0';
}

static bool OVJSON_GetString( const char *json, const char *key, char *out, int outSize )
{
    char needle[64];
    Q_snprintf( needle, sizeof( needle ), "\"%s\":\"", key );
    const char *s = Q_strstr( json, needle );
    if ( !s ) return false;
    s += Q_strlen( needle );
    int i = 0;
    while ( *s && *s != '"' && i < outSize - 1 )
    {
        if ( *s == '\\' && s[1] ) s++;
        out[i++] = *s++;
    }
    out[i] = '\0';
    return true;
}

// ---- inbound: commands from the Node runtime ----
static void OVClient_OnLine( const char *line )
{
    char t[32];
    if ( !OVJSON_GetString( line, "t", t, sizeof( t ) ) ) return;

    if ( !Q_strcmp( t, "chat" ) )
    {
        char msg[512];
        if ( OVJSON_GetString( line, "msg", msg, sizeof( msg ) ) )
            Msg( "[OV] %s\n", msg );
    }
    else if ( !Q_strcmp( t, "concmd" ) || !Q_strcmp( t, "runcmd" ) )
    {
        char cmd[1024];
        if ( OVJSON_GetString( line, "cmd", cmd, sizeof( cmd ) ) )
        {
            char full[1100];
            Q_snprintf( full, sizeof( full ), "%s\n", cmd );
            engine->ClientCmd_Unrestricted( full );
        }
    }
    else if ( !Q_strcmp( t, "net" ) )
    {
        // client runtime -> server: forward as ov_net
        char name[128], payload[8192];
        if ( OVJSON_GetString( line, "name", name, sizeof( name ) ) &&
             OVJSON_GetString( line, "payload", payload, sizeof( payload ) ) )
        {
            char cmd[9000];
            Q_snprintf( cmd, sizeof( cmd ), "ov_net %s %s\n", name, payload );
            engine->ClientCmd_Unrestricted( cmd );
        }
    }
    else if ( !Q_strcmp( t, "menu" ) )
    {
        char action[32];
        OVJSON_GetString( line, "action", action, sizeof( action ) );
        engine->ClientCmd_Unrestricted( !Q_strcmp( action, "close" ) ? "ov_menu_close\n" : "ov_menu\n" );
    }
}

// ---- outbound: server->client net usermessage -> runtime ----
void __MsgFunc_OVNet( bf_read &msg )
{
    if ( !g_ClientIPC.IsConnected() ) return;
    char name[128]; char payload[8192];
    msg.ReadString( name, sizeof( name ) );
    msg.ReadString( payload, sizeof( payload ) );
    char out[9000] = "{\"t\":\"net\",\"name\":\"";
    OVJSON_AppendEscaped( out, sizeof( out ), name );
    Q_strncat( out, "\",\"payload\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
    OVJSON_AppendEscaped( out, sizeof( out ), payload );
    Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
    g_ClientIPC.SendLine( out );
}

// ---- outbound: local player identity -> runtime ----
// Sent once per level, as soon as the local player entity is valid (it isn't
// yet at LevelInitPostEntity, so OpenVibeJS_Client_Think retries).
static void OVClient_TrySendLocalPlayer()
{
    if ( g_bSentLocalPlayer || !g_ClientIPC.IsConnected() ) return;

    C_BasePlayer *pLocal = C_BasePlayer::GetLocalPlayer();
    if ( !pLocal ) return;

    player_info_t pi;
    if ( !engine->GetPlayerInfo( pLocal->entindex(), &pi ) ) return;

    char out[512];
    Q_snprintf( out, sizeof( out ), "{\"t\":\"local_player\",\"userId\":%d,\"name\":\"", pi.userID );
    OVJSON_AppendEscaped( out, sizeof( out ), pi.name );
    Q_strncat( out, "\",\"steamId\":\"", sizeof( out ), COPY_ALL_CHARACTERS );
    OVJSON_AppendEscaped( out, sizeof( out ), pi.guid );
    char tail[48];
    Q_snprintf( tail, sizeof( tail ), "\",\"entIndex\":%d}", pLocal->entindex() );
    Q_strncat( out, tail, sizeof( out ), COPY_ALL_CHARACTERS );

    g_ClientIPC.SendLine( out );
    g_bSentLocalPlayer = true;
}

// ---- lifecycle ----
void OpenVibeJS_Client_Init()
{
    if ( g_bClientBridgeStarted ) return;
    g_bClientBridgeStarted = true;
    g_bSentLocalPlayer = false;
    if ( !ov_client_js_enabled.GetBool() )
    {
        Msg( "[OV JS/client] bridge disabled by ov_client_js_enabled=0\n" );
        return;
    }
    g_ClientIPC.Configure( "127.0.0.1", ov_client_js_port.GetInt(), OVClient_OnLine );
    g_ClientIPC.Poll(); // attempt initial connect

    char hello[256];
    Q_snprintf( hello, sizeof( hello ), "{\"t\":\"hello\",\"realm\":\"client\",\"mode\":\"%s\",\"map\":\"%s\"}",
        ov_client_mode.GetString(), engine ? engine->GetLevelName() : "" );
    g_ClientIPC.SendLine( hello );
    Msg( "[OV JS/client] Node runtime bridge started (port %d)\n", ov_client_js_port.GetInt() );
}

void OpenVibeJS_Client_Shutdown()
{
    if ( g_ClientIPC.IsConnected() ) g_ClientIPC.SendLine( "{\"t\":\"bye\"}" );
    g_ClientIPC.Close();
    g_bClientBridgeStarted = false;
}

// Implemented in vgui_openvibe_menu.cpp (console spew ring + menu override).
extern bool OpenVibe_DrainConsoleLine( int64 *pnCursor, char *pszOut, int nOutLen );
extern void OpenVibe_MenuKeepAlive();

// Escape a console line for embedding in a JSON string value.
static void OVClient_JSONEscape( char *pszOut, int nOutLen, const char *pszIn )
{
    int w = 0;
    for ( const char *p = pszIn; *p && w < nOutLen - 2; ++p )
    {
        unsigned char c = (unsigned char)*p;
        if ( c == '"' || c == '\\' )
        {
            if ( w >= nOutLen - 3 ) break;
            pszOut[w++] = '\\';
            pszOut[w++] = c;
        }
        else if ( c < 0x20 )
        {
            pszOut[w++] = ' ';
        }
        else
        {
            pszOut[w++] = c;
        }
    }
    pszOut[w] = '\0';
}

void OpenVibeJS_Client_Think()
{
    // Keep the OpenVibe HTML menu covering the stock GameUI whenever we are
    // out of a level (runs regardless of runtime connectivity).
    OpenVibe_MenuKeepAlive();

    g_ClientIPC.Poll();

    if ( !g_ClientIPC.IsConnected() )
        return;

    OVClient_TrySendLocalPlayer();

    // 10Hz think to the client runtime (mirrors the server bridge).
    static float s_flNextThink = 0.0f;
    if ( gpGlobals && gpGlobals->curtime >= s_flNextThink )
    {
        s_flNextThink = gpGlobals->curtime + 0.1f;
        g_ClientIPC.SendLine( "{\"t\":\"think\"}" );
    }

    // Mirror engine console lines into the runtime's log stream so the GUI
    // console shows engine output in every host (launcher included).
    static int64 s_nConsoleCursor = 0;
    char szLine[480];
    int nSent = 0;
    while ( nSent < 10 && OpenVibe_DrainConsoleLine( &s_nConsoleCursor, szLine, sizeof( szLine ) ) )
    {
        char szEsc[960];
        OVClient_JSONEscape( szEsc, sizeof( szEsc ), szLine );
        char szMsg[1100];
        Q_snprintf( szMsg, sizeof( szMsg ), "{\"t\":\"conline\",\"line\":\"%s\"}", szEsc );
        g_ClientIPC.SendLine( szMsg );
        ++nSent;
    }
}

static void OV_ClientJSStatus_f()
{
    Msg( "[OV JS/client] enabled=%d connected=%d port=%d mode=%s\n",
        ov_client_js_enabled.GetBool() ? 1 : 0,
        g_ClientIPC.IsConnected() ? 1 : 0,
        ov_client_js_port.GetInt(), ov_client_mode.GetString() );
}
static ConCommand ov_client_js_status( "ov_client_js_status", OV_ClientJSStatus_f,
    "Print OpenVibe client Node runtime bridge status.", FCVAR_CLIENTDLL );

static void OV_ClientJSReconnect_f()
{
    OpenVibeJS_Client_Shutdown();
    OpenVibeJS_Client_Init();
}
static ConCommand ov_client_js_reconnect( "ov_client_js_reconnect", OV_ClientJSReconnect_f,
    "Reconnect the OpenVibe client Node runtime bridge.", FCVAR_CLIENTDLL );

// ---- js_run_cl / js_openscript_cl — gated by the replicated sv_allowcsjs ----
// sv_allowcsjs (GMod's sv_allowcslua) is registered server-side with
// FCVAR_REPLICATED; read it through the cvar system so the server's value
// applies. Unknown (not connected / not registered) counts as allowed —
// the dev default is 1.
static bool OVClient_CSJSAllowed()
{
    const ConVar *pAllow = g_pCVar ? g_pCVar->FindVar( "sv_allowcsjs" ) : NULL;
    if ( pAllow && !pAllow->GetBool() )
    {
        Warning( "[OV JS/client] blocked: server has sv_allowcsjs 0\n" );
        return false;
    }
    return true;
}

static void OV_JSRunCl_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: js_run_cl <code>\n" );
        return;
    }

    if ( !OVClient_CSJSAllowed() )
        return;

    if ( !g_ClientIPC.IsConnected() )
    {
        Warning( "[OV JS/client] runtime not connected; js_run_cl ignored\n" );
        return;
    }

    char out[4096] = "{\"t\":\"eval\",\"code\":\"";
    OVJSON_AppendEscaped( out, sizeof( out ), args.ArgS() );
    Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
    g_ClientIPC.SendLine( out );
}
static ConCommand js_run_cl( "js_run_cl", OV_JSRunCl_f,
    "Run JavaScript in the client realm: js_run_cl <code>. Gated by sv_allowcsjs.", FCVAR_CLIENTDLL );

static void OV_JSOpenScriptCl_f( const CCommand &args )
{
    if ( args.ArgC() < 2 )
    {
        Msg( "Usage: js_openscript_cl <path relative to js/>\n" );
        return;
    }

    if ( !OVClient_CSJSAllowed() )
        return;

    if ( !g_ClientIPC.IsConnected() )
    {
        Warning( "[OV JS/client] runtime not connected; js_openscript_cl ignored\n" );
        return;
    }

    char out[1024] = "{\"t\":\"openscript\",\"path\":\"";
    OVJSON_AppendEscaped( out, sizeof( out ), args[1] );
    Q_strncat( out, "\"}", sizeof( out ), COPY_ALL_CHARACTERS );
    g_ClientIPC.SendLine( out );
}
static ConCommand js_openscript_cl( "js_openscript_cl", OV_JSOpenScriptCl_f,
    "Run a script file in the client realm: js_openscript_cl <path relative to js/>. Gated by sv_allowcsjs.", FCVAR_CLIENTDLL );

// Drives the bridge: hook OVNet, connect at boot AND on level enter, poll
// each frame. Connecting at boot means the GUI console's client realm works
// from the main menu, not just in-game.
class COpenVibeClientJSSystem : public CAutoGameSystemPerFrame
{
public:
    COpenVibeClientJSSystem() : CAutoGameSystemPerFrame( "COpenVibeClientJSSystem" ) {}
    bool Init() OVERRIDE { usermessages->HookMessage( "OVNet", __MsgFunc_OVNet ); return true; }
    void PostInit() OVERRIDE { OpenVibeJS_Client_Init(); }
    void LevelInitPostEntity() OVERRIDE { OpenVibeJS_Client_Shutdown(); OpenVibeJS_Client_Init(); }
    // Reconnect (rather than just close) so the bridge stays live at the menu.
    void LevelShutdownPostEntity() OVERRIDE { OpenVibeJS_Client_Shutdown(); OpenVibeJS_Client_Init(); }
    void Update( float ) OVERRIDE { OpenVibeJS_Client_Think(); }
};
static COpenVibeClientJSSystem g_OpenVibeClientJSSystem;
