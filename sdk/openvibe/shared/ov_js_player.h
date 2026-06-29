#pragma once

// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)

#include "openvibe/ov_js_runtime.h"
class CHL2MP_Player;
void OVJS_RegisterPlayerClass(JSContext *ctx);
JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player);
CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId);
CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal);
#else
#include "openvibe/third_party/quickjs/quickjs.h"

class CHL2MP_Player;

void OVJS_RegisterPlayerClass(JSContext *ctx);
JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player);
CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId);
CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal);
#endif
