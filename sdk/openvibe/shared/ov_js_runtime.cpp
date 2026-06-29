#include "cbase.h"
#include "ov_js_runtime.h"
#include "filesystem.h"

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

bool COpenVibeJSRuntime::Init(bool bServerRealm, const char *pszMode, const char *pszRootDir)
{
    Shutdown();

    m_bServerRealm = bServerRealm;
    Q_strncpy(m_szMode, pszMode ? pszMode : "hub", sizeof(m_szMode));
    Q_strncpy(m_szRootDir, pszRootDir ? pszRootDir : "js", sizeof(m_szRootDir));

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

    // TODO: OV_RegisterNativeBindings(m_pCtx, this);

    return LoadCoreFiles() && LoadGamemode();
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
        JS_EVAL_TYPE_MODULE
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
    if (!pszPath || !pszPath[0])
        return false;

    FileHandle_t file = filesystem->Open(pszPath, "rb", "MOD");
    if (!file)
    {
        Warning("[OV JS] Could not open %s\n", pszPath);
        return false;
    }

    const int size = filesystem->Size(file);
    if (size <= 0 || size > 512 * 1024)
    {
        filesystem->Close(file);
        Warning("[OV JS] Refusing script %s size=%d\n", pszPath, size);
        return false;
    }

    CUtlVector<char> buffer;
    buffer.SetSize(size + 1);

    filesystem->Read(buffer.Base(), size, file);
    filesystem->Close(file);

    buffer[size] = '\0';

    return Eval(buffer.Base(), pszPath);
}

bool COpenVibeJSRuntime::LoadCoreFiles()
{
    if (!LoadFile("js/core/hook.js"))
        return false;

    if (!LoadFile("js/core/gamemode.js"))
        return false;

    if (!LoadFile("js/bridge.js"))
        return false;

    return true;
}

bool COpenVibeJSRuntime::LoadGamemode()
{
    char path[256];

    Q_snprintf(path, sizeof(path), "js/gamemodes/base/shared.js");
    LoadFile(path);

    Q_snprintf(path, sizeof(path), "js/gamemodes/%s/shared.js", m_szMode);
    LoadFile(path);

    Q_snprintf(
        path,
        sizeof(path),
        "js/gamemodes/%s/%s.js",
        m_szMode,
        m_bServerRealm ? "server" : "client"
    );

    return LoadFile(path);
}

JSValue COpenVibeJSRuntime::CallHook(const char *pszHookName, int argc, JSValueConst *argv)
{
    if (!m_pCtx)
        return JS_UNDEFINED;

    JSValue global = JS_GetGlobalObject(m_pCtx);
    JSValue gamemode = JS_GetPropertyStr(m_pCtx, global, "gamemode");
    JSValue call = JS_GetPropertyStr(m_pCtx, gamemode, "call");

    JSValue hookName = JS_NewString(m_pCtx, pszHookName);

    CUtlVector<JSValueConst> args;
    args.AddToTail(hookName);
    for (int i = 0; i < argc; ++i)
        args.AddToTail(argv[i]);

    JSValue result = JS_Call(
        m_pCtx,
        call,
        gamemode,
        args.Count(),
        args.Base()
    );

    JS_FreeValue(m_pCtx, hookName);
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

void COpenVibeJSRuntime::PrintException(const char *pszWhere)
{
    JSValue exception = JS_GetException(m_pCtx);
    const char *pszError = JS_ToCString(m_pCtx, exception);

    Warning("[OV JS] Exception in %s: %s\n", pszWhere ? pszWhere : "<unknown>", pszError ? pszError : "<null>");

    if (pszError)
        JS_FreeCString(m_pCtx, pszError);

    JS_FreeValue(m_pCtx, exception);
}
