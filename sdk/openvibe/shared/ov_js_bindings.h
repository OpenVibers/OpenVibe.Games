#pragma once

#include "openvibe/third_party/quickjs/quickjs.h"

class COpenVibeJSRuntime;

void OVJS_RegisterNativeBindings(JSContext *ctx, COpenVibeJSRuntime *runtime);
