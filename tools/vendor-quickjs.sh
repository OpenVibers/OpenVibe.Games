#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
DEST="$ROOT/sdk/openvibe/third_party/quickjs"
TMP="${TMPDIR:-/tmp}/openvibe-quickjs-vendor"

rm -rf "$TMP"

git clone --depth 1 https://github.com/bellard/quickjs.git "$TMP" || \
git clone --depth 1 https://github.com/quickjs-ng/quickjs.git "$TMP"

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
