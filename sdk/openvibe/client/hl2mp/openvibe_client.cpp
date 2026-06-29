// OpenVibe: Source client integration.
//
// This file belongs to the HL2MP client DLL.  It provides:
// - ov_join <mode>: ask the OpenVibe API for a travel reservation, store the
//   join token in userinfo, then connect to the selected Source server.
// - ov_auth_steam: request a Steam Web API auth ticket and send it to the
//   OpenVibe API for production authentication.
// - ov_open_url: small convenience command for opening openvibe.games.
// - clientside ov_* wrappers that forward dev/test commands to the server.

#include "cbase.h"
#include "cdll_client_int.h"
#include "ienginevgui.h"

#include "steam/steam_api.h"
#include "steam/isteamfriends.h"
#include "steam/isteamhttp.h"
#include "steam/isteamuser.h"

// memdbgon must be the last include file in a .cpp file.
#include "tier0/memdbgon.h"

extern CSteamAPIContext *steamapicontext;

static ConVar ov_api_url(
	"ov_api_url",
	"http://127.0.0.1:3000",
	FCVAR_ARCHIVE,
	"OpenVibe API base URL." );

static ConVar ov_dev_steamid(
	"ov_dev_steamid",
	"76561198000000000",
	FCVAR_ARCHIVE,
	"Fallback SteamID used when Steam is unavailable in local development." );

static ConVar ov_join_local_fallback(
	"ov_join_local_fallback",
	"1",
	FCVAR_ARCHIVE,
	"If API travel fails, connect to the conventional local OpenVibe port for the requested mode." );

static ConVar ov_join_token(
	"ov_join_token",
	"",
	FCVAR_USERINFO | FCVAR_ARCHIVE,
	"Short-lived OpenVibe join token sent to destination servers." );

static ConVar ov_auth_identity(
	"ov_auth_identity",
	"openvibe.games",
	FCVAR_ARCHIVE,
	"Steam Web API ticket identity for OpenVibe backend authentication." );

static const char *s_OpenVibeModes[] =
{
	"hub",
	"prophunt",
	"deathrun",
	"fortwars",
	"traitortown",
};

static bool OV_IsModeAllowed( const char *pszMode )
{
	for ( int i = 0; i < ARRAYSIZE( s_OpenVibeModes ); ++i )
	{
		if ( !Q_stricmp( pszMode, s_OpenVibeModes[i] ) )
			return true;
	}
	return false;
}

static const char *OV_LocalConnectForMode( const char *pszMode )
{
	if ( !Q_stricmp( pszMode, "hub" ) ) return "127.0.0.1:27015";
	if ( !Q_stricmp( pszMode, "prophunt" ) ) return "127.0.0.1:27016";
	if ( !Q_stricmp( pszMode, "deathrun" ) ) return "127.0.0.1:27017";
	if ( !Q_stricmp( pszMode, "fortwars" ) ) return "127.0.0.1:27018";
	if ( !Q_stricmp( pszMode, "traitortown" ) ) return "127.0.0.1:27019";
	return "127.0.0.1:27015";
}

static void OV_GetSteamIdString( char *pszOut, size_t nOut )
{
	if ( steamapicontext && steamapicontext->SteamUser() && steamapicontext->SteamUser()->BLoggedOn() )
	{
		Q_snprintf( pszOut, nOut, "%llu", steamapicontext->SteamUser()->GetSteamID().ConvertToUint64() );
		return;
	}

	Q_strncpy( pszOut, ov_dev_steamid.GetString(), nOut );
}

static bool OV_ExtractJsonString( const char *pszJson, const char *pszKey, char *pszOut, size_t nOut )
{
	char szNeedle[128];
	Q_snprintf( szNeedle, sizeof( szNeedle ), "\"%s\":\"", pszKey );

	const char *pszStart = Q_strstr( pszJson, szNeedle );
	if ( !pszStart )
		return false;

	pszStart += Q_strlen( szNeedle );
	const char *pszEnd = Q_strstr( pszStart, "\"" );
	if ( !pszEnd )
		return false;

	const int nLen = pszEnd - pszStart;
	if ( nLen <= 0 || nLen >= (int)nOut )
		return false;

	Q_strncpy( pszOut, pszStart, nLen + 1 );
	pszOut[nLen] = '\0';
	return true;
}

static bool OV_ExtractJsonBool( const char *pszJson, const char *pszKey )
{
	char szNeedle[128];
	Q_snprintf( szNeedle, sizeof( szNeedle ), "\"%s\":true", pszKey );
	return Q_strstr( pszJson, szNeedle ) != NULL;
}

static void OV_ConnectWithReservation( const char *pszConnect, const char *pszToken )
{
	char szCommand[1024];
	Q_snprintf(
		szCommand,
		sizeof( szCommand ),
		"setinfo ov_join_token \"%s\"\nconnect %s\n",
		pszToken,
		pszConnect );

	Msg( "[OV] Connecting to %s with join token.\n", pszConnect );
	engine->ClientCmd_Unrestricted( szCommand );
}

class COpenVibeTravelClient
{
public:
	COpenVibeTravelClient() : m_hRequest( INVALID_HTTPREQUEST_HANDLE )
	{
		m_szMode[0] = '\0';
	}

	void RequestTravel( const char *pszMode )
	{
		if ( !OV_IsModeAllowed( pszMode ) )
		{
			Warning( "[OV] Unknown mode '%s'. Use hub, prophunt, deathrun, fortwars, or traitortown.\n", pszMode );
			return;
		}

		Q_strncpy( m_szMode, pszMode, sizeof( m_szMode ) );

		if ( !steamapicontext || !steamapicontext->SteamHTTP() )
		{
			Warning( "[OV] Steam HTTP unavailable; using local fallback for %s.\n", pszMode );
			LocalFallback();
			return;
		}

		char szSteamId[32];
		OV_GetSteamIdString( szSteamId, sizeof( szSteamId ) );

		char szUrl[512];
		Q_snprintf( szUrl, sizeof( szUrl ), "%s/v1/travel/request", ov_api_url.GetString() );

		char szBody[256];
		Q_snprintf( szBody, sizeof( szBody ), "{\"steamId\":\"%s\",\"mode\":\"%s\"}", szSteamId, pszMode );

		ReleaseRequest();
		m_hRequest = steamapicontext->SteamHTTP()->CreateHTTPRequest( k_EHTTPMethodPOST, szUrl );
		if ( m_hRequest == INVALID_HTTPREQUEST_HANDLE )
		{
			Warning( "[OV] Could not create travel HTTP request.\n" );
			LocalFallback();
			return;
		}

		steamapicontext->SteamHTTP()->SetHTTPRequestHeaderValue( m_hRequest, "Accept", "application/json" );
		steamapicontext->SteamHTTP()->SetHTTPRequestRawPostBody(
			m_hRequest,
			"application/json",
			(uint8 *)szBody,
			Q_strlen( szBody ) );
		steamapicontext->SteamHTTP()->SetHTTPRequestNetworkActivityTimeout( m_hRequest, 8 );
		steamapicontext->SteamHTTP()->SetHTTPRequestAbsoluteTimeoutMS( m_hRequest, 10000 );

		SteamAPICall_t hCall = k_uAPICallInvalid;
		if ( !steamapicontext->SteamHTTP()->SendHTTPRequest( m_hRequest, &hCall ) || hCall == k_uAPICallInvalid )
		{
			Warning( "[OV] Could not send travel HTTP request.\n" );
			ReleaseRequest();
			LocalFallback();
			return;
		}

		m_Callback.Set( hCall, this, &COpenVibeTravelClient::OnTravelResponse );
		Msg( "[OV] Travel request sent for mode '%s'.\n", pszMode );
	}

private:
	void OnTravelResponse( HTTPRequestCompleted_t *pResult, bool bIOFailure )
	{
		if ( !pResult || bIOFailure || !pResult->m_bRequestSuccessful ||
			 pResult->m_eStatusCode < k_EHTTPStatusCode200OK ||
			 pResult->m_eStatusCode >= k_EHTTPStatusCode300MultipleChoices )
		{
			Warning( "[OV] Travel request failed.\n" );
			ReleaseRequest();
			LocalFallback();
			return;
		}

		char szBody[4096];
		szBody[0] = '\0';

		uint32 nBodySize = 0;
		if ( steamapicontext->SteamHTTP()->GetHTTPResponseBodySize( pResult->m_hRequest, &nBodySize ) &&
			 nBodySize > 0 &&
			 nBodySize < sizeof( szBody ) )
		{
			if ( steamapicontext->SteamHTTP()->GetHTTPResponseBodyData(
				 pResult->m_hRequest,
				 (uint8 *)szBody,
				 nBodySize ) )
			{
				szBody[nBodySize] = '\0';
			}
		}

		char szConnect[256];
		char szToken[256];
		if ( !OV_ExtractJsonString( szBody, "connect", szConnect, sizeof( szConnect ) ) ||
			 !OV_ExtractJsonString( szBody, "joinToken", szToken, sizeof( szToken ) ) )
		{
			Warning( "[OV] Travel response did not contain connect/joinToken: %s\n", szBody );
			ReleaseRequest();
			LocalFallback();
			return;
		}

		ReleaseRequest();
		OV_ConnectWithReservation( szConnect, szToken );
	}

	void LocalFallback()
	{
		if ( !ov_join_local_fallback.GetBool() )
			return;

		char szToken[128];
		Q_snprintf( szToken, sizeof( szToken ), "local-dev-%s", m_szMode[0] ? m_szMode : "hub" );
		OV_ConnectWithReservation( OV_LocalConnectForMode( m_szMode ), szToken );
	}

	void ReleaseRequest()
	{
		if ( m_hRequest != INVALID_HTTPREQUEST_HANDLE && steamapicontext && steamapicontext->SteamHTTP() )
		{
			steamapicontext->SteamHTTP()->ReleaseHTTPRequest( m_hRequest );
		}
		m_hRequest = INVALID_HTTPREQUEST_HANDLE;
	}

	char m_szMode[32];
	HTTPRequestHandle m_hRequest;
	CCallResult< COpenVibeTravelClient, HTTPRequestCompleted_t > m_Callback;
};

static COpenVibeTravelClient g_OpenVibeTravelClient;

static void OV_Join_f( const CCommand &args )
{
	if ( args.ArgC() < 2 )
	{
		Msg( "Usage: ov_join <hub|prophunt|deathrun|fortwars|traitortown>\n" );
		return;
	}

	g_OpenVibeTravelClient.RequestTravel( args[1] );
}

static ConCommand ov_join_cmd(
	"ov_join",
	OV_Join_f,
	"Reserve an OpenVibe travel token and connect to a game mode server.",
	FCVAR_CLIENTDLL );

class COpenVibeSteamAuthClient
{
public:
	COpenVibeSteamAuthClient() :
		m_hRequest( INVALID_HTTPREQUEST_HANDLE ),
		m_CallbackTicket( this, &COpenVibeSteamAuthClient::OnTicket )
	{
	}

	void RequestAuth()
	{
		if ( !steamapicontext || !steamapicontext->SteamUser() )
		{
			Warning( "[OV Auth] Steam user interface unavailable.\n" );
			return;
		}

		steamapicontext->SteamUser()->GetAuthTicketForWebApi( ov_auth_identity.GetString() );
		Msg( "[OV Auth] Requested Steam Web API ticket.\n" );
	}

private:
	void OnTicket( GetTicketForWebApiResponse_t *pTicket )
	{
		if ( !pTicket || pTicket->m_eResult != k_EResultOK || pTicket->m_cubTicket <= 0 )
		{
			Warning( "[OV Auth] Steam did not provide a valid Web API ticket.\n" );
			return;
		}

		char szTicketHex[GetTicketForWebApiResponse_t::k_nCubTicketMaxLength * 2 + 1];
		for ( int i = 0; i < pTicket->m_cubTicket; ++i )
		{
			Q_snprintf( szTicketHex + ( i * 2 ), sizeof( szTicketHex ) - ( i * 2 ), "%02x", pTicket->m_rgubTicket[i] );
		}
		szTicketHex[pTicket->m_cubTicket * 2] = '\0';

		PostTicket( szTicketHex );
	}

	void PostTicket( const char *pszTicketHex )
	{
		if ( !steamapicontext || !steamapicontext->SteamHTTP() )
		{
			Warning( "[OV Auth] Steam HTTP unavailable.\n" );
			return;
		}

		char szUrl[512];
		Q_snprintf( szUrl, sizeof( szUrl ), "%s/v1/auth/steam", ov_api_url.GetString() );

		char szBody[GetTicketForWebApiResponse_t::k_nCubTicketMaxLength * 2 + 256];
		Q_snprintf(
			szBody,
			sizeof( szBody ),
			"{\"ticket\":\"%s\",\"identity\":\"%s\"}",
			pszTicketHex,
			ov_auth_identity.GetString() );

		ReleaseRequest();
		m_hRequest = steamapicontext->SteamHTTP()->CreateHTTPRequest( k_EHTTPMethodPOST, szUrl );
		if ( m_hRequest == INVALID_HTTPREQUEST_HANDLE )
			return;

		steamapicontext->SteamHTTP()->SetHTTPRequestHeaderValue( m_hRequest, "Accept", "application/json" );
		steamapicontext->SteamHTTP()->SetHTTPRequestRawPostBody(
			m_hRequest,
			"application/json",
			(uint8 *)szBody,
			Q_strlen( szBody ) );
		steamapicontext->SteamHTTP()->SetHTTPRequestNetworkActivityTimeout( m_hRequest, 8 );
		steamapicontext->SteamHTTP()->SetHTTPRequestAbsoluteTimeoutMS( m_hRequest, 10000 );

		SteamAPICall_t hCall = k_uAPICallInvalid;
		if ( steamapicontext->SteamHTTP()->SendHTTPRequest( m_hRequest, &hCall ) && hCall != k_uAPICallInvalid )
		{
			m_CallbackHTTP.Set( hCall, this, &COpenVibeSteamAuthClient::OnAuthResponse );
		}
		else
		{
			ReleaseRequest();
		}
	}

	void OnAuthResponse( HTTPRequestCompleted_t *pResult, bool bIOFailure )
	{
		char szBody[4096];
		szBody[0] = '\0';

		if ( !bIOFailure && pResult && pResult->m_bRequestSuccessful )
		{
			uint32 nBodySize = 0;
			if ( steamapicontext->SteamHTTP()->GetHTTPResponseBodySize( pResult->m_hRequest, &nBodySize ) &&
				 nBodySize > 0 &&
				 nBodySize < sizeof( szBody ) )
			{
				if ( steamapicontext->SteamHTTP()->GetHTTPResponseBodyData(
					 pResult->m_hRequest,
					 (uint8 *)szBody,
					 nBodySize ) )
				{
					szBody[nBodySize] = '\0';
				}
			}
		}

		if ( OV_ExtractJsonBool( szBody, "authenticated" ) )
		{
			Msg( "[OV Auth] Steam authentication accepted by OpenVibe API.\n" );
		}
		else
		{
			Warning( "[OV Auth] OpenVibe API rejected or could not validate Steam ticket: %s\n", szBody );
		}

		ReleaseRequest();
	}

	void ReleaseRequest()
	{
		if ( m_hRequest != INVALID_HTTPREQUEST_HANDLE && steamapicontext && steamapicontext->SteamHTTP() )
		{
			steamapicontext->SteamHTTP()->ReleaseHTTPRequest( m_hRequest );
		}
		m_hRequest = INVALID_HTTPREQUEST_HANDLE;
	}

	HTTPRequestHandle m_hRequest;
	CCallback< COpenVibeSteamAuthClient, GetTicketForWebApiResponse_t > m_CallbackTicket;
	CCallResult< COpenVibeSteamAuthClient, HTTPRequestCompleted_t > m_CallbackHTTP;
};

static COpenVibeSteamAuthClient g_OpenVibeSteamAuthClient;

static void OV_AuthSteam_f( const CCommand &args )
{
	g_OpenVibeSteamAuthClient.RequestAuth();
}

static ConCommand ov_auth_steam_cmd(
	"ov_auth_steam",
	OV_AuthSteam_f,
	"Request a Steam Web API auth ticket and authenticate with OpenVibe.",
	FCVAR_CLIENTDLL );

static void OV_OpenURL_f( const CCommand &args )
{
	const char *pszUrl = args.ArgC() >= 2 ? args[1] : "https://openvibe.games";
	if ( steamapicontext && steamapicontext->SteamFriends() )
	{
		steamapicontext->SteamFriends()->ActivateGameOverlayToWebPage( pszUrl );
		return;
	}

	engine->ClientCmd_Unrestricted( VarArgs( "echo Open %s in your browser.\n", pszUrl ) );
}

static ConCommand ov_open_url_cmd(
	"ov_open_url",
	OV_OpenURL_f,
	"Open the OpenVibe website in the Steam overlay.",
	FCVAR_CLIENTDLL );

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
