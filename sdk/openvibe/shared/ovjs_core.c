/* ovjs_core.c — host-agnostic OpenVibe JavaScript core. Compiled AS C so it can
 * include QuickJS's C headers cleanly (see ovjs_core.h for the why). */
#include "ovjs_core.h"
#include "third_party/quickjs/quickjs.h"

#include <stdlib.h>
#include <string.h>

struct OVJSCore
{
    JSRuntime      *rt;
    JSContext      *ctx;
    const OVJSHost *host;
    int             isServer;
    char            mode[64];
};

/* The active core is stored as the context opaque so bindings can reach host. */
static OVJSCore *OVJS_FromCtx(JSContext *ctx)
{
    return (OVJSCore *)JS_GetContextOpaque(ctx);
}

/* Release a buffer the host allocated (readFile/listDir). Must use the host's
 * allocator, never the core's free(): on Windows the glue and this core can be
 * built against different C runtimes, and freeing across CRTs crashes. */
static void OVJS_HostFree(const OVJSHost *host, void *p)
{
    if (!p) return;
    if (host && host->freeMem) host->freeMem(p);
    /* else: leak rather than risk a cross-CRT free() crash. */
}

/* ------------------------------------------------------------------ */
/* OV.* native bindings — thin shims over the host callbacks.          */
/* ------------------------------------------------------------------ */
static JSValue ov_log(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc >= 1 && c && c->host && c->host->log) {
        const char *s = JS_ToCString(ctx, argv[0]);
        if (s) { c->host->log(s); JS_FreeCString(ctx, s); }
    }
    return JS_UNDEFINED;
}
static JSValue ov_warn(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc >= 1 && c && c->host && c->host->warn) {
        const char *s = JS_ToCString(ctx, argv[0]);
        if (s) { c->host->warn(s); JS_FreeCString(ctx, s); }
    }
    return JS_UNDEFINED;
}
static JSValue ov_error(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc >= 1 && c && c->host && c->host->error) {
        const char *s = JS_ToCString(ctx, argv[0]);
        if (s) { c->host->error(s); JS_FreeCString(ctx, s); }
    }
    return JS_UNDEFINED;
}
static JSValue ov_isServer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    return JS_NewBool(ctx, c ? c->isServer : 0);
}
static JSValue ov_getMode(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    return JS_NewString(ctx, c ? c->mode : "");
}
static JSValue ov_getMapName(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    const char *m = (c && c->host && c->host->getMapName) ? c->host->getMapName() : "";
    return JS_NewString(ctx, m ? m : "");
}
static JSValue ov_time(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    double v = (c && c->host && c->host->getTime) ? c->host->getTime() : 0.0;
    return JS_NewFloat64(ctx, v);
}
static JSValue ov_readFile(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc < 1 || !c || !c->host || !c->host->readFile) return JS_NULL;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_NULL;
    char *buf = c->host->readFile(path);
    JS_FreeCString(ctx, path);
    if (!buf) return JS_NULL;
    JSValue out = JS_NewString(ctx, buf);
    OVJS_HostFree(c->host, buf);
    return out;
}
static JSValue ov_fileExists(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc < 1 || !c || !c->host || !c->host->fileExists) return JS_FALSE;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_FALSE;
    int ok = c->host->fileExists(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}
static JSValue ov_listDir(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    JSValue arr = JS_NewArray(ctx);
    if (argc < 1 || !c || !c->host || !c->host->listDir) return arr;
    const char *dir = JS_ToCString(ctx, argv[0]);
    const char *wc  = (argc >= 2) ? JS_ToCString(ctx, argv[1]) : NULL;
    if (dir) {
        char *joined = c->host->listDir(dir, (wc && wc[0]) ? wc : "*");
        if (joined) {
            uint32_t idx = 0;
            char *p = joined, *start = joined;
            for (;; ++p) {
                if (*p == '\n' || *p == '\0') {
                    if (p > start) {
                        JS_SetPropertyUint32(ctx, arr, idx++,
                            JS_NewStringLen(ctx, start, (size_t)(p - start)));
                    }
                    if (*p == '\0') break;
                    start = p + 1;
                }
            }
            OVJS_HostFree(c->host, joined);
        }
    }
    if (dir) JS_FreeCString(ctx, dir);
    if (wc)  JS_FreeCString(ctx, wc);
    return arr;
}
static JSValue ov_broadcast(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    /* Server-only chat broadcast is handled by the server bindings; on the
     * client this is an inert stub so shared JS doesn't throw. */
    return JS_UNDEFINED;
}
static JSValue ov_serverCommand(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    return JS_UNDEFINED;
}
static JSValue ov_netSendToServer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc < 2 || !c || !c->host || !c->host->netSendToServer) return JS_UNDEFINED;
    const char *name = JS_ToCString(ctx, argv[0]);
    const char *pl   = JS_ToCString(ctx, argv[1]);
    if (name && pl) c->host->netSendToServer(name, pl);
    if (name) JS_FreeCString(ctx, name);
    if (pl)   JS_FreeCString(ctx, pl);
    return JS_UNDEFINED;
}
static JSValue ov_netEmit(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    OVJSCore *c = OVJS_FromCtx(ctx);
    if (argc < 3 || !c || !c->host || !c->host->netEmit) return JS_UNDEFINED;
    const char *ids  = JS_ToCString(ctx, argv[0]);
    const char *name = JS_ToCString(ctx, argv[1]);
    const char *pl   = JS_ToCString(ctx, argv[2]);
    if (ids && name && pl) c->host->netEmit(ids, name, pl);
    if (ids)  JS_FreeCString(ctx, ids);
    if (name) JS_FreeCString(ctx, name);
    if (pl)   JS_FreeCString(ctx, pl);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry ov_funcs[] = {
    JS_CFUNC_DEF("log", 1, ov_log),
    JS_CFUNC_DEF("warn", 1, ov_warn),
    JS_CFUNC_DEF("error", 1, ov_error),
    JS_CFUNC_DEF("isServer", 0, ov_isServer),
    JS_CFUNC_DEF("getMode", 0, ov_getMode),
    JS_CFUNC_DEF("getMapName", 0, ov_getMapName),
    JS_CFUNC_DEF("time", 0, ov_time),
    JS_CFUNC_DEF("readFile", 1, ov_readFile),
    JS_CFUNC_DEF("fileExists", 1, ov_fileExists),
    JS_CFUNC_DEF("listDir", 2, ov_listDir),
    JS_CFUNC_DEF("broadcast", 1, ov_broadcast),
    JS_CFUNC_DEF("serverCommand", 1, ov_serverCommand),
    JS_CFUNC_DEF("netSendToServer", 2, ov_netSendToServer),
    JS_CFUNC_DEF("netEmit", 3, ov_netEmit),
};

static void OVJS_ReportException(OVJSCore *c, const char *where)
{
    JSValue exc = JS_GetException(c->ctx);
    const char *msg = JS_ToCString(c->ctx, exc);
    if (c->host && c->host->error) {
        char buf[1024];
        snprintf(buf, sizeof(buf), "[%s] %s", where ? where : "eval", msg ? msg : "unknown");
        c->host->error(buf);
    }
    if (msg) JS_FreeCString(c->ctx, msg);
    JS_FreeValue(c->ctx, exc);
}

int ovjs_eval(OVJSCore *c, const char *code, const char *filename)
{
    if (!c || !c->ctx || !code) return 0;
    JSValue r = JS_Eval(c->ctx, code, strlen(code),
                        filename ? filename : "<openvibe>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        OVJS_ReportException(c, filename);
        JS_FreeValue(c->ctx, r);
        return 0;
    }
    JS_FreeValue(c->ctx, r);
    return 1;
}

static int OVJS_LoadFile(OVJSCore *c, const char *path)
{
    if (!c->host || !c->host->readFile) return 0;
    if (c->host->log) { char b[256]; snprintf(b, sizeof(b), "core: loading %s", path); c->host->log(b); }
    char *code = c->host->readFile(path);
    if (c->host->log) { char b[256]; snprintf(b, sizeof(b), "core: readFile %s -> %s", path, code ? "ok" : "NULL"); c->host->log(b); }
    if (!code) {
        if (c->host->warn) {
            char buf[512];
            snprintf(buf, sizeof(buf), "core: could not read %s", path);
            c->host->warn(buf);
        }
        return 0;
    }
    if (c->host->log) { char b[256]; snprintf(b, sizeof(b), "core: eval begin %s", path); c->host->log(b); }
    int ok = ovjs_eval(c, code, path);
    if (c->host->log) { char b[256]; snprintf(b, sizeof(b), "core: eval done %s ok=%d", path, ok); c->host->log(b); }
    OVJS_HostFree(c->host, code);
    return ok;
}

static int OVJS_LoadCoreFiles(OVJSCore *c)
{
    if (!OVJS_LoadFile(c, "js/core/hook.js")) return 0;
    if (!OVJS_LoadFile(c, "js/core/gamemode.js")) return 0;
    OVJS_LoadFile(c, "js/bridge.js");      /* bootstraps module/net/addon */
    OVJS_LoadFile(c, "js/core/command.js");
    OVJS_LoadFile(c, "js/core/timer.js");
    return 1;
}

static void OVJS_LoadGamemode(OVJSCore *c)
{
    char path[256];
    OVJS_LoadFile(c, "js/gamemodes/base/server.js"); /* base defines shared GM */
    snprintf(path, sizeof(path), "js/gamemodes/%s/%s.js",
             c->mode, c->isServer ? "server" : "client");
    OVJS_LoadFile(c, path);
}

static void OVJS_RegisterBindings(OVJSCore *c)
{
    JSValue global = JS_GetGlobalObject(c->ctx);
    JSValue ov = JS_NewObject(c->ctx);
    JS_SetPropertyFunctionList(c->ctx, ov, ov_funcs,
        (int)(sizeof(ov_funcs) / sizeof(ov_funcs[0])));
    JS_SetPropertyStr(c->ctx, global, "OV", ov);
    JS_FreeValue(c->ctx, global);
}

static void OVJS_Trace(const OVJSHost *host, const char *msg)
{
    if (host && host->log) host->log(msg);
}

OVJSCore *ovjs_create(const OVJSHost *host, int isServerRealm, const char *mode)
{
    OVJS_Trace(host, "core: ovjs_create begin");
    OVJSCore *c = (OVJSCore *)calloc(1, sizeof(OVJSCore));
    if (!c) return NULL;
    c->host = host;
    c->isServer = isServerRealm ? 1 : 0;
    if (mode && mode[0]) { strncpy(c->mode, mode, sizeof(c->mode) - 1); }
    else { strncpy(c->mode, "hub", sizeof(c->mode) - 1); }

    c->rt = JS_NewRuntime();
    if (!c->rt) { free(c); return NULL; }
    JS_SetMemoryLimit(c->rt, 32 * 1024 * 1024);
    /* Keep well under the OS thread stack (Windows main thread ~1MB): if the JS
     * recursion limit exceeds the real C stack, deep calls overflow and crash
     * the process instead of raising a catchable JS error. */
    JS_SetMaxStackSize(c->rt, 256 * 1024);
    OVJS_Trace(host, "core: runtime created");

    c->ctx = JS_NewContext(c->rt);
    if (!c->ctx) { JS_FreeRuntime(c->rt); free(c); return NULL; }
    JS_SetContextOpaque(c->ctx, c);
    OVJS_Trace(host, "core: context created");

    OVJS_RegisterBindings(c);
    OVJS_Trace(host, "core: bindings registered");
    /* Probe: does ANY eval work? Distinguishes an interpreter miscompile from a
     * hook.js-specific problem. */
    OVJS_Trace(host, "core: probe eval begin");
    ovjs_eval(c, "var __ovjs_probe = 1 + 1;", "<probe>");
    OVJS_Trace(host, "core: probe eval done");
    if (!OVJS_LoadCoreFiles(c)) { OVJS_Trace(host, "core: LoadCoreFiles FAILED"); ovjs_destroy(c); return NULL; }
    OVJS_Trace(host, "core: core files loaded");
    OVJS_LoadGamemode(c);
    OVJS_Trace(host, "core: gamemode loaded — create done");
    return c;
}

void ovjs_destroy(OVJSCore *c)
{
    if (!c) return;
    if (c->ctx) JS_FreeContext(c->ctx);
    if (c->rt)  JS_FreeRuntime(c->rt);
    free(c);
}

/* Fire gamemode.call(hook, args...) — mirrors the server bridge's hook dispatch. */
static void OVJS_FireHookArgv(OVJSCore *c, const char *hook, int argc, JSValueConst *argv)
{
    JSValue global = JS_GetGlobalObject(c->ctx);
    JSValue gamemode = JS_GetPropertyStr(c->ctx, global, "gamemode");
    JSValue call = JS_GetPropertyStr(c->ctx, gamemode, "call");
    if (JS_IsFunction(c->ctx, call)) {
        int n = argc + 1;
        JSValue *args = (JSValue *)malloc(sizeof(JSValue) * (n > 0 ? n : 1));
        args[0] = JS_NewString(c->ctx, hook);
        for (int i = 0; i < argc; ++i) args[i + 1] = argv[i];
        JSValue r = JS_Call(c->ctx, call, gamemode, n, args);
        if (JS_IsException(r)) OVJS_ReportException(c, hook);
        JS_FreeValue(c->ctx, r);
        JS_FreeValue(c->ctx, args[0]);
        free(args);
    }
    JS_FreeValue(c->ctx, call);
    JS_FreeValue(c->ctx, gamemode);
    JS_FreeValue(c->ctx, global);
}

void ovjs_fire_hook(OVJSCore *c, const char *hook)
{
    if (!c || !c->ctx || !hook) return;
    OVJS_FireHookArgv(c, hook, 0, NULL);
}

void ovjs_fire_hook_s(OVJSCore *c, const char *hook,
                      const char *a, const char *b, const char *d)
{
    if (!c || !c->ctx || !hook) return;
    JSValue argv[3];
    int argc = 0;
    if (a) { argv[argc++] = JS_NewString(c->ctx, a); }
    if (a && b) { argv[argc++] = JS_NewString(c->ctx, b); }
    if (a && b && d) { argv[argc++] = JS_NewString(c->ctx, d); }
    OVJS_FireHookArgv(c, hook, argc, argv);
    for (int i = 0; i < argc; ++i) JS_FreeValue(c->ctx, argv[i]);
}
