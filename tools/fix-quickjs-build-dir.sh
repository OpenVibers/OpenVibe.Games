#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

cd "$ROOT"

echo "[openvibe] replacing tools/build-quickjs-lib.sh"

cat > tools/build-quickjs-lib.sh <<'BUILDQJS'
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

# Important: exclude build/ so rsync does not delete our object output dir.
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
BUILDQJS

chmod +x tools/build-quickjs-lib.sh

echo "[openvibe] removing direct QuickJS .c files from server_hl2mp.vpc"

SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"

if [[ -f "$SERVER_VPC" ]]; then
  cp "$SERVER_VPC" "$SERVER_VPC.bak.$(date +%Y%m%d-%H%M%S)"

  perl -0pi -e '
    s/^.*quickjs\\quickjs\.c.*\n//mg;
    s/^.*quickjs\\libregexp\.c.*\n//mg;
    s/^.*quickjs\\libunicode\.c.*\n//mg;
    s/^.*quickjs\\cutils\.c.*\n//mg;
    s/^.*quickjs\\dtoa\.c.*\n//mg;
    s/^.*quickjs\\libbf\.c.*\n//mg;
  ' "$SERVER_VPC"

  if ! grep -q 'libquickjs_openvibe.a' "$SERVER_VPC"; then
    perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe.a"\n/s' "$SERVER_VPC"
  fi
fi

echo "[openvibe] patching apply-openvibe-sdk.sh so future applies keep this fix"

python3 <<'PY'
from pathlib import Path
import re

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

# Make sure apply script calls static library builder after copying QuickJS.
if '"$ROOT/tools/build-quickjs-lib.sh"' not in s:
    needle = 'copy_tree "$ROOT/sdk/openvibe/third_party/quickjs" \\\n  "$SDK/src/game/shared/openvibe/third_party/quickjs"'
    if needle in s:
        s = s.replace(needle, needle + '\n\n"$ROOT/tools/build-quickjs-lib.sh"')
    else:
        s += '\n\n"$ROOT/tools/build-quickjs-lib.sh"\n'

# Add a strong cleanup block near the end.
marker = "OPENVIBE_REMOVE_DIRECT_QUICKJS_C"
if marker not in s:
    s += r'''

# OPENVIBE_REMOVE_DIRECT_QUICKJS_C
if [[ -f "$SERVER_VPC" ]]; then
  perl -0pi -e '
    s/^.*quickjs\\quickjs\.c.*\n//mg;
    s/^.*quickjs\\libregexp\.c.*\n//mg;
    s/^.*quickjs\\libunicode\.c.*\n//mg;
    s/^.*quickjs\\cutils\.c.*\n//mg;
    s/^.*quickjs\\dtoa\.c.*\n//mg;
    s/^.*quickjs\\libbf\.c.*\n//mg;
  ' "$SERVER_VPC"

  if ! grep -q 'libquickjs_openvibe.a' "$SERVER_VPC"; then
    perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe.a"\n/s' "$SERVER_VPC"
  fi
fi
'''

p.write_text(s)
PY

echo "[openvibe] building QuickJS static lib"
tools/build-quickjs-lib.sh

echo
echo "[openvibe] checking VPC for bad direct QuickJS C entries"
if [[ -f "$SERVER_VPC" ]]; then
  grep -nE 'quickjs\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c' "$SERVER_VPC" || true
  grep -n 'libquickjs_openvibe.a' "$SERVER_VPC" || true
fi

echo
echo "[openvibe] fixed. Now run:"
echo "  tools/apply-openvibe-sdk.sh"
echo "  tools/build-sdk-linux.sh 2>&1 | tee ~/ov-build.log"
