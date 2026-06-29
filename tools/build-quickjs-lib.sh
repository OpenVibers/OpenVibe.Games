#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

SRC_QJS="$ROOT/sdk/openvibe/third_party/quickjs"
SDK_QJS="$SDK/src/game/shared/openvibe/third_party/quickjs"
OUT="$SDK_QJS/build"

if [[ ! -f "$SRC_QJS/quickjs.c" ]]; then
  echo "Missing $SRC_QJS/quickjs.c" >&2
  echo "Run: tools/vendor-quickjs.sh" >&2
  exit 1
fi

mkdir -p "$SDK_QJS"

# Exclude build/ so rsync does not delete our .o/.a output dir.
rsync -a --delete --exclude='build/' "$SRC_QJS/" "$SDK_QJS/"

mkdir -p "$OUT"

sources=(
  quickjs.c
  libregexp.c
  libunicode.c
  cutils.c
)

[[ -f "$SDK_QJS/dtoa.c" ]] && sources+=(dtoa.c)
[[ -f "$SDK_QJS/libbf.c" ]] && sources+=(libbf.c)

rm -f "$OUT"/*.o "$OUT"/libquickjs_openvibe.a

for src in "${sources[@]}"; do
  obj="$OUT/${src%.c}.o"
  echo "[openvibe-qjs] cc $src -> $obj"

  cc \
    -std=gnu11 \
    -O2 \
    -fPIC \
    -D_GNU_SOURCE \
    -DCONFIG_VERSION=\"openvibe\" \
    -I"$SDK_QJS" \
    -c "$SDK_QJS/$src" \
    -o "$obj"
done

ar rcs "$OUT/libquickjs_openvibe.a" "$OUT"/*.o

echo "[openvibe-qjs] built $OUT/libquickjs_openvibe.a"
ls -lh "$OUT/libquickjs_openvibe.a"
