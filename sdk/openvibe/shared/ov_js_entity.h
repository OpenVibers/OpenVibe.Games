#pragma once

// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)

#include "openvibe/ov_js_runtime.h"
JSValue OVJS_entCreate(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv);
JSValue OVJS_entCall(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv);
#else
#include "openvibe/third_party/quickjs/quickjs.h"

// Entity native bindings (server realm only). Registered on the OV global by
// OVJS_RegisterNativeBindings:
//   OV.entCreate(className)              -> {entIndex} | null
//   OV.entCall(entIndex, method, args[]) -> method-dependent | undefined
JSValue OVJS_entCreate(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv);
JSValue OVJS_entCall(JSContext *ctx, JSValueConst thisVal, int argc, JSValueConst *argv);
#endif
