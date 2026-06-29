#pragma once

#include "openvibe/third_party/quickjs/quickjs.h"

class CHL2MP_Player;

void OVJS_RegisterPlayerClass(JSContext *ctx);
JSValue OVJS_NewPlayer(JSContext *ctx, CHL2MP_Player *player);
CHL2MP_Player *OVJS_ResolvePlayerByUserId(int userId);
CHL2MP_Player *OVJS_GetPlayerFromThis(JSContext *ctx, JSValueConst thisVal);
