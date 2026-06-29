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
HL2MP_CLIENTMODE="$SDK/src/game/client/hl2mp/clientmode_hl2mpnormal.cpp"

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

if ! grep -q 'OpenVibe_OnClientModeInit' "$HL2MP_CLIENTMODE"; then
  sed -i '/#include "ienginevgui.h"/a void OpenVibe_OnClientModeInit();' "$HL2MP_CLIENTMODE"
  sed -i '/BaseClass::Init();/a \    OpenVibe_OnClientModeInit();' "$HL2MP_CLIENTMODE"
  echo "[openvibe-sdk] patched clientmode_hl2mpnormal.cpp OpenVibe menu hook"
fi

perl -0pi -e 's/^[ \t]*tOpenVibe_OnClientModeInit\(\);/    OpenVibe_OnClientModeInit();/m' "$HL2MP_CLIENTMODE"

GAMEINTERFACE="$SDK/src/game/server/gameinterface.cpp"
HL2MP_PLAYER="$SDK/src/game/server/hl2mp/hl2mp_player.cpp"

if [[ -f "$GAMEINTERFACE" ]]; then
  if ! grep -q 'OpenVibe_OnFrame' "$GAMEINTERFACE"; then
    sed -i '/CServerGameDLL::GameFrame/i #ifdef HL2MP\nvoid OpenVibe_OnFrame();\n#endif' "$GAMEINTERFACE"
    sed -i '/VPROF( "CServerGameDLL::GameFrame" );/a #ifdef HL2MP\n\tOpenVibe_OnFrame();\n#endif' "$GAMEINTERFACE"
    echo "[openvibe-sdk] patched gameinterface.cpp frame hook"
  fi

  if ! grep -q 'OpenVibe_OnClientDisconnect' "$GAMEINTERFACE"; then
    perl -pi -e 's/void CServerGameClients::ClientDisconnect/#ifdef HL2MP\nvoid OpenVibe_OnClientDisconnect( CBasePlayer *pPlayer );\n#endif\nvoid CServerGameClients::ClientDisconnect/' "$GAMEINTERFACE"
    perl -0777 -pi -e 's/(void CServerGameClients::ClientDisconnect\( edict_t \*pEdict \)\s*\{\s*extern bool\s+g_fGameOver;\s*CBasePlayer \*player = \( CBasePlayer \* \)CBaseEntity::Instance\( pEdict \);)/$1\n#ifdef HL2MP\n\tif ( player ) { OpenVibe_OnClientDisconnect( player ); }\n#endif/g' "$GAMEINTERFACE"
    echo "[openvibe-sdk] patched gameinterface.cpp disconnect hook"
  fi
fi

if [[ -f "$HL2MP_PLAYER" ]]; then
  if ! grep -q 'OpenVibe_OnPlayerDeath' "$HL2MP_PLAYER"; then
    sed -i '/CHL2MP_Player::Event_Killed/i void OpenVibe_OnPlayerDeath( CHL2MP_Player *pPlayer, CBaseEntity *pKiller );' "$HL2MP_PLAYER"
    sed -i '/CTakeDamageInfo subinfo = info;/i \	OpenVibe_OnPlayerDeath( this, info.GetAttacker() );' "$HL2MP_PLAYER"
    echo "[openvibe-sdk] patched hl2mp_player.cpp death hook"
  fi
fi

echo "[openvibe-sdk] Source SDK OpenVibe patch applied"
