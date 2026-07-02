#include "cbase.h"
#include "openvibe_js_client.h"

// Host-side glue for the client JavaScript runtime. Deliberately includes only
// the pure C-ABI core header (never quickjs.h), so MSVC cl.exe never parses
// QuickJS's C headers in C++ mode. All QuickJS work lives in ovjs_core.c
// (compiled as C / clang-cl on Windows).
#include "openvibe/ovjs_core.h"
#include "filesystem.h"
#include "usermessages.h"
#include <stdlib.h>
#include <string.h>

#include "tier0/memdbgon.h"

static OVJSCore *g_pClientCore = NULL;

static ConVar ov_client_js_enabled(
    "ov_client_js_enabled", "1", FCVAR_CLIENTDLL,
    "Enable the OpenVibe client-side JavaScript runtime." );
static ConVar ov_client_mode(
    "ov_client_mode", "hub", FCVAR_CLIENTDLL,
    "OpenVibe client gamemode realm: hub, prophunt, deathrun, fortwars, traitortown, sandbox." );

// ---------------------------------------------------------------------------
// Host callbacks (C ABI). Source SDK lives entirely on this side.
// ---------------------------------------------------------------------------
static bool OVC_IsSafeModPath( const char *p )
{
    if ( !p || !p[0] ) return false;
    if ( p[0] == '/' || p[0] == '\\' ) return false;
    if ( strstr( p, ".." ) ) return false;
    if ( strstr( p, ":" ) ) return false;
    return true;
}

static void OVC_log( const char *m )  { Msg( "[OV JS/client] %s\n", m ); }
static void OVC_warn( const char *m ) { Warning( "[OV JS/client] %s\n", m ); }
static void OVC_error( const char *m ){ Warning( "[OV JS/client ERROR] %s\n", m ); }

static char *OVC_readFile( const char *path )
{
    if ( !OVC_IsSafeModPath( path ) ) return NULL;
    FileHandle_t f = filesystem->Open( path, "rb", "MOD" );
    if ( !f ) return NULL;
    int size = filesystem->Size( f );
    if ( size < 0 || size > 8 * 1024 * 1024 ) { filesystem->Close( f ); return NULL; }
    char *buf = (char *)malloc( size + 1 );
    if ( !buf ) { filesystem->Close( f ); return NULL; }
    filesystem->Read( buf, size, f );
    filesystem->Close( f );
    buf[size] = '\0';
    return buf;
}

static int OVC_fileExists( const char *path )
{
    return OVC_IsSafeModPath( path )
        && filesystem->FileExists( path, "MOD" )
        && !filesystem->IsDirectory( path, "MOD" ) ? 1 : 0;
}

static char *OVC_listDir( const char *dir, const char *wildcard )
{
    if ( !OVC_IsSafeModPath( dir ) ) return NULL;
    char search[512];
    Q_snprintf( search, sizeof( search ), "%s/%s", dir, ( wildcard && wildcard[0] ) ? wildcard : "*" );

    CUtlString out;
    FileFindHandle_t h;
    const char *name = filesystem->FindFirstEx( search, "MOD", &h );
    bool first = true;
    while ( name )
    {
        if ( Q_strcmp( name, "." ) != 0 && Q_strcmp( name, ".." ) != 0 )
        {
            if ( !first ) out += "\n";
            out += name;
            first = false;
        }
        name = filesystem->FindNext( h );
    }
    filesystem->FindClose( h );

    const char *s = out.Get();
    if ( !s || !s[0] ) return NULL;
    size_t len = strlen( s );
    char *buf = (char *)malloc( len + 1 );
    if ( !buf ) return NULL;
    memcpy( buf, s, len + 1 );
    return buf;
}

static int OVC_isServer( void ) { return 0; }
static const char *OVC_getMode( void ) { return ov_client_mode.GetString(); }

static const char *OVC_getMapName( void )
{
    static char s_map[128];
    const char *lvl = engine ? engine->GetLevelName() : "";
    Q_strncpy( s_map, lvl ? lvl : "", sizeof( s_map ) );
    return s_map;
}

static double OVC_getTime( void ) { return gpGlobals ? gpGlobals->curtime : 0.0; }

static void OVC_netSendToServer( const char *name, const char *payloadB64 )
{
    if ( !name || !payloadB64 || !engine ) return;
    char cmd[16384];
    Q_snprintf( cmd, sizeof( cmd ), "ov_net %s %s\n", name, payloadB64 );
    engine->ClientCmd_Unrestricted( cmd );
}

static void OVC_netEmit( const char *, const char *, const char * )
{
    // server->client emit is server-only; inert on the client.
}

static OVJSHost g_ClientHost =
{
    OVC_log, OVC_warn, OVC_error,
    OVC_readFile, OVC_fileExists, OVC_listDir,
    OVC_isServer, OVC_getMode, OVC_getMapName, OVC_getTime,
    OVC_netSendToServer, OVC_netEmit
};

// ---------------------------------------------------------------------------
// server -> client: OVNet usermessage -> OVNetReceive hook into client JS.
// ---------------------------------------------------------------------------
void __MsgFunc_OVNet( bf_read &msg )
{
    if ( !g_pClientCore ) return;
    char name[128];
    char payload[16384];
    msg.ReadString( name, sizeof( name ) );
    msg.ReadString( payload, sizeof( payload ) );
    // ply arg is null on the client (server->client has no sending player).
    ovjs_fire_hook_s( g_pClientCore, "OVNetReceive", name, payload, NULL );
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------
void OpenVibeJS_Client_Init()
{
    if ( g_pClientCore ) return;
    if ( !ov_client_js_enabled.GetBool() )
    {
        Msg( "[OV JS/client] disabled by ov_client_js_enabled=0\n" );
        return;
    }
    g_pClientCore = ovjs_create( &g_ClientHost, 0 /*client*/, ov_client_mode.GetString() );
    if ( g_pClientCore )
    {
        Msg( "[OV JS/client] client runtime initialized for mode '%s'\n", ov_client_mode.GetString() );
        ovjs_fire_hook( g_pClientCore, "Initialize" );
    }
    else
    {
        Warning( "[OV JS/client] client runtime failed to initialize\n" );
    }
}

void OpenVibeJS_Client_Shutdown()
{
    if ( g_pClientCore )
    {
        ovjs_fire_hook( g_pClientCore, "Shutdown" );
        ovjs_destroy( g_pClientCore );
        g_pClientCore = NULL;
    }
}

void OpenVibeJS_Client_Think()
{
    if ( g_pClientCore )
        ovjs_fire_hook( g_pClientCore, "Think" );
}

// ---------------------------------------------------------------------------
// Client concommands.
// ---------------------------------------------------------------------------
static void OV_ClientJSStatus_f()
{
    Msg( "[OV JS/client] enabled=%d running=%d mode=%s\n",
        ov_client_js_enabled.GetBool() ? 1 : 0,
        g_pClientCore ? 1 : 0,
        ov_client_mode.GetString() );
}
static ConCommand ov_client_js_status( "ov_client_js_status", OV_ClientJSStatus_f,
    "Print OpenVibe client JavaScript runtime status.", FCVAR_CLIENTDLL );

static void OV_ClientJSReload_f()
{
    OpenVibeJS_Client_Shutdown();
    OpenVibeJS_Client_Init();
    Msg( "[OV JS/client] reloaded\n" );
}
static ConCommand ov_client_js_reload( "ov_client_js_reload", OV_ClientJSReload_f,
    "Reload the OpenVibe client JavaScript runtime.", FCVAR_CLIENTDLL );

// Drives the runtime: hook OVNet at load, start on level enter, Think per frame.
class COpenVibeClientJSSystem : public CAutoGameSystemPerFrame
{
public:
    COpenVibeClientJSSystem() : CAutoGameSystemPerFrame( "COpenVibeClientJSSystem" ) {}
    bool Init() OVERRIDE
    {
        usermessages->HookMessage( "OVNet", __MsgFunc_OVNet );
        return true;
    }
    void LevelInitPostEntity() OVERRIDE
    {
        OpenVibeJS_Client_Shutdown();
        OpenVibeJS_Client_Init();
    }
    void LevelShutdownPostEntity() OVERRIDE
    {
        OpenVibeJS_Client_Shutdown();
    }
    void Update( float frametime ) OVERRIDE
    {
        OpenVibeJS_Client_Think();
    }
};
static COpenVibeClientJSSystem g_OpenVibeClientJSSystem;
