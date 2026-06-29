#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
: "${BRANCH:=codex/openvibe-next-steps}"

say() { printf '\n\033[1;36m[openvibe]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[openvibe warn]\033[0m %s\n' "$*"; }

cd "$ROOT"

say "next phase: validate Proton DLL content + add build/fetch helper"
say "root=$ROOT"
say "branch=$BRANCH"

mkdir -p tools docs game/openvibe.games/cfg

cat > tools/verify-openvibe-dll-content.sh <<'VERIFY'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
CLIENT="$ROOT/game/openvibe.games/bin/client.dll"
SERVER="$ROOT/game/openvibe.games/bin/server.dll"

ok=0
fail=0

line() { printf '%s\n' "--------------------------------------------------------------------------------"; }
check_file() {
  local label="$1" file="$2"; shift 2
  line
  echo "[$label] $file"
  if [[ ! -f "$file" ]]; then
    echo "[missing] $file"
    fail=$((fail+1))
    return
  fi
  file "$file" || true
  stat -c '[size] %s bytes' "$file" || true
  sha256sum "$file" | awk '{print "[sha256] "$1}' || true

  local missing=0
  for needle in "$@"; do
    if strings -a "$file" | grep -Fq -- "$needle"; then
      echo "[ok] contains string: $needle"
    else
      echo "[miss] does not contain string: $needle"
      missing=1
    fi
  done

  if [[ "$missing" -eq 0 ]]; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
  fi
}

check_file "Windows/Proton client.dll" "$CLIENT" \
  "ov_join" \
  "ov_auth_steam" \
  "ov_menu" \
  "OpenVibe"

check_file "Windows/Proton server.dll" "$SERVER" \
  "ov_js_status" \
  "ov_js_cmd" \
  "OpenVibe"

line
if [[ "$fail" -eq 0 ]]; then
  echo "[openvibe] DLL content check passed. Proton should load OpenVibe client/server commands if the mod path is correct."
  exit 0
fi

cat <<'MSG'
[openvibe] DLL content check failed.

Meaning:
  - client.dll/server.dll may exist, but they are probably old/stock/unpatched DLLs.
  - If the in-game console says Unknown command "ov_join" or "ov_menu", this is the first thing to fix.

Fix:
  - Trigger the Windows GitHub Actions build, download its artifact, and install the resulting DLLs.
  - Run: tools/gh-windows-build-and-install.sh
MSG
exit 2
VERIFY
chmod +x tools/verify-openvibe-dll-content.sh

cat > tools/collect-proton-openvibe-debug.sh <<'COLLECT'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MOD="$ROOT/game/openvibe.games"
STEAM_APP_ID="${SteamAppId:-243750}"
PATTERN='OpenVibe|ov_|client\.dll|server\.dll|GameDLL|ClientDLL|Unknown command|failed|Failed|unable|Unable|error|Error'

printf '[openvibe] collecting Proton/Source debug hints\n'
printf 'root=%s\n' "$ROOT"
printf 'mod=%s\n\n' "$MOD"

candidates=(
  "$MOD/console.log"
  "$MOD/openvibe_proton_console.log"
  "$ROOT/console.log"
  "$ROOT/openvibe_proton_console.log"
  "$HOME/steam-${STEAM_APP_ID}.log"
  "$HOME/steam-${STEAM_APP_ID}.log.last"
)

found=0
for file in "${candidates[@]}"; do
  if [[ -f "$file" ]]; then
    found=1
    echo "--------------------------------------------------------------------------------"
    echo "[log] $file"
    echo "[tail] last matching lines"
    grep -Eia "$PATTERN" "$file" | tail -80 || true
  fi
done

if [[ "$found" -eq 0 ]]; then
  cat <<MSG
No common logs found yet.

Launch with Proton logging enabled:
  OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

Then run this again:
  tools/collect-proton-openvibe-debug.sh
MSG
fi
COLLECT
chmod +x tools/collect-proton-openvibe-debug.sh

cat > tools/gh-windows-build-and-install.sh <<'GHDL'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"

WORKFLOW="${OPENVIBE_WINDOWS_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git branch --show-current)}"
ART_DIR="$ROOT/.tmp/windows-dll-artifact"
MOD_BIN="$ROOT/game/openvibe.games/bin"

if ! command -v gh >/dev/null 2>&1; then
  cat <<MSG
[openvibe] gh is missing.

Install/authenticate it:
  sudo apt update
  sudo apt install gh
  gh auth login

Then rerun:
  tools/gh-windows-build-and-install.sh

Manual fallback:
  Open GitHub Actions -> $WORKFLOW -> Run workflow -> branch $BRANCH
  Download the artifact, then copy client.dll/server.dll into:
    $MOD_BIN
MSG
  exit 127
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "[openvibe] gh is installed but not authenticated. Run: gh auth login" >&2
  exit 126
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "[openvibe] repo=$repo"
echo "[openvibe] workflow=$WORKFLOW"
echo "[openvibe] branch=$BRANCH"

git push origin "$BRANCH"

echo "[openvibe] triggering Windows DLL workflow"
gh workflow run "$WORKFLOW" --ref "$BRANCH"

echo "[openvibe] waiting for workflow run to appear"
run_id=""
for _ in {1..30}; do
  run_id="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId,status -q '.[0].databaseId // empty' 2>/dev/null || true)"
  [[ -n "$run_id" ]] && break
  sleep 2
done

if [[ -z "$run_id" ]]; then
  echo "[openvibe] could not find workflow run. Check GitHub Actions manually." >&2
  exit 1
fi

echo "[openvibe] watching run $run_id"
gh run watch "$run_id" --exit-status

rm -rf "$ART_DIR"
mkdir -p "$ART_DIR"
echo "[openvibe] downloading artifacts to $ART_DIR"
gh run download "$run_id" --dir "$ART_DIR"

client="$(find "$ART_DIR" -iname 'client.dll' -type f | head -n 1 || true)"
server="$(find "$ART_DIR" -iname 'server.dll' -type f | head -n 1 || true)"

if [[ -z "$client" || -z "$server" ]]; then
  echo "[openvibe] artifact did not contain client.dll and server.dll" >&2
  find "$ART_DIR" -maxdepth 5 -type f | sort >&2
  exit 1
fi

mkdir -p "$MOD_BIN"
cp -f "$client" "$MOD_BIN/client.dll"
cp -f "$server" "$MOD_BIN/server.dll"

echo "[openvibe] installed:"
ls -lh "$MOD_BIN/client.dll" "$MOD_BIN/server.dll"

tools/verify-openvibe-dll-content.sh

echo "[openvibe] done. Now test:"
echo "  OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015"
echo "Then in the game console:"
echo "  ov_join hub"
echo "  ov_menu"
echo "  ov_menu_servers"
GHDL
chmod +x tools/gh-windows-build-and-install.sh

cat > game/openvibe.games/cfg/openvibe_proton_client.cfg <<'CFG'
echo "==== OpenVibe Proton fallback cfg loaded ===="
echo "This cfg only adds ovp_* fallback aliases. Real ov_join/ov_menu must come from client.dll."
echo "Try real commands first: ov_join hub ; ov_menu ; ov_menu_servers"
alias ovp_help "echo OpenVibe Proton fallback commands: ovp_join_hub ovp_join_prophunt ovp_join_deathrun ovp_join_fortwars ovp_join_traitortown"
alias ovp_join_hub "connect 127.0.0.1:27015"
alias ovp_join_prophunt "connect 127.0.0.1:27016"
alias ovp_join_deathrun "connect 127.0.0.1:27017"
alias ovp_join_fortwars "connect 127.0.0.1:27018"
alias ovp_join_traitortown "connect 127.0.0.1:27019"
CFG

cat > docs/PROTON_CLIENT_DLL_DEBUG.md <<'DOC'
# Proton client DLL debug path

Proton runs the Windows `hl2.exe`, so it loads:

```text
game/openvibe.games/bin/client.dll
game/openvibe.games/bin/server.dll
```

It cannot load the Linux modules:

```text
game/openvibe.games/bin/linux64/client.so
game/openvibe.games/bin/linux64/server.so
```

If the in-game console says `Unknown command "ov_join"` or `Unknown command "ov_menu"`, then one of these is true:

1. `client.dll` is missing.
2. `client.dll` is stock/old and does not contain the OpenVibe commands.
3. The mod path is wrong and `hl2.exe` is not loading `game/openvibe.games`.
4. The DLL failed during load.

Useful commands:

```bash
tools/verify-openvibe-dll-content.sh
OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015
tools/collect-proton-openvibe-debug.sh
```

Safe fallback aliases are prefixed with `ovp_` so they do not mask real client DLL commands:

```text
ovp_help
ovp_join_hub
ovp_join_prophunt
ovp_join_deathrun
ovp_join_fortwars
ovp_join_traitortown
```
DOC

# Rewrite run-client-proton.sh with better DLL-aware diagnostics and logging.
cat > tools/run-client-proton.sh <<'PROTON'
#!/bin/bash
# OpenVibe: Source - Game Client Launcher via GE-Proton10-34
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
STEAM_PATH="${OPENVIBE_STEAM_PATH:-/mnt/6tb/ssd_offload/home/workstation/.steam/debian-installation}"
GE_PROTON="${OPENVIBE_GE_PROTON:-$STEAM_PATH/compatibilitytools.d/GE-Proton10-34}"
STEAM_COMPAT_DATA="${OPENVIBE_STEAM_COMPAT_DATA:-$STEAM_PATH/steamapps/compatdata/243750}"
HL2_EXE="${OPENVIBE_HL2_EXE:-/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2.exe}"
GAME_DIR="${OPENVIBE_GAME_DIR:-$ROOT/game/openvibe.games}"
CLIENT_DLL="$GAME_DIR/bin/client.dll"
SERVER_DLL="$GAME_DIR/bin/server.dll"

if [ ! -f "$HL2_EXE" ]; then
  echo "ERROR: hl2.exe not found at $HL2_EXE" >&2
  exit 1
fi

if [ ! -d "$GE_PROTON" ]; then
  echo "ERROR: GE-Proton not found at $GE_PROTON" >&2
  exit 1
fi

CONNECT_ARGS=""
if [ "${1:-}" != "" ] && [ "${2:-}" != "" ]; then
  CONNECT_ARGS="+connect $1:$2"
fi

echo "Launching OpenVibe: Source via Proton..."
echo "  Game:   $GAME_DIR"
echo "  Proton: $GE_PROTON"
echo "  HL2:    $HL2_EXE"
[ -n "$CONNECT_ARGS" ] && echo "  Connect: $CONNECT_ARGS"

if [ -f "$CLIENT_DLL" ] && command -v strings >/dev/null 2>&1 && strings -a "$CLIENT_DLL" | grep -Fq "ov_join"; then
  echo "  Client DLL: patched OpenVibe client.dll detected"
elif [ -f "$CLIENT_DLL" ]; then
  echo "  WARNING: client.dll exists, but ov_join string was not found. It may be stock/old." >&2
else
  echo "  WARNING: client.dll missing. Proton will not have OpenVibe client commands." >&2
fi

if [ ! -f "$SERVER_DLL" ]; then
  echo "  WARNING: server.dll missing for Windows listen/server use." >&2
fi

mkdir -p "$STEAM_COMPAT_DATA"

export DISPLAY="${DISPLAY:-:0}"
export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM_PATH"
export STEAM_COMPAT_DATA_PATH="$STEAM_COMPAT_DATA"
export SteamAppId="${SteamAppId:-243750}"
export PROTON_LOG="${OPENVIBE_PROTON_LOG:-${PROTON_LOG:-1}}"
export DXVK_ASYNC="${DXVK_ASYNC:-1}"

exec "$GE_PROTON/proton" waitforexitandrun \
  "$HL2_EXE" \
  -game "$GAME_DIR" \
  -console -dev -condebug -novid -sw -w 1280 -h 720 \
  -port 27115 -clientport 27105 \
  +developer 1 \
  +con_logfile openvibe_proton_console.log \
  +exec openvibe_proton_client.cfg \
  $CONNECT_ARGS
PROTON
chmod +x tools/run-client-proton.sh

# Improve platform checker if present by appending a DLL content reminder safely.
if [[ -f tools/check-openvibe-platform-binaries.sh ]] && ! grep -Fq "verify-openvibe-dll-content" tools/check-openvibe-platform-binaries.sh; then
  cat >> tools/check-openvibe-platform-binaries.sh <<'EXTRA'

echo
echo "[openvibe] Deep DLL content check:"
if [[ -x "${OPENVIBE_ROOT:-$HOME/src/openvibe-source}/tools/verify-openvibe-dll-content.sh" ]]; then
  "${OPENVIBE_ROOT:-$HOME/src/openvibe-source}/tools/verify-openvibe-dll-content.sh" || true
else
  echo "tools/verify-openvibe-dll-content.sh missing"
fi
EXTRA
fi

say "running DLL content validation now"
if tools/verify-openvibe-dll-content.sh; then
  say "existing DLLs look patched"
else
  warn "existing DLLs do not look patched; trigger/download fresh Windows DLLs next"
fi

say "git status"
git status --short

say "stage/commit/push helper changes"
git add tools/verify-openvibe-dll-content.sh \
        tools/collect-proton-openvibe-debug.sh \
        tools/gh-windows-build-and-install.sh \
        tools/run-client-proton.sh \
        tools/check-openvibe-platform-binaries.sh \
        game/openvibe.games/cfg/openvibe_proton_client.cfg \
        docs/PROTON_CLIENT_DLL_DEBUG.md

if git diff --cached --quiet; then
  say "no helper changes to commit"
else
  git commit -m "Add Proton DLL validation and artifact install helpers"
  git push origin "$BRANCH"
fi

say "next actions"
cat <<NEXT
1. Install/auth gh if missing:
   sudo apt update && sudo apt install gh
   gh auth login

2. Trigger/download/install patched Windows DLLs:
   tools/gh-windows-build-and-install.sh

3. Launch Proton with logs:
   OPENVIBE_PROTON_LOG=1 OPENVIBE_CLIENT_MODE=proton tools/run-client-auto.sh 127.0.0.1 27015

4. In game console, test real client DLL commands:
   ov_join hub
   ov_menu
   ov_menu_servers

5. If commands are still unknown:
   tools/verify-openvibe-dll-content.sh
   tools/collect-proton-openvibe-debug.sh
NEXT
