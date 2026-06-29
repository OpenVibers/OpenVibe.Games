#pragma once

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

private:
    void PrintException(const char *pszWhere);
    bool LoadCoreFiles();
    bool LoadGamemode();

    JSRuntime *m_pRuntime = nullptr;
    JSContext *m_pCtx = nullptr;
    bool m_bServerRealm = false;
    char m_szMode[64]{};
};
