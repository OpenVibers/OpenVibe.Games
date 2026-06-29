#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
fail() { echo "[openvibe error] $*" >&2; exit 1; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
RUN_ID="${1:-}"
EXPECTED_ARCH="${OPENVIBE_EXPECT_DLL_ARCH:-x86}"
command -v gh >/dev/null 2>&1 || fail "gh missing"
command -v file >/dev/null 2>&1 || warn "file command missing; architecture check will be weaker"
command -v strings >/dev/null 2>&1 || fail "strings missing; install binutils"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 10 --json databaseId,status,conclusion --jq '[.[] | select(.status=="completed" and .conclusion=="success")][0].databaseId')"
fi
[[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || fail "no successful workflow run found for $WORKFLOW on $BRANCH"
OUT="$ROOT/artifacts/windows-dll-install/run-$RUN_ID"
rm -rf "$OUT"
mkdir -p "$OUT"
say "downloading openvibe-windows-dlls from run $RUN_ID"
gh run download "$RUN_ID" --repo "$REPO" --name openvibe-windows-dlls --dir "$OUT"
CLIENT="$(find "$OUT" -type f -iname client.dll | sort | head -n1 || true)"
SERVER="$(find "$OUT" -type f -iname server.dll | sort | head -n1 || true)"
[[ -f "$CLIENT" ]] || fail "client.dll missing from artifact"
[[ -f "$SERVER" ]] || fail "server.dll missing from artifact"
say "candidate client=$CLIENT"
say "candidate server=$SERVER"
file "$CLIENT" || true
file "$SERVER" || true
if [[ "$EXPECTED_ARCH" == "x86" ]] && file "$CLIENT" 2>/dev/null | grep -Fq 'PE32+'; then
  fail "artifact client.dll is x64/PE32+. Proton Source SDK Base needs 32-bit PE32 DLLs. Re-run the Win32 build patch."
fi
if [[ "$EXPECTED_ARCH" == "x86" ]] && file "$SERVER" 2>/dev/null | grep -Fq 'PE32+'; then
  fail "artifact server.dll is x64/PE32+. Proton Source SDK Base needs 32-bit PE32 DLLs. Re-run the Win32 build patch."
fi
strings -a "$CLIENT" | grep -Eq 'ov_join|ov_menu|OpenVibe' || fail "artifact client.dll lacks OpenVibe client strings"
strings -a "$SERVER" | grep -Eq 'ov_js_status|ov_js_cmd|OpenVibe' || fail "artifact server.dll lacks OpenVibe server strings"
mkdir -p game/openvibe.games/bin artifacts/manual-dll-backups
STAMP="$(date +%Y%m%d-%H%M%S)"
[[ -f game/openvibe.games/bin/client.dll ]] && cp -f game/openvibe.games/bin/client.dll "artifacts/manual-dll-backups/client.dll.$STAMP.bak" || true
[[ -f game/openvibe.games/bin/server.dll ]] && cp -f game/openvibe.games/bin/server.dll "artifacts/manual-dll-backups/server.dll.$STAMP.bak" || true
cp -f "$CLIENT" game/openvibe.games/bin/client.dll
cp -f "$SERVER" game/openvibe.games/bin/server.dll
say "installed patched Windows DLLs to game/openvibe.games/bin"
if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
  tools/verify-openvibe-dll-content.sh
else
  strings -a game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|OpenVibe' | head
  strings -a game/openvibe.games/bin/server.dll | grep -E 'ov_js_status|ov_js_cmd|OpenVibe' | head
fi
