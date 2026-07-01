#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
QJS="$ROOT/sdk/openvibe/third_party/quickjs"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

patch_quickjs_tree() {
  local qjs_dir="$1"
  local qjs_c="$qjs_dir/quickjs.c"

  [[ -f "$qjs_c" ]] || return 0

  if ! grep -q 'OPENVIBE_QUICKJS_STRICT_C_SHIM' "$qjs_c"; then
    local tmp
    tmp="$(mktemp)"

    cat > "$tmp" <<'QJS_SHIM'
#ifndef OPENVIBE_QUICKJS_STRICT_C_SHIM
#define OPENVIBE_QUICKJS_STRICT_C_SHIM

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#ifndef CONFIG_VERSION
#define CONFIG_VERSION "openvibe"
#endif

#if defined(__GNUC__) && !defined(__cplusplus) && defined(__STRICT_ANSI__) && !defined(asm)
#define asm __asm__
#endif

#endif

QJS_SHIM

    cat "$qjs_c" >> "$tmp"
    mv "$tmp" "$qjs_c"
    echo "[openvibe] patched QuickJS strict-C shim: $qjs_c"
  fi
}

echo "[openvibe] refreshing remote branch metadata, without resetting your local files"
git fetch origin codex/openvibe-next-steps || true

echo "[openvibe] checking embedded JS files from previous step"

missing=0
for f in \
  tools/apply-openvibe-sdk.sh \
  sdk/openvibe/server/hl2mp/openvibe_server.cpp \
  sdk/openvibe/shared/ov_js_runtime.cpp \
  sdk/openvibe/shared/ov_js_bindings.cpp \
  sdk/openvibe/shared/ov_js_player.cpp \
  sdk/openvibe/server/hl2mp/openvibe_js_server.cpp \
  game/openvibe.games/js/core/hook.js \
  game/openvibe.games/js/core/gamemode.js \
  game/openvibe.games/js/bridge.js \
  game/openvibe.games/js/gamemodes/hub/server.js
do
  if [[ ! -f "$f" ]]; then
    echo "[openvibe] MISSING: $f"
    missing=1
  fi
done

if [[ "$missing" = "1" ]]; then
  echo
  echo "[openvibe] Some embedded JS files are missing."
  echo "[openvibe] Re-run tools/implement-embedded-js.sh first, then run this continue script again."
  exit 1
fi

echo "[openvibe] rewriting robust QuickJS vendor script"

cat > tools/vendor-quickjs.sh <<'VENDOR'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
DEST="$ROOT/sdk/openvibe/third_party/quickjs"
TMP="${TMPDIR:-/tmp}/openvibe-quickjs-vendor"

rm -rf "$TMP"

git clone --depth 1 https://github.com/bellard/quickjs.git "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -av \
  --include='quickjs.c' \
  --include='quickjs.h' \
  --include='quickjs-atom.h' \
  --include='quickjs-opcode.h' \
  --include='libregexp.c' \
  --include='libregexp.h' \
  --include='libregexp-opcode.h' \
  --include='libunicode.c' \
  --include='libunicode.h' \
  --include='libunicode-table.h' \
  --include='cutils.c' \
  --include='cutils.h' \
  --include='dtoa.c' \
  --include='dtoa.h' \
  --include='libbf.c' \
  --include='libbf.h' \
  --include='list.h' \
  --include='LICENSE' \
  --include='VERSION' \
  --exclude='*' \
  "$TMP/" \
  "$DEST/"

git -C "$TMP" rev-parse HEAD > "$DEST/UPSTREAM_COMMIT"

cat > "$DEST/README.openvibe.md" <<'DOC'
# QuickJS vendored for OpenVibe: Source

Vendored QuickJS core files for OpenVibe's embedded JavaScript runtime.

Excluded intentionally:
- qjs.c
- qjsc.c
- quickjs-libc.c
- quickjs-libc.h

Reason:
OpenVibe embeds QuickJS as a sandboxed script VM. Community scripts should not
receive raw std/os/filesystem/process APIs.
DOC

echo "[openvibe] vendored QuickJS into $DEST"
echo "[openvibe] upstream commit: $(cat "$DEST/UPSTREAM_COMMIT")"
VENDOR

chmod +x tools/vendor-quickjs.sh

if [[ "${FORCE_REVENDOR:-0}" = "1" || ! -f "$QJS/quickjs.c" ]]; then
  echo "[openvibe] vendoring QuickJS"
  tools/vendor-quickjs.sh
else
  echo "[openvibe] using existing QuickJS folder"
fi

patch_quickjs_tree "$QJS"

echo "[openvibe] writing robust smoke test"

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

echo "[openvibe] patching apply-openvibe-sdk.sh post-apply QuickJS cleanup"

backup_file tools/apply-openvibe-sdk.sh

python3 <<'PY'
from pathlib import Path

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

marker = "OPENVIBE_CONTINUE_QUICKJS_POSTPATCH"

block = r'''
# OPENVIBE_CONTINUE_QUICKJS_POSTPATCH
patch_openvibe_quickjs_after_apply() {
  local qjs_dir="$SDK/src/game/shared/openvibe/third_party/quickjs"
  local qjs_c="$qjs_dir/quickjs.c"

  if [[ -f "$qjs_c" ]] && ! grep -q 'OPENVIBE_QUICKJS_STRICT_C_SHIM' "$qjs_c"; then
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp" <<'QJS_SHIM'
#ifndef OPENVIBE_QUICKJS_STRICT_C_SHIM
#define OPENVIBE_QUICKJS_STRICT_C_SHIM

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#ifndef CONFIG_VERSION
#define CONFIG_VERSION "openvibe"
#endif

#if defined(__GNUC__) && !defined(__cplusplus) && defined(__STRICT_ANSI__) && !defined(asm)
#define asm __asm__
#endif

#endif

QJS_SHIM
    cat "$qjs_c" >> "$tmp"
    mv "$tmp" "$qjs_c"
    echo "[openvibe-sdk] patched QuickJS strict-C shim"
  fi

  if [[ ! -f "$qjs_dir/libbf.c" ]]; then
    perl -0pi -e 's/^.*openvibe\\\\third_party\\\\quickjs\\\\libbf\.c.*\n//mg; s/^.*openvibe\\third_party\\quickjs\\libbf\.c.*\n//mg' "$SERVER_VPC" || true
    echo "[openvibe-sdk] libbf.c missing; removed libbf.c from server_hl2mp.vpc"
  fi
}

patch_openvibe_quickjs_after_apply
'''

if marker not in s:
    final_echo = 'echo "[openvibe-sdk] Source SDK OpenVibe patch applied"'
    if final_echo in s:
        s = s.replace(final_echo, block + "\n" + final_echo)
    else:
        s += "\n" + block + "\n"

p.write_text(s)
PY

echo "[openvibe] QuickJS files:"
find "$QJS" -maxdepth 1 -type f -printf " - %f\n" | sort

echo "[openvibe] running QuickJS smoke test"
tools/smoke-quickjs.sh

echo "[openvibe] applying SDK patch"
tools/apply-openvibe-sdk.sh

SDK_QJS="$SDK/src/game/shared/openvibe/third_party/quickjs"
patch_quickjs_tree "$SDK_QJS"

if [[ ! -f "$SDK_QJS/libbf.c" ]]; then
  SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"
  perl -0pi -e 's/^.*openvibe\\\\third_party\\\\quickjs\\\\libbf\.c.*\n//mg; s/^.*openvibe\\third_party\\quickjs\\libbf\.c.*\n//mg' "$SERVER_VPC" || true
fi

echo
echo "[openvibe] continue step complete."
echo
echo "Next build command:"
echo "  tools/build-sdk-linux.sh 2>&1 | tee ~/ov-build.log"
echo
echo "If you want this script to attempt the build now:"
echo "  RUN_BUILD=1 tools/continue-embedded-js.sh"
echo

if [[ "${RUN_BUILD:-0}" = "1" ]]; then
  echo "[openvibe] running SDK build"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"
  echo "[openvibe] build finished"
fi
