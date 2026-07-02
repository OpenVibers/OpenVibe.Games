/* ovjs_core.h — host-agnostic OpenVibe JavaScript core (C ABI).
 *
 * This is the boundary that lets the client DLL embed QuickJS on Windows.
 * The core (ovjs_core.c) is compiled AS C, so it may include quickjs.h — whose
 * C99 compound literals / designated initializers are valid in C but rejected by
 * MSVC cl.exe in C++ mode. The Source-SDK glue (openvibe_js_client.cpp) is C++
 * and includes ONLY this pure-C-ABI header, never quickjs.h, so cl.exe never
 * parses QuickJS. The core reaches the engine (logging, files, networking)
 * exclusively through the host callbacks below.
 */
#ifndef OVJS_CORE_H
#define OVJS_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OVJSCore OVJSCore;

/* Callbacks the JS core invokes; implemented by the host (Source SDK glue).
 * String returns marked "(host-owned static)" must remain valid until the next
 * call. readFile/listDir return malloc()'d buffers the CORE frees with free(). */
typedef struct OVJSHost
{
    void (*log)(const char *msg);
    void (*warn)(const char *msg);
    void (*error)(const char *msg);

    /* Returns malloc'd NUL-terminated file contents (core frees), or NULL. */
    char *(*readFile)(const char *path);
    int   (*fileExists)(const char *path);
    /* Returns malloc'd newline-joined entry names (core frees), or NULL. */
    char *(*listDir)(const char *dir, const char *wildcard);

    int          (*isServer)(void);
    const char  *(*getMode)(void);      /* host-owned static */
    const char  *(*getMapName)(void);   /* host-owned static */
    double       (*getTime)(void);

    /* client -> server */
    void (*netSendToServer)(const char *name, const char *payloadB64);
    /* server -> client (idsCsv: comma-separated userIds, "-1" = broadcast) */
    void (*netEmit)(const char *idsCsv, const char *name, const char *payloadB64);
} OVJSHost;

/* Create a runtime, register the OV.* bindings, and load the core JS files plus
 * js/gamemodes/<mode>/(server|client).js. Returns NULL on failure. */
OVJSCore *ovjs_create(const OVJSHost *host, int isServerRealm, const char *mode);
void      ovjs_destroy(OVJSCore *core);

/* Evaluate a script. Returns 1 on success, 0 on error (reported via host->error). */
int ovjs_eval(OVJSCore *core, const char *code, const char *filename);

/* Fire a gamemode/hook by name. The _s variant passes up to three string args
 * (pass NULL to stop early); used for events like OVNetReceive(name,payload). */
void ovjs_fire_hook(OVJSCore *core, const char *hook);
void ovjs_fire_hook_s(OVJSCore *core, const char *hook,
                      const char *a, const char *b, const char *c);

#ifdef __cplusplus
}
#endif

#endif /* OVJS_CORE_H */
