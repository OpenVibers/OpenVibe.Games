#!/usr/bin/env bash
set -euo pipefail

log(){ printf '[openvibe] %s\n' "$*"; }
warn(){ printf '[openvibe warn] %s\n' "$*" >&2; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -x tools/openvibe-gh-repo.sh ]]; then
  REPO="$(tools/openvibe-gh-repo.sh)"
else
  remote="$(git config --get remote.origin.url || true)"
  REPO="${remote#git@github.com:}"; REPO="${REPO#ssh://git@github.com/}"; REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"; REPO="${REPO%/}"
fi
WORKFLOW="windows-source-sdk-dlls.yml"

log "fix Windows server stub PCH order + rerun"
log "root=$ROOT"
log "branch=$BRANCH"
log "repo=$REPO"

PY="$(command -v python3 || command -v python || true)"
if [[ -z "$PY" ]]; then
  echo "python3/python required for this patch script" >&2
  exit 1
fi

"$PY" - <<'PY'
from pathlib import Path
import re

root = Path.cwd()
files = [
    Path("sdk/openvibe/server/hl2mp/openvibe_js_server.cpp"),
    Path("sdk/openvibe/shared/ov_js_runtime.cpp"),
    Path("sdk/openvibe/shared/ov_js_bindings.cpp"),
    Path("sdk/openvibe/shared/ov_js_player.cpp"),
]
marker = "// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB"
cond = "#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)"

for rel in files:
    path = root / rel
    if not path.exists():
        raise SystemExit(f"missing expected file: {rel}")
    text = path.read_text(encoding="utf-8")
    original = text
    if marker not in text:
        print(f"[skip] no stub marker: {rel}")
        continue

    # MSVC /Yu cbase.h skips preprocessor/code before the PCH include.  The earlier
    # stub patch put #if before #include "cbase.h", so MSVC skipped the #if and then
    # saw an unexpected #else.  Make cbase.h the first real line.
    bom = "\ufeff" if text.startswith("\ufeff") else ""
    if bom:
        text = text[1:]

    start_pat = re.compile(
        r"\A\s*// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB\s*\r?\n"
        r"\s*#if defined\(_WIN32\) && defined\(GAME_DLL\) && !defined\(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS\)\s*\r?\n"
        r"\s*(?:#include \"cbase\.h\"\s*\r?\n)?",
        re.MULTILINE,
    )
    text2, n = start_pat.subn(f'#include "cbase.h"\n{marker}\n{cond}\n', text, count=1)
    if n == 0:
        # Idempotent path: already starts with cbase.h, but still normalize the next lines.
        text2 = text
        text2 = re.sub(
            r"\A\s*#include \"cbase\.h\"\s*\r?\n\s*// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB\s*\r?\n\s*#if defined\(_WIN32\) && defined\(GAME_DLL\) && !defined\(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS\)\s*\r?\n",
            f'#include "cbase.h"\n{marker}\n{cond}\n',
            text2,
            count=1,
        )

    # Remove the duplicate cbase.h include from the real/non-stub side. It is already
    # first in the translation unit and must not be repeated immediately after #else.
    text2 = re.sub(r"(#else\s*\r?\n)\s*#include \"cbase\.h\"\s*\r?\n", r"\1", text2, count=1)

    # Ensure there is a newline before #endif at EOF.
    text2 = text2.rstrip() + "\n"

    # Cheap sanity checks for the stub wrapper.
    if not text2.startswith('#include "cbase.h"\n'):
        raise SystemExit(f"{rel}: cbase.h is not first after patch")
    if text2.count(cond) != 1:
        raise SystemExit(f"{rel}: expected exactly one stub #if, found {text2.count(cond)}")
    if text2.count("#else") < 1:
        raise SystemExit(f"{rel}: expected at least one #else")
    if text2.count("#endif") < 1:
        raise SystemExit(f"{rel}: expected at least one #endif")

    if text2 != original:
        path.write_text(bom + text2, encoding="utf-8", newline="\n")
        print(f"[patched] {rel}")
    else:
        print(f"[ok] already normalized: {rel}")
PY

cat > docs/WINDOWS_SERVER_STUB_PCH_ORDER.md <<'EOF_DOC'
# Windows server stub PCH order

Source SDK server projects compile with MSVC precompiled headers using `/Yu cbase.h`.
MSVC ignores/skips text before the configured PCH include, so the Windows server
QuickJS stub wrapper cannot put `#if ...` before `#include "cbase.h"`.

The stubbed OpenVibe server `.cpp` files must start with:

```cpp
#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
```

The non-stub branch must not re-include `cbase.h` immediately after `#else`.
EOF_DOC

log "git diff summary"
git diff --stat

if [[ -n "$(git status --porcelain)" ]]; then
  git add \
    sdk/openvibe/server/hl2mp/openvibe_js_server.cpp \
    sdk/openvibe/shared/ov_js_runtime.cpp \
    sdk/openvibe/shared/ov_js_bindings.cpp \
    sdk/openvibe/shared/ov_js_player.cpp \
    docs/WINDOWS_SERVER_STUB_PCH_ORDER.md
  git commit -m "Fix Windows server stub PCH include order"
else
  log "no source changes to commit"
fi

log "pushing $BRANCH"
git push origin "$BRANCH"

if [[ -x tools/trigger-windows-dll-build-clean.sh ]]; then
  log "triggering clean Windows DLL build"
  tools/trigger-windows-dll-build-clean.sh || true
elif command -v gh >/dev/null 2>&1; then
  log "triggering workflow"
  gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" || true
  sleep 8
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId' || true)"
  if [[ -n "${RUN_ID:-}" && "$RUN_ID" != "null" ]]; then
    log "watching run $RUN_ID"
    gh run watch "$RUN_ID" --repo "$REPO" --exit-status || true
    if [[ -x tools/windows-workflow-debug-and-install.sh ]]; then
      tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
    fi
  fi
else
  warn "gh not found; pushed patch but did not trigger workflow"
fi

if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh || true
fi

log "done"
