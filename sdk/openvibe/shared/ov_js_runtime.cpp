#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
#include "ov_js_runtime.h"

#include "tier0/memdbgon.h"

COpenVibeJSRuntime::COpenVibeJSRuntime() {}
COpenVibeJSRuntime::~COpenVibeJSRuntime() { Shutdown(); }

bool COpenVibeJSRuntime::Init(bool bServerRealm, const char *pszMode)
{
    m_bServerRealm = bServerRealm;
    Q_strncpy(m_szMode, pszMode && pszMode[0] ? pszMode : "hub", sizeof(m_szMode));
    Msg("[OV JS] Windows server CI stub runtime active for mode '%s'\n", m_szMode);
    return false;
}

void COpenVibeJSRuntime::Shutdown() {}
bool COpenVibeJSRuntime::LoadFile(const char *pszPath) { return false; }
bool COpenVibeJSRuntime::Eval(const char *pszCode, const char *pszFilename) { return false; }
JSValue COpenVibeJSRuntime::CallHookRaw(const char *pszHookName, int argc, JSValueConst *argv) { return JS_UNDEFINED; }
void COpenVibeJSRuntime::CallHookVoid(const char *pszHookName, int argc, JSValueConst *argv) {}
bool COpenVibeJSRuntime::CallHookBool(const char *pszHookName, bool *pOut, int argc, JSValueConst *argv)
{
    if (pOut) *pOut = false;
    return false;
}
#else
#include "filesystem.h"
#include "ov_js_runtime.h"
#include "ov_js_bindings.h"

#include "tier0/memdbgon.h"

static int OV_JSInterruptHandler(JSRuntime *rt, void *opaque)
{
    return 0;
}

COpenVibeJSRuntime::COpenVibeJSRuntime() {}

COpenVibeJSRuntime::~COpenVibeJSRuntime()
{
    Shutdown();
}

bool COpenVibeJSRuntime::Init(bool bServerRealm, const char *pszMode)
{
    Shutdown();

    m_bServerRealm = bServerRealm;
    Q_strncpy(m_szMode, pszMode && pszMode[0] ? pszMode : "hub", sizeof(m_szMode));

    m_pRuntime = JS_NewRuntime();
    if (!m_pRuntime)
        return false;

    JS_SetMemoryLimit(m_pRuntime, 16 * 1024 * 1024);
    JS_SetMaxStackSize(m_pRuntime, 512 * 1024);
    JS_SetInterruptHandler(m_pRuntime, OV_JSInterruptHandler, this);

    m_pCtx = JS_NewContext(m_pRuntime);
    if (!m_pCtx)
    {
        Shutdown();
        return false;
    }

    OVJS_RegisterNativeBindings(m_pCtx, this);

    if (!LoadCoreFiles())
        return false;

    if (!LoadGamemode())
        return false;

    return true;
}

void COpenVibeJSRuntime::Shutdown()
{
    if (m_pCtx)
    {
        JS_FreeContext(m_pCtx);
        m_pCtx = nullptr;
    }

    if (m_pRuntime)
    {
        JS_FreeRuntime(m_pRuntime);
        m_pRuntime = nullptr;
    }
}

bool COpenVibeJSRuntime::Eval(const char *pszCode, const char *pszFilename)
{
    if (!m_pCtx || !pszCode)
        return false;

    JSValue result = JS_Eval(
        m_pCtx,
        pszCode,
        Q_strlen(pszCode),
        pszFilename ? pszFilename : "<openvibe>",
        JS_EVAL_TYPE_GLOBAL
    );

    if (JS_IsException(result))
    {
        PrintException(pszFilename);
        JS_FreeValue(m_pCtx, result);
        return false;
    }

    JS_FreeValue(m_pCtx, result);
    return true;
}

bool COpenVibeJSRuntime::LoadFile(const char *pszPath)
{
    FileHandle_t file = filesystem->Open(pszPath, "rb", "MOD");
    if (!file)
    {
        Warning("[OV JS] Could not open %s\n", pszPath);
        return false;
    }

    int size = filesystem->Size(file);
    if (size <= 0 || size > 1024 * 1024)
    {
        filesystem->Close(file);
        Warning("[OV JS] Refusing script %s size=%d\n", pszPath, size);
        return false;
    }

    char *buffer = new char[size + 1];
    filesystem->Read(buffer, size, file);
    filesystem->Close(file);
    buffer[size] = '\0';

    bool ok = Eval(buffer, pszPath);
    delete[] buffer;

    return ok;
}

bool COpenVibeJSRuntime::LoadCoreFiles()
{
    if (!LoadFile("js/core/hook.js"))
        return false;

    if (!LoadFile("js/core/gamemode.js"))
        return false;

    if (!LoadFile("js/bridge.js"))
        return false;

    if (!LoadFile("js/core/command.js"))
        return false;

    if (!LoadFile("js/core/timer.js"))
        return false;

    return true;
}

bool COpenVibeJSRuntime::LoadGamemode()
{
    LoadFile("js/gamemodes/base/server.js");

    char path[256];
    Q_snprintf(path, sizeof(path), "js/gamemodes/%s/%s.js", m_szMode, m_bServerRealm ? "server" : "client");

    return LoadFile(path);
}

JSValue COpenVibeJSRuntime::CallHookRaw(const char *pszHookName, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return JS_UNDEFINED;

    JSValue global = JS_GetGlobalObject(m_pCtx);
    JSValue gamemode = JS_GetPropertyStr(m_pCtx, global, "gamemode");
    JSValue call = JS_GetPropertyStr(m_pCtx, gamemode, "call");

    if (!JS_IsFunction(m_pCtx, call))
    {
        JS_FreeValue(m_pCtx, call);
        JS_FreeValue(m_pCtx, gamemode);
        JS_FreeValue(m_pCtx, global);
        return JS_UNDEFINED;
    }

    JSValue *callArgs = new JSValue[argc + 1];
    callArgs[0] = JS_NewString(m_pCtx, pszHookName);

    for (int i = 0; i < argc; ++i)
        callArgs[i + 1] = JS_DupValue(m_pCtx, argv[i]);

    JSValue result = JS_Call(m_pCtx, call, gamemode, argc + 1, callArgs);

    for (int i = 0; i < argc + 1; ++i)
        JS_FreeValue(m_pCtx, callArgs[i]);

    delete[] callArgs;

    JS_FreeValue(m_pCtx, call);
    JS_FreeValue(m_pCtx, gamemode);
    JS_FreeValue(m_pCtx, global);

    if (JS_IsException(result))
    {
        PrintException(pszHookName);
        JS_FreeValue(m_pCtx, result);
        return JS_UNDEFINED;
    }

    return result;
}

void COpenVibeJSRuntime::CallHookVoid(const char *pszHookName, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return;

    JSValue result = CallHookRaw(pszHookName, argc, argv);
    JS_FreeValue(m_pCtx, result);
}

bool COpenVibeJSRuntime::CallHookBool(const char *pszHookName, bool *pOut, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return false;

    JSValue result = CallHookRaw(pszHookName, argc, argv);

    if (JS_IsUndefined(result))
    {
        JS_FreeValue(m_pCtx, result);
        return false;
    }

    if (pOut)
        *pOut = JS_ToBool(m_pCtx, result) != 0;

    JS_FreeValue(m_pCtx, result);
    return true;
}

void COpenVibeJSRuntime::PrintException(const char *pszWhere)
{
    JSValue exception = JS_GetException(m_pCtx);
    const char *pszError = JS_ToCString(m_pCtx, exception);

    Warning("[OV JS] Exception in %s: %s\n", pszWhere ? pszWhere : "<unknown>", pszError ? pszError : "<null>");

    if (pszError)
        JS_FreeCString(m_pCtx, pszError);

    JS_FreeValue(m_pCtx, exception);
}
#endif
