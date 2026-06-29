#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
warn() { echo "[openvibe warn] $*" >&2; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"
RUN_ID="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh is missing. Install/auth it first: sudo apt install gh && gh auth login" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
fi
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  echo "Could not find a workflow run for $REPO $WORKFLOW on $BRANCH" >&2
  exit 1
fi

OUT="$ROOT/artifacts/windows-workflow-debug/run-${RUN_ID}-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT"

say "repo=$REPO"
say "run=$RUN_ID"
say "downloading logs/artifacts into $OUT"

gh run view "$RUN_ID" --repo "$REPO" --log > "$OUT/full-run.log" 2>&1 || true
gh run download "$RUN_ID" --repo "$REPO" --dir "$OUT" >/dev/null 2>&1 || true
find "$OUT" -type f | sort > "$OUT/file-list.txt"

say "likely errors:"
if ! grep -RInE "error |error:|fatal:|failed|Exception|No patched|MSB[0-9]+|LNK[0-9]+|C[0-9]{4}" "$OUT" | head -n 80; then
  warn "no obvious errors found in downloaded logs"
fi

say "artifact files:"
cat "$OUT/file-list.txt"

CLIENT=""
SERVER=""
while IFS= read -r f; do
  case "$(basename "$f")" in
    client.dll) CLIENT="$f" ;;
    server.dll) SERVER="$f" ;;
  esac
done < <(find "$OUT" -type f \( -iname 'client.dll' -o -iname 'server.dll' \) | sort)

if [[ -n "$CLIENT" && -n "$SERVER" ]]; then
  say "candidate client=$CLIENT"
  say "candidate server=$SERVER"
  if strings -a "$CLIENT" | grep -Eq 'ov_join|ov_menu|OpenVibe' && strings -a "$SERVER" | grep -Eq 'ov_js_status|ov_js_cmd|OpenVibe'; then
    mkdir -p game/openvibe.games/bin
    cp -f "$CLIENT" game/openvibe.games/bin/client.dll
    cp -f "$SERVER" game/openvibe.games/bin/server.dll
    say "installed patched Windows DLLs"
    if [[ -x tools/verify-openvibe-dll-content.sh ]]; then
      tools/verify-openvibe-dll-content.sh || true
    else
      strings -a game/openvibe.games/bin/client.dll | grep -E 'ov_join|ov_menu|OpenVibe' | head || true
    fi
    exit 0
  else
    warn "DLLs were present but do not contain OpenVibe strings; not installing stale/stock DLLs"
  fi
else
  warn "no client.dll/server.dll artifact available yet"
fi

say "next useful tails:"
for f in \
  "$OUT/full-run.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-source-sdk-2013.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-curl-master-zip.log" \
  "$OUT/openvibe-windows-build-debug/bootstrap-git-clone-master.log" \
  "$OUT/openvibe-windows-build-debug/build-sdk-windows.log"; do
  if [[ -f "$f" ]]; then
    echo "----- $f -----"
    tail -n 80 "$f" || true
  fi
done
exit 2
