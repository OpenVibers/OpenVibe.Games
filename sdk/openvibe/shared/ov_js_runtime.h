#pragma once

#include "quickjs.h"

class CBasePlayer;

class COpenVibeJSRuntime
{
public:
    COpenVibeJSRuntime();
    ~COpenVibeJSRuntime();

    bool Init(bool bServerRealm, const char *pszMode, const char *pszRootDir);
    void Shutdown();

    bool LoadFile(const char *pszPath);
    bool Eval(const char *pszCode, const char *pszFilename);

    JSValue CallHook(const char *pszHookName, int argc = 0, JSValueConst *argv = nullptr);

    JSContext *Context() { return m_pCtx; }

private:
    void PrintException(const char *pszWhere);
    bool LoadCoreFiles();
    bool LoadGamemode();

    JSRuntime *m_pRuntime = nullptr;
    JSContext *m_pCtx = nullptr;

    bool m_bServerRealm = false;
    char m_szMode[64]{};
    char m_szRootDir[512]{};
};
