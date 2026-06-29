#pragma once

// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)

typedef void JSContext;
class COpenVibeJSRuntime;
void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime);
#else
#include "openvibe/third_party/quickjs/quickjs.h"

class COpenVibeJSRuntime;

void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime);
#endif
