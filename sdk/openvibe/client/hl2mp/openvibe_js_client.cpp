#include "cbase.h"
#include "openvibe_js_client.h"

// The client always uses the real QuickJS runtime (the Windows *server* stub
// guard keys on GAME_DLL, which is not defined in the client build).
#include "filesystem.h"
#include "openvibe/ov_js_runtime.h"
#include "openvibe/ov_js_bindings.h"
#include "usermessages.h"
#include <ctype.h>

#include "tier0/memdbgon.h"

// ---------------------------------------------------------------------------
// Client JS runtime instance + mode.
// ---------------------------------------------------------------------------
static COpenVibeJSRuntime g_OVClientJS;
static bool g_OVClientJSStarted = false;

static ConVar ov_client_js_enabled(
    "ov_client_js_enabled", "1", FCVAR_CLIENTDLL,
    "Enable the OpenVibe client-side JavaScript runtime." );

// Which gamemode's client.js to load. The server pushes its mode to the client
// (ov_client_mode <mode>; then the runtime reloads), defaulting to hub.
static ConVar ov_client_mode(
    "ov_client_mode", "hub", FCVAR_CLIENTDLL,
    "OpenVibe client gamemode realm: hub, prophunt, deathrun, fortwars, traitortown, sandbox." );

static bool OpenVibeClientJS_IsRunning()
{
    return ov_client_js_enabled.GetBool() && g_OVClientJS.Context() != nullptr;
}

// ---------------------------------------------------------------------------
// Client OV.* native bindings. Client-safe subset (no server player list /
// ServerCommand). File I/O + logging + net + realm info, matching the server
// bridge so the shared core JS (require/net/addon/timer/hook) runs unchanged.
// ---------------------------------------------------------------------------
static bool OVCJS_IsSafeModPath( const char *pszPath )
{
    if ( !pszPath || !pszPath[0] ) return false;
    if ( pszPath[0] == '/' || pszPath[0] == '\\' ) return false;
    if ( Q_strstr( pszPath, ".." ) ) return false;
    if ( Q_strstr( pszPath, ":" ) ) return false;
    return true;
}

static JSValue OVCJS_log( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 1 ) return JS_UNDEFINED;
    const char *msg = JS_ToCString( ctx, argv[0] );
    if ( msg ) { Msg( "[OV JS/client] %s\n", msg ); JS_FreeCString( ctx, msg ); }
    return JS_UNDEFINED;
}

static JSValue OVCJS_warn( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 1 ) return JS_UNDEFINED;
    const char *msg = JS_ToCString( ctx, argv[0] );
    if ( msg ) { Warning( "[OV JS/client] %s\n", msg ); JS_FreeCString( ctx, msg ); }
    return JS_UNDEFINED;
}

static JSValue OVCJS_error( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 1 ) return JS_UNDEFINED;
    const char *msg = JS_ToCString( ctx, argv[0] );
    if ( msg ) { Warning( "[OV JS/client ERROR] %s\n", msg ); JS_FreeCString( ctx, msg ); }
    return JS_UNDEFINED;
}

static JSValue OVCJS_isServer( JSContext *ctx, JSValueConst, int, JSValueConst * )
{
    return JS_FALSE; // client realm
}

static JSValue OVCJS_getMode( JSContext *ctx, JSValueConst, int, JSValueConst * )
{
    return JS_NewString( ctx, g_OVClientJS.GetMode() );
}

static JSValue OVCJS_getMapName( JSContext *ctx, JSValueConst, int, JSValueConst * )
{
    return JS_NewString( ctx, engine ? engine->GetLevelName() : "" );
}

static JSValue OVCJS_time( JSContext *ctx, JSValueConst, int, JSValueConst * )
{
    return JS_NewFloat64( ctx, gpGlobals ? gpGlobals->curtime : 0.0 );
}

static JSValue OVCJS_readFile( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 1 ) return JS_NULL;
    const char *path = JS_ToCString( ctx, argv[0] );
    if ( !path ) return JS_NULL;

    if ( !OVCJS_IsSafeModPath( path ) )
    {
        Warning( "[OV JS/client] readFile refused unsafe path: %s\n", path );
        JS_FreeCString( ctx, path );
        return JS_NULL;
    }

    FileHandle_t file = filesystem->Open( path, "rb", "MOD" );
    if ( !file ) { JS_FreeCString( ctx, path ); return JS_NULL; }

    int size = filesystem->Size( file );
    if ( size < 0 || size > 8 * 1024 * 1024 )
    {
        filesystem->Close( file );
        JS_FreeCString( ctx, path );
        return JS_NULL;
    }

    char *buffer = new char[size + 1];
    filesystem->Read( buffer, size, file );
    filesystem->Close( file );
    buffer[size] = '\0';

    JSValue out = JS_NewStringLen( ctx, buffer, size );
    delete[] buffer;
    JS_FreeCString( ctx, path );
    return out;
}

static JSValue OVCJS_fileExists( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 1 ) return JS_FALSE;
    const char *path = JS_ToCString( ctx, argv[0] );
    if ( !path ) return JS_FALSE;
    bool exists = OVCJS_IsSafeModPath( path )
        && filesystem->FileExists( path, "MOD" )
        && !filesystem->IsDirectory( path, "MOD" );
    JS_FreeCString( ctx, path );
    return exists ? JS_TRUE : JS_FALSE;
}

static JSValue OVCJS_listDir( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    JSValue arr = JS_NewArray( ctx );
    if ( argc < 1 ) return arr;

    const char *dir = JS_ToCString( ctx, argv[0] );
    if ( !dir ) return arr;

    const char *wildcardArg = ( argc >= 2 && JS_IsString( argv[1] ) ) ? JS_ToCString( ctx, argv[1] ) : nullptr;
    const char *wildcard = ( wildcardArg && wildcardArg[0] ) ? wildcardArg : "*";

    if ( !OVCJS_IsSafeModPath( dir ) )
    {
        if ( wildcardArg ) JS_FreeCString( ctx, wildcardArg );
        JS_FreeCString( ctx, dir );
        return arr;
    }

    char search[512];
    Q_snprintf( search, sizeof( search ), "%s/%s", dir, wildcard );

    FileFindHandle_t findHandle;
    const char *name = filesystem->FindFirstEx( search, "MOD", &findHandle );
    uint32 index = 0;
    while ( name )
    {
        if ( Q_strcmp( name, "." ) != 0 && Q_strcmp( name, ".." ) != 0 )
            JS_SetPropertyUint32( ctx, arr, index++, JS_NewString( ctx, name ) );
        name = filesystem->FindNext( findHandle );
    }
    filesystem->FindClose( findHandle );

    if ( wildcardArg ) JS_FreeCString( ctx, wildcardArg );
    JS_FreeCString( ctx, dir );
    return arr;
}

// client -> server: forward as the ov_net command the server JS dispatches.
static JSValue OVCJS_netSendToServer( JSContext *ctx, JSValueConst, int argc, JSValueConst *argv )
{
    if ( argc < 2 ) return JS_UNDEFINED;
    const char *name = JS_ToCString( ctx, argv[0] );
    const char *payload = JS_ToCString( ctx, argv[1] );
    if ( name && payload && engine )
    {
        char cmd[16384];
        Q_snprintf( cmd, sizeof( cmd ), "ov_net %s %s\n", name, payload );
        engine->ClientCmd_Unrestricted( cmd );
    }
    if ( name ) JS_FreeCString( ctx, name );
    if ( payload ) JS_FreeCString( ctx, payload );
    return JS_UNDEFINED;
}

// broadcast/serverCommand are server-only; provide inert client stubs so shared
// JS that references them doesn't throw on the client.
static JSValue OVCJS_noop( JSContext *ctx, JSValueConst, int, JSValueConst * )
{
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry OVClientFuncs[] =
{
    JS_CFUNC_DEF( "log", 1, OVCJS_log ),
    JS_CFUNC_DEF( "warn", 1, OVCJS_warn ),
    JS_CFUNC_DEF( "error", 1, OVCJS_error ),
    JS_CFUNC_DEF( "isServer", 0, OVCJS_isServer ),
    JS_CFUNC_DEF( "getMode", 0, OVCJS_getMode ),
    JS_CFUNC_DEF( "getMapName", 0, OVCJS_getMapName ),
    JS_CFUNC_DEF( "time", 0, OVCJS_time ),
    JS_CFUNC_DEF( "readFile", 1, OVCJS_readFile ),
    JS_CFUNC_DEF( "fileExists", 1, OVCJS_fileExists ),
    JS_CFUNC_DEF( "listDir", 2, OVCJS_listDir ),
    JS_CFUNC_DEF( "netSendToServer", 2, OVCJS_netSendToServer ),
    JS_CFUNC_DEF( "broadcast", 1, OVCJS_noop ),
    JS_CFUNC_DEF( "serverCommand", 1, OVCJS_noop ),
};

// This is the symbol ov_js_runtime.cpp calls; the client project compiles this
// file instead of the server ov_js_bindings.cpp.
void OVJS_RegisterNativeBindings( JSContext *ctx, COpenVibeJSRuntime * )
{
    JSValue global = JS_GetGlobalObject( ctx );
    JSValue ov = JS_NewObject( ctx );
    JS_SetPropertyFunctionList( ctx, ov, OVClientFuncs, ARRAYSIZE( OVClientFuncs ) );
    JS_SetPropertyStr( ctx, global, "OV", ov );
    JS_FreeValue( ctx, global );
}

// ---------------------------------------------------------------------------
// server -> client: OVNet usermessage -> OVNetReceive hook into client JS.
// ---------------------------------------------------------------------------
void __MsgFunc_OVNet( bf_read &msg )
{
    if ( !OpenVibeClientJS_IsRunning() )
        return;

    char name[128];
    char payload[16384];
    msg.ReadString( name, sizeof( name ) );
    msg.ReadString( payload, sizeof( payload ) );

    JSContext *ctx = g_OVClientJS.Context();
    JSValue jsName    = JS_NewString( ctx, name );
    JSValue jsPayload = JS_NewString( ctx, payload );
    JSValue jsPly     = JS_NULL; // server->client has no "sending player"

    JSValueConst argv[] = { jsName, jsPayload, jsPly };
    g_OVClientJS.CallHookVoid( "OVNetReceive", 3, argv );

    JS_FreeValue( ctx, jsName );
    JS_FreeValue( ctx, jsPayload );
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------
void OpenVibeJS_Client_Init()
{
    if ( g_OVClientJSStarted )
        return;
    g_OVClientJSStarted = true;

    if ( !ov_client_js_enabled.GetBool() )
    {
        Msg( "[OV JS/client] disabled by ov_client_js_enabled=0\n" );
        return;
    }

    if ( g_OVClientJS.Init( false /*client realm*/, ov_client_mode.GetString() ) )
    {
        Msg( "[OV JS/client] client runtime initialized for mode '%s'\n", ov_client_mode.GetString() );
        g_OVClientJS.CallHookVoid( "Initialize" );
    }
    else
    {
        Warning( "[OV JS/client] client runtime failed to initialize\n" );
    }
}

void OpenVibeJS_Client_Shutdown()
{
    if ( OpenVibeClientJS_IsRunning() )
        g_OVClientJS.CallHookVoid( "Shutdown" );
    g_OVClientJS.Shutdown();
    g_OVClientJSStarted = false;
}

void OpenVibeJS_Client_Think()
{
    if ( OpenVibeClientJS_IsRunning() )
        g_OVClientJS.CallHookVoid( "Think" );
}

// ---------------------------------------------------------------------------
// Client concommands (mirror the server ones for parity/debugging).
// ---------------------------------------------------------------------------
static void OV_ClientJSStatus_f()
{
    Msg( "[OV JS/client] enabled=%d started=%d running=%d mode=%s\n",
        ov_client_js_enabled.GetBool() ? 1 : 0,
        g_OVClientJSStarted ? 1 : 0,
        OpenVibeClientJS_IsRunning() ? 1 : 0,
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

// Drives the client JS runtime: hooks the OVNet usermessage at load, starts the
// runtime once the level/systems are up, and pumps Think() each frame (for JS
// timers). Self-contained so no external init-call patching is needed.
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
        // (Re)start the runtime when a level is entered so <mode>/client.js and
        // client addons load fresh for the connected server.
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
