#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"

if [[ ! -d "$SDK/src/game/client/hl2mp" || ! -d "$SDK/src/game/server/hl2mp" ]]; then
  echo "Source SDK 2013 checkout not found at $SDK" >&2
  echo "Set OPENVIBE_SDK=/path/to/source-sdk-2013 if it lives elsewhere." >&2
  exit 1
fi

copy_file() {
  local src="$1"
  local dst="$2"
  install -D -m 0644 "$src" "$dst"
  echo "[openvibe-sdk] copied ${dst#$SDK/}"
}

copy_file "$ROOT/sdk/openvibe/client/hl2mp/openvibe_client.cpp" \
  "$SDK/src/game/client/hl2mp/openvibe_client.cpp"
copy_file "$ROOT/sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp" \
  "$SDK/src/game/client/hl2mp/vgui_openvibe_menu.cpp"
copy_file "$ROOT/sdk/openvibe/server/hl2mp/openvibe_server.cpp" \
  "$SDK/src/game/server/hl2mp/openvibe_server.cpp"

CLIENT_VPC="$SDK/src/game/client/client_hl2mp.vpc"
SERVER_VPC="$SDK/src/game/server/server_hl2mp.vpc"
HL2MP_CLIENT="$SDK/src/game/server/hl2mp/hl2mp_client.cpp"

perl -0pi -e 's/^.*hl2mp\\openvibe_client\.cpp.*\n//mg; s/^.*hl2mp\\vgui_openvibe_menu\.cpp.*\n//mg; s/(\$File\s+"hl2mp\\clientmode_hl2mpnormal\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_client.cpp"\n\t\t\t\$File\t"hl2mp\\vgui_openvibe_menu.cpp"\n/s' "$CLIENT_VPC"
echo "[openvibe-sdk] patched client_hl2mp.vpc"

perl -0pi -e 's/^.*hl2mp\\openvibe_server\.cpp.*\n//mg; s/(\$File\s+"hl2mp\\hl2mp_player\.h"\n)/$1\t\t\t\$File\t"hl2mp\\openvibe_server.cpp"\n/s' "$SERVER_VPC"
echo "[openvibe-sdk] patched server_hl2mp.vpc"

if ! grep -q 'OpenVibe_OnClientActive' "$HL2MP_CLIENT"; then
  sed -i '/void Host_Say/a void OpenVibe_OnClientActive( CHL2MP_Player *pPlayer );' "$HL2MP_CLIENT"
  sed -i '/FinishClientPutInServer( pPlayer );/a \tOpenVibe_OnClientActive( pPlayer );' "$HL2MP_CLIENT"
  echo "[openvibe-sdk] patched hl2mp_client.cpp arrival hook"
fi

perl -0pi -e 's/[^\S\r\n]*\x0boid OpenVibe_OnClientActive/void OpenVibe_OnClientActive/g; s/\\tOpenVibe_OnClientActive/\tOpenVibe_OnClientActive/g; s/^[ \t]*void OpenVibe_OnClientActive/void OpenVibe_OnClientActive/m' "$HL2MP_CLIENT"

echo "[openvibe-sdk] Source SDK OpenVibe patch applied"
