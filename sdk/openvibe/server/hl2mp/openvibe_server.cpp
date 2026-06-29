// OpenVibe: Source server integration.
//
// This file belongs to the HL2MP server DLL.  It provides:
// - destination-server join-token validation through /v1/travel/validate
// - ov_prophunt_disguise <prop>: whitelisted prop model disguise
// - ov_prophunt_reset_disguise: restore normal player model
// - ov_fortwars_spawn <prop>: whitelisted prop_physics placement

#include "cbase.h"
#include "hl2mp_player.h"
#include "openvibe_js_server.h"
#include "player.h"
#include "props.h"
#include "util.h"

#include "steam/steam_gameserver.h"
#include "steam/isteamhttp.h"

// Standard library and socket includes for JS bridge

// memdbgon must be the last include file in a .cpp file.
#include "tier0/memdbgon.h"

static ConVar ov_api_url(
	"ov_api_url",
	"http://127.0.0.1:3000",
	FCVAR_GAMEDLL,
	"OpenVibe API base URL." );

static ConVar ov_server_id(
	"ov_server_id",
	"local-hub-27015",
	FCVAR_GAMEDLL,
	"OpenVibe server registry ID for this SRCDS instance." );

static ConVar ov_join_required(
	"ov_join_required",
	"0",
	FCVAR_GAMEDLL,
	"When enabled, players without a valid OpenVibe join token are kicked." );

static ConVar ov_fortwars_build_enabled(
	"ov_fortwars_build_enabled",
	"1",
	FCVAR_GAMEDLL,
	"Allows ov_fortwars_spawn prop placement during the Fort Wars build phase." );

struct OVModelChoice
{
	const char *pszKey;
	const char *pszModel;
	float flScale;
	Vector mins;
	Vector maxs;
};

static const OVModelChoice s_PropDisguises[] =
{
	{ "can", "models/props_junk/garbage_metalcan001a.mdl", 0.85f, Vector( -10, -10, 0 ), Vector( 10, 10, 24 ) },
	{ "crate", "models/props_junk/wood_crate001a.mdl", 0.90f, Vector( -18, -18, 0 ), Vector( 18, 18, 42 ) },
	{ "barrel", "models/props_c17/oildrum001.mdl", 0.85f, Vector( -16, -16, 0 ), Vector( 16, 16, 48 ) },
	{ "chair", "models/props_c17/FurnitureChair001a.mdl", 0.90f, Vector( -18, -18, 0 ), Vector( 18, 18, 42 ) },
	{ "bucket", "models/props_junk/MetalBucket01a.mdl", 0.90f, Vector( -12, -12, 0 ), Vector( 12, 12, 28 ) },
};

static const OVModelChoice s_FortWarsProps[] =
{
	{ "crate", "models/props_junk/wood_crate001a.mdl", 1.0f, Vector( 0, 0, 0 ), Vector( 0, 0, 0 ) },
	{ "barrel", "models/props_c17/oildrum001.mdl", 1.0f, Vector( 0, 0, 0 ), Vector( 0, 0, 0 ) },
	{ "pallet", "models/props_junk/wood_pallet001a.mdl", 1.0f, Vector( 0, 0, 0 ), Vector( 0, 0, 0 ) },
	{ "fence", "models/props_wasteland/wood_fence01a.mdl", 1.0f, Vector( 0, 0, 0 ), Vector( 0, 0, 0 ) },
	{ "sheet", "models/props_c17/FurnitureMattress001a.mdl", 1.0f, Vector( 0, 0, 0 ), Vector( 0, 0, 0 ) },
};

static const OVModelChoice *OV_FindModelChoice( const OVModelChoice *pChoices, int nChoices, const char *pszKey )
{
	for ( int i = 0; i < nChoices; ++i )
	{
		if ( !Q_stricmp( pszKey, pChoices[i].pszKey ) || !Q_stricmp( pszKey, pChoices[i].pszModel ) )
			return &pChoices[i];
	}
	return NULL;
}

static bool OV_ExtractJsonBool( const char *pszJson, const char *pszKey )
{
	char szNeedle[128];
	Q_snprintf( szNeedle, sizeof( szNeedle ), "\"%s\":true", pszKey );
	return Q_strstr( pszJson, szNeedle ) != NULL;
}

static void OV_GetPlayerSteamIDString( CHL2MP_Player *pPlayer, char *pszOut, size_t nOut )
{
	CSteamID steamID;
	if ( pPlayer && pPlayer->GetSteamID( &steamID ) )
	{
		Q_snprintf( pszOut, nOut, "%llu", steamID.ConvertToUint64() );
		return;
	}

	Q_strncpy( pszOut, "0", nOut );
}

class COpenVibeJoinValidation
{
public:
	COpenVibeJoinValidation() :
		m_hRequest( INVALID_HTTPREQUEST_HANDLE ),
		m_iUserID( -1 )
	{
	}

	void Validate( CHL2MP_Player *pPlayer, const char *pszToken )
	{
		if ( !pPlayer || !pszToken || !pszToken[0] )
			return;

		if ( !SteamGameServerHTTP() )
		{
			Warning( "[OV Join] SteamGameServerHTTP unavailable; cannot validate join token.\n" );
			if ( ov_join_required.GetBool() )
				KickUser( pPlayer->GetUserID(), "OpenVibe backend validation unavailable" );
			return;
		}

		char szSteamID[32];
		OV_GetPlayerSteamIDString( pPlayer, szSteamID, sizeof( szSteamID ) );

		char szUrl[512];
		Q_snprintf( szUrl, sizeof( szUrl ), "%s/v1/travel/validate", ov_api_url.GetString() );

		char szBody[512];
		Q_snprintf(
			szBody,
			sizeof( szBody ),
			"{\"token\":\"%s\",\"steamId\":\"%s\",\"serverId\":\"%s\"}",
			pszToken,
			szSteamID,
			ov_server_id.GetString() );

		ReleaseRequest();
		m_hRequest = SteamGameServerHTTP()->CreateHTTPRequest( k_EHTTPMethodPOST, szUrl );
		if ( m_hRequest == INVALID_HTTPREQUEST_HANDLE )
		{
			Warning( "[OV Join] Could not create validate request.\n" );
			return;
		}

		m_iUserID = pPlayer->GetUserID();
		SteamGameServerHTTP()->SetHTTPRequestHeaderValue( m_hRequest, "Accept", "application/json" );
		SteamGameServerHTTP()->SetHTTPRequestRawPostBody(
			m_hRequest,
			"application/json",
			(uint8 *)szBody,
			Q_strlen( szBody ) );
		SteamGameServerHTTP()->SetHTTPRequestNetworkActivityTimeout( m_hRequest, 8 );
		SteamGameServerHTTP()->SetHTTPRequestAbsoluteTimeoutMS( m_hRequest, 10000 );

		SteamAPICall_t hCall = k_uAPICallInvalid;
		if ( !SteamGameServerHTTP()->SendHTTPRequest( m_hRequest, &hCall ) || hCall == k_uAPICallInvalid )
		{
			Warning( "[OV Join] Could not send validate request.\n" );
			ReleaseRequest();
			return;
		}

		m_Callback.Set( hCall, this, &COpenVibeJoinValidation::OnValidateResponse );
		Msg( "[OV Join] Validating token for userID=%d steamID=%s server=%s.\n", m_iUserID, szSteamID, ov_server_id.GetString() );
	}

private:
	void OnValidateResponse( HTTPRequestCompleted_t *pResult, bool bIOFailure )
	{
		char szBody[2048];
		szBody[0] = '\0';

		if ( !bIOFailure && pResult && pResult->m_bRequestSuccessful )
		{
			uint32 nBodySize = 0;
			if ( SteamGameServerHTTP()->GetHTTPResponseBodySize( pResult->m_hRequest, &nBodySize ) &&
				 nBodySize > 0 &&
				 nBodySize < sizeof( szBody ) )
			{
				if ( SteamGameServerHTTP()->GetHTTPResponseBodyData(
					 pResult->m_hRequest,
					 (uint8 *)szBody,
					 nBodySize ) )
				{
					szBody[nBodySize] = '\0';
				}
			}
		}

		const bool bValid = OV_ExtractJsonBool( szBody, "valid" );
		if ( bValid )
		{
			Msg( "[OV Join] Join token accepted for userID=%d.\n", m_iUserID );
		}
		else
		{
			Warning( "[OV Join] Join token rejected for userID=%d: %s\n", m_iUserID, szBody );
			if ( ov_join_required.GetBool() )
				KickUser( m_iUserID, "Invalid OpenVibe join token" );
		}

		ReleaseRequest();
	}

	void ReleaseRequest()
	{
		if ( m_hRequest != INVALID_HTTPREQUEST_HANDLE && SteamGameServerHTTP() )
		{
			SteamGameServerHTTP()->ReleaseHTTPRequest( m_hRequest );
		}
		m_hRequest = INVALID_HTTPREQUEST_HANDLE;
		m_iUserID = -1;
	}

	void KickUser( int iUserID, const char *pszReason )
	{
		if ( iUserID >= 0 )
			engine->ServerCommand( UTIL_VarArgs( "kickid %d \"%s\"\n", iUserID, pszReason ) );
	}

	HTTPRequestHandle m_hRequest;
	int m_iUserID;
	CCallResult< COpenVibeJoinValidation, HTTPRequestCompleted_t > m_Callback;
};

static COpenVibeJoinValidation g_OpenVibeJoinValidation;

void OpenVibe_OnClientActive( CHL2MP_Player *pPlayer )
{
	if ( !pPlayer )
		return;

	const int iClient = engine->IndexOfEdict( pPlayer->edict() );
	const char *pszToken = engine->GetClientConVarValue( iClient, "ov_join_token" );
	char szSteamID[32];
	OV_GetPlayerSteamIDString( pPlayer, szSteamID, sizeof( szSteamID ) );

	if ( pszToken && pszToken[0] )
	{
		Msg( "[OV] ARRIVAL %s %s %s\n", szSteamID, ov_server_id.GetString(), pszToken );
		g_OpenVibeJoinValidation.Validate( pPlayer, pszToken );
	}
	else if ( ov_join_required.GetBool() )
	{
		engine->ServerCommand( UTIL_VarArgs( "kickid %d \"OpenVibe join token required\"\n", pPlayer->GetUserID() ) );
	}

    OpenVibeJS_Server_PlayerInitialSpawn( pPlayer );
}

static void OV_PropHuntDisguise_f( const CCommand &args )
{
	CHL2MP_Player *pPlayer = ToHL2MPPlayer( UTIL_GetCommandClient() );
	if ( !pPlayer )
		return;

	if ( args.ArgC() < 2 )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "Usage: ov_prophunt_disguise <can|crate|barrel|chair|bucket>" );
		return;
	}

	const OVModelChoice *pChoice = OV_FindModelChoice( s_PropDisguises, ARRAYSIZE( s_PropDisguises ), args[1] );
	if ( !pChoice )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "That prop disguise is not allowed." );
		return;
	}

	CBaseEntity::PrecacheModel( pChoice->pszModel );
	pPlayer->SetModel( pChoice->pszModel );
	pPlayer->SetModelScale( pChoice->flScale );
	UTIL_SetSize( pPlayer, pChoice->mins, pChoice->maxs );
	pPlayer->RemoveAllItems( true );
	ClientPrint( pPlayer, HUD_PRINTTALK, "Prop disguise active." );
}

static void OV_PropHuntResetDisguise_f( const CCommand &args )
{
	CHL2MP_Player *pPlayer = ToHL2MPPlayer( UTIL_GetCommandClient() );
	if ( !pPlayer )
		return;

	pPlayer->SetModelScale( 1.0f );
	UTIL_SetSize( pPlayer, VEC_HULL_MIN, VEC_HULL_MAX );
	pPlayer->SetPlayerModel();
	pPlayer->GiveDefaultItems();
	ClientPrint( pPlayer, HUD_PRINTTALK, "Prop disguise cleared." );
}

static ConCommand ov_prophunt_disguise_cmd(
	"ov_prophunt_disguise",
	OV_PropHuntDisguise_f,
	"Disguise as a whitelisted Prop Hunt object.",
	FCVAR_GAMEDLL );

static ConCommand ov_prophunt_reset_disguise_cmd(
	"ov_prophunt_reset_disguise",
	OV_PropHuntResetDisguise_f,
	"Restore normal player model after Prop Hunt disguise.",
	FCVAR_GAMEDLL );

static void OV_FortWarsSpawn_f( const CCommand &args )
{
	CHL2MP_Player *pPlayer = ToHL2MPPlayer( UTIL_GetCommandClient() );
	if ( !pPlayer )
		return;

	if ( !ov_fortwars_build_enabled.GetBool() )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "Fort Wars build phase is not active." );
		return;
	}

	if ( args.ArgC() < 2 )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "Usage: ov_fortwars_spawn <crate|barrel|pallet|fence|sheet>" );
		return;
	}

	const OVModelChoice *pChoice = OV_FindModelChoice( s_FortWarsProps, ARRAYSIZE( s_FortWarsProps ), args[1] );
	if ( !pChoice )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "That Fort Wars prop is not allowed." );
		return;
	}

	Vector vecForward;
	AngleVectors( pPlayer->EyeAngles(), &vecForward );

	trace_t tr;
	const Vector vecStart = pPlayer->EyePosition();
	const Vector vecEnd = vecStart + vecForward * 220.0f;
	UTIL_TraceLine( vecStart, vecEnd, MASK_SOLID, pPlayer, COLLISION_GROUP_NONE, &tr );

	Vector vecSpawn = tr.endpos;
	if ( tr.DidHit() )
		vecSpawn += tr.plane.normal * 24.0f;

	CBaseEntity::PrecacheModel( pChoice->pszModel );

	CBaseEntity *pProp = CreateEntityByName( "prop_physics_override" );
	if ( !pProp )
	{
		ClientPrint( pPlayer, HUD_PRINTTALK, "Could not create prop." );
		return;
	}

	pProp->KeyValue( "model", pChoice->pszModel );
	pProp->KeyValue( "spawnflags", "256" );
	pProp->SetAbsOrigin( vecSpawn );
	pProp->SetAbsAngles( QAngle( 0.0f, pPlayer->EyeAngles().y, 0.0f ) );
	pProp->SetOwnerEntity( pPlayer );

	DispatchSpawn( pProp );
	pProp->Activate();

	ClientPrint( pPlayer, HUD_PRINTTALK, "Fort Wars prop placed." );
}

static ConCommand ov_fortwars_spawn_cmd(
	"ov_fortwars_spawn",
	OV_FortWarsSpawn_f,
	"Spawn a whitelisted Fort Wars build prop in front of the player.",
	FCVAR_GAMEDLL );

// =================================══════════════════════════════════════════
// OpenVibe.JS - Scripting Engine C++ Bridge


// ======================================\n// OpenVibe embedded JavaScript hook bridge\n// ======================================

void OpenVibe_OnClientDisconnect( CBasePlayer *pPlayer )
{

    CHL2MP_Player *pHL2MP = ToHL2MPPlayer( pPlayer );
    if ( pHL2MP )
        OpenVibeJS_Server_PlayerDisconnected( pHL2MP );
}

void OpenVibe_OnPlayerDeath( CHL2MP_Player *pPlayer, CBaseEntity *pKiller )
{

    OpenVibeJS_Server_PlayerDeath( pPlayer, pKiller, NULL );
}

void OpenVibe_OnFrame()
{

    OpenVibeJS_ServerThink();
}

