#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
QJS="$ROOT/sdk/openvibe/third_party/quickjs"
BUILD="$ROOT/.tmp/quickjs-smoke"

rm -rf "$BUILD"
mkdir -p "$BUILD"

cat > "$BUILD/smoke.c" <<'C'
#include <stdio.h>
#include "quickjs.h"

int main(void) {
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);

    JSValue value = JS_Eval(ctx, "1 + 2 + 3", 9, "<smoke>", JS_EVAL_TYPE_GLOBAL);
    int32_t out = 0;
    JS_ToInt32(ctx, &out, value);

    JS_FreeValue(ctx, value);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

    printf("quickjs result=%d\n", out);
    return out == 6 ? 0 : 1;
}
C

sources=(
  "$QJS/quickjs.c"
  "$QJS/libregexp.c"
  "$QJS/libunicode.c"
  "$QJS/cutils.c"
)

[[ -f "$QJS/dtoa.c" ]] && sources+=("$QJS/dtoa.c")
[[ -f "$QJS/libbf.c" ]] && sources+=("$QJS/libbf.c")

cc \
  -std=gnu11 \
  -D_GNU_SOURCE \
  -DCONFIG_VERSION=\"openvibe\" \
  -I"$QJS" \
  "$BUILD/smoke.c" \
  "${sources[@]}" \
  -lm \
  -ldl \
  -lpthread \
  -o "$BUILD/smoke-quickjs"

"$BUILD/smoke-quickjs"
