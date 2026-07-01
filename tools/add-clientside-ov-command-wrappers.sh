#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
RUN_BUILD="${RUN_BUILD:-1}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

echo "[openvibe] next phase: add clientside ov_* wrappers for server commands"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

CLIENT_SRC="$ROOT/sdk/openvibe/client/hl2mp/openvibe_client.cpp"

if [[ ! -f "$CLIENT_SRC" ]]; then
  echo "Missing $CLIENT_SRC" >&2
  exit 1
fi

cp "$CLIENT_SRC" "$CLIENT_SRC.bak.$STAMP"

python3 <<'PY'
from pathlib import Path

p = Path("sdk/openvibe/client/hl2mp/openvibe_client.cpp")
s = p.read_text()

# Keep the top comment accurate.
s = s.replace(
    "// - ov_open_url: small convenience command for opening openvibe.games.\n",
    "// - ov_open_url: small convenience command for opening openvibe.games.\n"
    "// - clientside ov_* wrappers that forward dev/test commands to the server.\n",
)

start = "// OPENVIBE_CLIENT_SERVER_COMMAND_FORWARDERS_BEGIN"
end = "// OPENVIBE_CLIENT_SERVER_COMMAND_FORWARDERS_END"

# Remove any older generated copy of this block.
while start in s and end in s:
    a = s.index(start)
    b = s.index(end, a) + len(end)
    # Also consume one trailing newline if present.
    if b < len(s) and s[b:b+1] == "\n":
        b += 1
    s = s[:a].rstrip() + "\n\n" + s[b:].lstrip()

block = r'''
// OPENVIBE_CLIENT_SERVER_COMMAND_FORWARDERS_BEGIN
//
// These are CLIENTDLL console commands with the same user-facing names as the
// server-side OpenVibe dev commands. Client consoles do not list GameDLL-only
// commands, so these wrappers forward through the engine's built-in "cmd"
// command to the connected server.
//
// Examples from the client console after connecting:
//   ov_js_status
//   ov_js_cmd smoke
//   ov_js_fire Initialize
//   ov_prophunt_disguise can
//   ov_fortwars_spawn crate
//
static void OV_ClientForwardServerCommand( const char *pszCommandName, const CCommand &args )
{
	if ( !pszCommandName || !pszCommandName[0] )
		return;

	char szCommand[1024];

	if ( args.ArgC() >= 2 )
	{
		Q_snprintf( szCommand, sizeof( szCommand ), "cmd %s %s\n", pszCommandName, args.ArgS() );
	}
	else
	{
		Q_snprintf( szCommand, sizeof( szCommand ), "cmd %s\n", pszCommandName );
	}

	Msg( "[OV] forwarding to server: %s", szCommand );
	engine->ClientCmd_Unrestricted( szCommand );
}

static void OV_ClientHelp_f( const CCommand &args )
{
	Msg( "\nOpenVibe client commands:\n" );
	Msg( "  ov_help\n" );
	Msg( "  ov_join <hub|prophunt|deathrun|fortwars|traitortown>\n" );
	Msg( "  ov_auth_steam\n" );
	Msg( "  ov_open_url [url]\n" );
	Msg( "\nOpenVibe server-forwarding commands, requires a server connection:\n" );
	Msg( "  ov_js_status\n" );
	Msg( "  ov_js_reload\n" );
	Msg( "  ov_js_fire <HookName>\n" );
	Msg( "  ov_js_cmd <text>\n" );
	Msg( "  ov_prophunt_disguise <can|crate|barrel|chair|bucket>\n" );
	Msg( "  ov_prophunt_reset_disguise\n" );
	Msg( "  ov_fortwars_spawn <crate|barrel|pallet|fence|sheet>\n\n" );
}

static ConCommand ov_help_cmd(
	"ov_help",
	OV_ClientHelp_f,
	"List OpenVibe client and server-forwarding commands.",
	FCVAR_CLIENTDLL );

static void OV_JSStatus_Client_f( const CCommand &args )
{
	OV_ClientForwardServerCommand( "ov_js_status", args );
}

static ConCommand ov_js_status_client_cmd(
	"ov_js_status",
	OV_JSStatus_Client_f,
	"Forward ov_js_status to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_JSReload_Client_f( const CCommand &args )
{
	OV_ClientForwardServerCommand( "ov_js_reload", args );
}

static ConCommand ov_js_reload_client_cmd(
	"ov_js_reload",
	OV_JSReload_Client_f,
	"Forward ov_js_reload to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_JSFire_Client_f( const CCommand &args )
{
	if ( args.ArgC() < 2 )
	{
		Msg( "Usage: ov_js_fire <HookName>\n" );
		return;
	}

	OV_ClientForwardServerCommand( "ov_js_fire", args );
}

static ConCommand ov_js_fire_client_cmd(
	"ov_js_fire",
	OV_JSFire_Client_f,
	"Forward ov_js_fire to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_JSCmd_Client_f( const CCommand &args )
{
	if ( args.ArgC() < 2 )
	{
		Msg( "Usage: ov_js_cmd <text>\n" );
		return;
	}

	OV_ClientForwardServerCommand( "ov_js_cmd", args );
}

static ConCommand ov_js_cmd_client_cmd(
	"ov_js_cmd",
	OV_JSCmd_Client_f,
	"Forward ov_js_cmd to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_PropHuntDisguise_Client_f( const CCommand &args )
{
	if ( args.ArgC() < 2 )
	{
		Msg( "Usage: ov_prophunt_disguise <can|crate|barrel|chair|bucket>\n" );
		return;
	}

	OV_ClientForwardServerCommand( "ov_prophunt_disguise", args );
}

static ConCommand ov_prophunt_disguise_client_cmd(
	"ov_prophunt_disguise",
	OV_PropHuntDisguise_Client_f,
	"Forward Prop Hunt disguise command to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_PropHuntResetDisguise_Client_f( const CCommand &args )
{
	OV_ClientForwardServerCommand( "ov_prophunt_reset_disguise", args );
}

static ConCommand ov_prophunt_reset_disguise_client_cmd(
	"ov_prophunt_reset_disguise",
	OV_PropHuntResetDisguise_Client_f,
	"Forward Prop Hunt reset-disguise command to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );

static void OV_FortWarsSpawn_Client_f( const CCommand &args )
{
	if ( args.ArgC() < 2 )
	{
		Msg( "Usage: ov_fortwars_spawn <crate|barrel|pallet|fence|sheet>\n" );
		return;
	}

	OV_ClientForwardServerCommand( "ov_fortwars_spawn", args );
}

static ConCommand ov_fortwars_spawn_client_cmd(
	"ov_fortwars_spawn",
	OV_FortWarsSpawn_Client_f,
	"Forward Fort Wars prop-spawn command to the connected OpenVibe server.",
	FCVAR_CLIENTDLL );
// OPENVIBE_CLIENT_SERVER_COMMAND_FORWARDERS_END
'''

s = s.rstrip() + "\n\n" + block.strip() + "\n"
p.write_text(s)
PY

echo "[openvibe] clientside ov_* forwarding commands written"

echo "[openvibe] applying SDK patch"
tools/apply-openvibe-sdk.sh

SDK_CLIENT="$SDK/src/game/client/hl2mp/openvibe_client.cpp"

echo "[openvibe] verifying client command registrations"
grep -nE 'ConCommand ov_(help|js_status|js_reload|js_fire|js_cmd|prophunt_disguise|prophunt_reset_disguise|fortwars_spawn)' "$SDK_CLIENT" || true

if [[ "$RUN_BUILD" == "1" ]]; then
  echo "[openvibe] building SDK"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

  echo "[openvibe] setting up OpenVibe bin links"
  tools/setup-openvibe-bin.sh

  echo
  echo "[openvibe] clientside ov_* wrapper phase complete."
  echo
  echo "Restart the client/game so the rebuilt client.so is loaded, then test in CLIENT console:"
  echo "  ov_help"
  echo "  ov_join hub"
  echo "  ov_js_status"
  echo "  ov_js_cmd smoke"
  echo "  ov_js_cmd help"
  echo
  echo "These forwarding commands require you to be connected to a server:"
  echo "  connect 127.0.0.1:27015"
else
  echo "[openvibe] RUN_BUILD=0, skipped build"
fi
