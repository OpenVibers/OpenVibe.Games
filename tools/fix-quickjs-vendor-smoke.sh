#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
QJS="$ROOT/sdk/openvibe/third_party/quickjs"

cd "$ROOT"

echo "[openvibe] forcing clean QuickJS re-vendor"
rm -rf "$QJS"
tools/vendor-quickjs.sh

echo "[openvibe] replacing smoke-quickjs.sh with robust version"

cat > tools/smoke-quickjs.sh <<'SMOKE'
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
SMOKE

chmod +x tools/smoke-quickjs.sh

echo "[openvibe] patching apply-openvibe-sdk.sh to not require libbf.c blindly"

python3 <<'PY'
from pathlib import Path

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

# Remove hardcoded libbf VPC line insertion if present.
s = s.replace(
    '\\n\\t\\t\\t\\$File\\t"..\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\libbf.c"',
    ''
)

# Also remove the cleanup regex for libbf so repeated runs don't matter.
s = s.replace(
    '  s/^.*openvibe\\\\\\\\third_party\\\\\\\\quickjs\\\\\\\\libbf\\\\.c.*\\n//mg;\\n',
    ''
)

p.write_text(s)
PY

echo "[openvibe] quickjs folder now contains:"
find "$QJS" -maxdepth 1 -type f -printf " - %f\n" | sort

echo "[openvibe] running smoke test"
tools/smoke-quickjs.sh

echo
echo "[openvibe] QuickJS vendor/smoke fixed."
