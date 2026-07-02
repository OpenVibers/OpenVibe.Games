#include "cbase.h"
#include "openvibe_js_client.h"

// Client realm bridge to the OpenVibe Node.js runtime. The client no longer
// embeds a JS engine (that crashed under clang-cl); instead this forwards engine
// events to ov-runtime.js over a local TCP socket and applies the commands it
// sends back. Client-side JS/npm/hooks run in real Node; UI runs in the HTML
// panel. This is a thin, crash-proof bridge.
#include "openvibe/ov_ipc.h"
#include "usermessages.h"
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

// ---- lifecycle ----
void OpenVibeJS_Client_Init()
{
    if ( g_bClientBridgeStarted ) return;
    g_bClientBridgeStarted = true;
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

void OpenVibeJS_Client_Think()
{
    g_ClientIPC.Poll();
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

// Drives the bridge: hook OVNet, connect on level enter, poll each frame.
class COpenVibeClientJSSystem : public CAutoGameSystemPerFrame
{
public:
    COpenVibeClientJSSystem() : CAutoGameSystemPerFrame( "COpenVibeClientJSSystem" ) {}
    bool Init() OVERRIDE { usermessages->HookMessage( "OVNet", __MsgFunc_OVNet ); return true; }
    void LevelInitPostEntity() OVERRIDE { OpenVibeJS_Client_Shutdown(); OpenVibeJS_Client_Init(); }
    void LevelShutdownPostEntity() OVERRIDE { OpenVibeJS_Client_Shutdown(); }
    void Update( float ) OVERRIDE { OpenVibeJS_Client_Think(); }
};
static COpenVibeClientJSSystem g_OpenVibeClientJSSystem;
