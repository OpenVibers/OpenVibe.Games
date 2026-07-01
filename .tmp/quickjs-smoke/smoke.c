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
