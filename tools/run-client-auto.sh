#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
MODE="${OPENVIBE_CLIENT_MODE:-auto}" # auto | linux | proton | proton-fallback
GAME_DIR="$ROOT/game/openvibe.games"
LINUX_SO="$GAME_DIR/bin/linux64/client.so"
WIN_DLL="$GAME_DIR/bin/client.dll"

has_linux_client() {
  [[ -f "$LINUX_SO" || -L "$LINUX_SO" ]] && \
  { [[ -n "${OPENVIBE_HL2_LINUX:-}" && -x "$OPENVIBE_HL2_LINUX" ]] || \
    [[ -x "$HOME/.steam/steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]] || \
    [[ -x "$HOME/.local/share/Steam/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]] || \
    [[ -x "/mnt/data-f/SteamLibrary/steamapps/common/Source SDK Base 2013 Multiplayer/hl2_linux" ]]; }
}

has_windows_client_dll() {
  [[ -f "$WIN_DLL" ]]
}

case "$MODE" in
  linux)
    exec "$ROOT/tools/run-client-linux.sh" "${@:-}"
    ;;
  proton)
    if ! has_windows_client_dll; then
      echo "ERROR: Proton mode requires $WIN_DLL for custom in-game client DLL commands/menu." >&2
      echo "Build Windows DLLs first, or use OPENVIBE_CLIENT_MODE=proton-fallback to launch without client DLL." >&2
      exit 1
    fi
    # hl2_win64.exe is the engine our x64 DLLs load into (bin/x64); the 32-bit
    # hl2.exe silently ignores them and boots the stock client.
    exec "$ROOT/tools/run-client-proton-x64.sh" "${@:-}"
    ;;
  proton-fallback)
    echo "WARNING: Proton fallback may launch, but without game/openvibe.games/bin/client.dll the in-game ov_* client commands/menu will not exist." >&2
    exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    ;;
  auto)
    if has_linux_client; then
      echo "[openvibe] auto client mode: native linux"
      exec "$ROOT/tools/run-client-linux.sh" "${@:-}"
    fi
    if has_windows_client_dll; then
      echo "[openvibe] auto client mode: proton with Windows client.dll"
      exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    fi
    echo "[openvibe] auto client mode: proton fallback, but no Windows client.dll exists yet" >&2
    exec "$ROOT/tools/run-client-proton.sh" "${@:-}"
    ;;
  *)
    echo "ERROR: unknown OPENVIBE_CLIENT_MODE=$MODE. Use auto, linux, proton, or proton-fallback." >&2
    exit 1
    ;;
esac
