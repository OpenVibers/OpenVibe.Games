#pragma once

// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)

// Windows server CI uses a stub JS runtime so server.dll can be produced with
// OpenVibe concommands while QuickJS C/C++ portability is handled separately.
typedef void JSContext;
typedef void JSRuntime;
struct JSValue { void *opaque; };
typedef JSValue JSValueConst;

#define JS_UNDEFINED (JSValue{ nullptr })
#define JS_NULL      (JSValue{ nullptr })

class COpenVibeJSRuntime
{
public:
    COpenVibeJSRuntime();
    ~COpenVibeJSRuntime();

    bool Init(bool bServerRealm, const char *pszMode);
    void Shutdown();

    bool LoadFile(const char *pszPath);
    bool Eval(const char *pszCode, const char *pszFilename);

    JSValue CallHookRaw(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    void CallHookVoid(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    bool CallHookBool(const char *pszHookName, bool *pOut, int argc = 0, JSValueConst *argv = nullptr);

    JSContext *Context() { return nullptr; }
    const char *GetMode() const { return m_szMode; }
    bool IsServerRealm() const { return m_bServerRealm; }

private:
    bool m_bServerRealm = false;
    char m_szMode[64]{};
};
#else
#include "openvibe/third_party/quickjs/quickjs.h"

class COpenVibeJSRuntime
{
public:
    COpenVibeJSRuntime();
    ~COpenVibeJSRuntime();

    bool Init(bool bServerRealm, const char *pszMode);
    void Shutdown();

    bool LoadFile(const char *pszPath);
    bool Eval(const char *pszCode, const char *pszFilename);

    JSValue CallHookRaw(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    void CallHookVoid(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);
    bool CallHookBool(const char *pszHookName, bool *pOut, int argc = 0, JSValueConst *argv = nullptr);

    JSContext *Context() { return m_pCtx; }
    const char *GetMode() const { return m_szMode; }
    bool IsServerRealm() const { return m_bServerRealm; }

private:
    void PrintException(const char *pszWhere);
    bool LoadCoreFiles();
    bool LoadGamemode();

    JSRuntime *m_pRuntime = nullptr;
    JSContext *m_pCtx = nullptr;
    bool m_bServerRealm = false;
    char m_szMode[64]{};
};
#endif
