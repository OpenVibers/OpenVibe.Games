#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
RUN_BUILD="${RUN_BUILD:-1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

say() {
  echo "[openvibe] $*"
}

say "fixing QuickJS static-library VPC link issue"

mkdir -p tools

# Clean accidentally tracked local/generated junk if it exists.
say "cleaning accidental tracked junk if present"
git rm -f .tmp/quickjs-smoke/smoke-quickjs 2>/dev/null || true
git rm -f tools/apply-openvibe-sdk.sh.bak.* 2>/dev/null || true

touch .gitignore
if ! grep -qxF ".tmp/" .gitignore; then
  cat >> .gitignore <<'GITIGNORE_ADD'

# OpenVibe local/generated build junk
.tmp/
*.bak.*
tools/*.bak.*
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/
GITIGNORE_ADD
fi

say "writing tools/build-quickjs-lib.sh"

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
BUILDQJS

chmod +x tools/build-quickjs-lib.sh

say "patching tools/apply-openvibe-sdk.sh"

if [[ ! -f tools/apply-openvibe-sdk.sh ]]; then
  echo "Missing tools/apply-openvibe-sdk.sh" >&2
  exit 1
fi

backup_file tools/apply-openvibe-sdk.sh

python3 <<'PY'
from pathlib import Path
import re

p = Path("tools/apply-openvibe-sdk.sh")
s = p.read_text()

# Remove older injected QuickJS final blocks so this script stays idempotent.
patterns = [
    r'\n# OPENVIBE_REMOVE_DIRECT_QUICKJS_C\n.*?(?=\n# OPENVIBE|\necho "\[openvibe-sdk\] Source SDK OpenVibe patch applied"|\Z)',
    r'\n# OPENVIBE_LINK_QUICKJS_STATIC_LIB\n.*?(?=\n# OPENVIBE|\necho "\[openvibe-sdk\] Source SDK OpenVibe patch applied"|\Z)',
    r'\n# OPENVIBE_FIX_QUICKJS_LINK_FINAL_V2\n.*?(?=\n# OPENVIBE|\necho "\[openvibe-sdk\] Source SDK OpenVibe patch applied"|\Z)',
]
for pat in patterns:
    s = re.sub(pat, "\n", s, flags=re.S)

# Do not allow a literal libquickjs_openvibe.a in any VPC $Lib line.
# VPC appends .a itself, so ".a" here becomes ".a.a".
s = s.replace("libquickjs_openvibe.a", "libquickjs_openvibe")

# Ensure apply script calls the QuickJS static library builder.
if '"$ROOT/tools/build-quickjs-lib.sh"' not in s:
    needle = 'copy_tree "$ROOT/sdk/openvibe/third_party/quickjs" \\\n  "$SDK/src/game/shared/openvibe/third_party/quickjs"'
    if needle in s:
        s = s.replace(needle, needle + '\n\n"$ROOT/tools/build-quickjs-lib.sh"')
    else:
        s += '\n\n"$ROOT/tools/build-quickjs-lib.sh"\n'

final_block = r'''
# OPENVIBE_FIX_QUICKJS_LINK_FINAL_V2
# QuickJS is C, so do not compile its .c files through Source SDK/VPC C++.
# We build libquickjs_openvibe.a with cc and link it as a library.
if [[ -f "$SERVER_VPC" ]]; then
  perl -0pi -e '
    s/^.*quickjs\\quickjs\.c.*\n//mg;
    s/^.*quickjs\\libregexp\.c.*\n//mg;
    s/^.*quickjs\\libunicode\.c.*\n//mg;
    s/^.*quickjs\\cutils\.c.*\n//mg;
    s/^.*quickjs\\dtoa\.c.*\n//mg;
    s/^.*quickjs\\libbf\.c.*\n//mg;
  ' "$SERVER_VPC"

  perl -0pi -e 's/^.*libquickjs_openvibe(?:\.a)?".*\n//mg' "$SERVER_VPC"

  perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe"\n/s' "$SERVER_VPC"

  echo "[openvibe-sdk] linked QuickJS static library"
fi
'''

final_echo = 'echo "[openvibe-sdk] Source SDK OpenVibe patch applied"'
if final_echo in s:
    s = s.replace(final_echo, final_block + "\n" + final_echo)
else:
    s += "\n" + final_block + "\n"

p.write_text(s)
PY

chmod +x tools/apply-openvibe-sdk.sh

say "applying SDK patch"
tools/apply-openvibe-sdk.sh

SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"

say "force-fixing already-applied SDK server_hl2mp.vpc"

if [[ -f "$SERVER_VPC" ]]; then
  backup_file "$SERVER_VPC"

  perl -0pi -e '
    s/^.*quickjs\\quickjs\.c.*\n//mg;
    s/^.*quickjs\\libregexp\.c.*\n//mg;
    s/^.*quickjs\\libunicode\.c.*\n//mg;
    s/^.*quickjs\\cutils\.c.*\n//mg;
    s/^.*quickjs\\dtoa\.c.*\n//mg;
    s/^.*quickjs\\libbf\.c.*\n//mg;
  ' "$SERVER_VPC"

  perl -0pi -e 's/^.*libquickjs_openvibe(?:\.a)?".*\n//mg' "$SERVER_VPC"
  perl -0pi -e 's/(\$File\s+"hl2mp\\openvibe_js_server\.cpp"\n)/$1\t\t\t\$Lib\t"..\\shared\\openvibe\\third_party\\quickjs\\build\\libquickjs_openvibe"\n/s' "$SERVER_VPC"
fi

say "building QuickJS static lib"
tools/build-quickjs-lib.sh

say "VPC quickjs check"
if [[ -f "$SERVER_VPC" ]]; then
  grep -nE 'quickjs\\(quickjs|libregexp|libunicode|cutils|dtoa|libbf)\.c|libquickjs_openvibe' "$SERVER_VPC" || true
else
  echo "Missing $SERVER_VPC" >&2
fi

if [[ "$RUN_BUILD" = "1" ]]; then
  say "running SDK build"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

  say "build finished. Last lines:"
  tail -80 "$HOME/ov-build.log"
else
  say "skipping build because RUN_BUILD=0"
  echo "Run manually:"
  echo "  tools/build-sdk-linux.sh 2>&1 | tee ~/ov-build.log"
fi
