#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

echo "[openvibe] writing QuickJS static library builder"

cat > tools/build-quickjs-lib.sh <<'BUILDQJS'
#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

SRC_QJS="$ROOT/sdk/openvibe/third_party/quickjs"
SDK_QJS="$SDK/src/game/shared/openvibe/third_party/quickjs"
OUT="$SDK_QJS/build"

mkdir -p "$OUT"

if [[ ! -f "$SRC_QJS/quickjs.c" ]]; then
  echo "Missing $SRC_QJS/quickjs.c" >&2
  echo "Run: tools/vendor-quickjs.sh" >&2
  exit 1
fi

# Make sure SDK copy exists. apply-openvibe-sdk.sh also does this,
# but this makes the script usable directly.
mkdir -p "$SDK_QJS"
rsync -a --delete "$SRC_QJS/" "$SDK_QJS/"

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
  echo "[openvibe-qjs] cc $src"
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

echo "[openvibe] patching apply-openvibe-sdk.sh to link libquickjs_openvibe.a instead of compiling QuickJS C files"

backup_file tools/apply-openvibe-sdk.sh

python3 <<'PY'
from pathlib import Path
import re

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

# Remove QuickJS .c cleanup patterns from perl patch block if they exist.
for name in ["quickjs", "libregexp", "libunicode", "cutils", "dtoa", "libbf"]:
    s = re.sub(
        rf'\s*s/\^\.\*openvibe\\\\third_party\\\\quickjs\\\\{name}\\\.c\.\*\\n//mg;\n?',
        '\n',
        s,
    )
    s = re.sub(
        rf'\s*s/\^\.\*openvibe\\\\\\\\third_party\\\\\\\\quickjs\\\\\\\\{name}\\\\\.c\.\*\\n//mg;\n?',
        '\n',
        s,
    )

# Remove inserted QuickJS .c $File entries from replacement text.
for name in ["quickjs", "libregexp", "libunicode", "cutils", "dtoa", "libbf"]:
    s = s.replace(
        f'\\n\\t\\t\\t\\$File\\t"..\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\{name}.c"',
        ''
    )
    s = s.replace(
        f'\n\t\t\t\\$File\t"..\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\{name}.c"',
        ''
    )
    s = s.replace(
        f'\n\t\t\t$File\t"..\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\{name}.c"',
        ''
    )

# Remove any actual already-written lines from the script text.
s = re.sub(r'^.*quickjs\\\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c.*\n', '', s, flags=re.M)
s = re.sub(r'^.*quickjs\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c.*\n', '', s, flags=re.M)

# Ensure build-quickjs-lib is called after copy_tree.
if "tools/build-quickjs-lib.sh" not in s:
    needle = 'copy_tree "$ROOT/sdk/openvibe/third_party/quickjs" \\\n  "$SDK/src/game/shared/openvibe/third_party/quickjs"'
    replacement = needle + '\n\n"$ROOT/tools/build-quickjs-lib.sh"'
    if needle in s:
        s = s.replace(needle, replacement)
    else:
        s += '\n\n"$ROOT/tools/build-quickjs-lib.sh"\n'

# Add static lib to server_hl2mp.vpc patch.
# Try to insert a $Lib line near the openvibe source files, only once.
lib_line = '\t\t\t$Lib\t"..\\\\shared\\\\openvibe\\\\third_party\\\\quickjs\\\\build\\\\libquickjs_openvibe.a"'
if 'libquickjs_openvibe.a' not in s:
    # Add after openvibe_js_server.cpp if present in replacement text.
    s = s.replace(
        '\t\t\t\\$File\t"hl2mp\\\\openvibe_js_server.cpp"',
        '\t\t\t\\$File\t"hl2mp\\\\openvibe_js_server.cpp"\\n' + lib_line.replace('$', '\\$')
    )
    # If that escaped replacement did not hit, add a direct post-patch insertion block.
    if 'libquickjs_openvibe.a' not in s:
        s += r'''

# Link prebuilt QuickJS C static library. QuickJS must be compiled as C, not C++.
if ! grep -q 'libquickjs_openvibe.a' "$SERVER_VPC"; then
  perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe.a"\n/s' "$SERVER_VPC"
  echo "[openvibe-sdk] linked QuickJS static library"
fi
'''

p.write_text(s)
PY

echo "[openvibe] also patching already-applied SDK VPC now, if it exists"

SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"

if [[ -f "$SERVER_VPC" ]]; then
  backup_file "$SERVER_VPC"

  # Remove direct QuickJS C files from VPC.
  perl -0pi -e 's/^.*openvibe\\\\third_party\\\\quickjs\\\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c.*\n//mg; s/^.*openvibe\\third_party\\quickjs\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c.*\n//mg' "$SERVER_VPC"

  if ! grep -q 'libquickjs_openvibe.a' "$SERVER_VPC"; then
    perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe.a"\n/s' "$SERVER_VPC"
  fi
fi

echo "[openvibe] building QuickJS C static library"
tools/build-quickjs-lib.sh

echo
echo "[openvibe] fixed QuickJS C/C++ build split."
echo
echo "Now run:"
echo "  tools/apply-openvibe-sdk.sh"
echo "  tools/build-sdk-linux.sh 2>&1 | tee ~/ov-build.log"
echo "  tail -160 ~/ov-build.log"
