// OpenVibe: Source HTML menu host.
//
// This is the only native menu shell the game needs.  It embeds Steam's
// CEF-backed vgui::HTML control full-screen, loads the OpenVibe web client,
// and exposes a small allowlisted openvibe:// bridge back into Source.

#include "cbase.h"
#include "cdll_client_int.h"
#include "ienginevgui.h"

#include <vgui/ISurface.h>
#include <vgui_controls/Frame.h>
#include <vgui_controls/HTML.h>

#include <ctype.h>
#include <stdlib.h>

// memdbgon must be the last include file in a .cpp file.
#include "tier0/memdbgon.h"

using namespace vgui;

static ConVar ov_menu_url(
	"ov_menu_url",
	"http://127.0.0.1:5173/client/?embedded=1&shell=source#portal",
	FCVAR_ARCHIVE,
	"OpenVibe HTML menu URL." );

static ConVar ov_menu_auto_open(
	"ov_menu_auto_open",
	"1",
	FCVAR_ARCHIVE,
	"Automatically opens the OpenVibe HTML menu when the client UI initializes." );

static ConVar ov_menu_allow_remote(
	"ov_menu_allow_remote",
	"1",
	FCVAR_ARCHIVE,
	"Allow loading https://openvibe.games in the embedded menu." );

static bool OV_URLStartsWith( const char *pszUrl, const char *pszPrefix )
{
	return pszUrl && pszPrefix && !Q_strnicmp( pszUrl, pszPrefix, Q_strlen( pszPrefix ) );
}

static bool OV_IsAllowedWebURL( const char *pszUrl )
{
	if ( !pszUrl || !pszUrl[0] )
		return false;

	if ( OV_URLStartsWith( pszUrl, "about:blank" ) )
		return true;

	if ( OV_URLStartsWith( pszUrl, "http://127.0.0.1:" ) ||
		 OV_URLStartsWith( pszUrl, "http://localhost:" ) )
		return true;

	if ( ov_menu_allow_remote.GetBool() &&
		 ( OV_URLStartsWith( pszUrl, "https://openvibe.games/" ) ||
		   OV_URLStartsWith( pszUrl, "https://www.openvibe.games/" ) ) )
		return true;

	return false;
}

static bool OV_IsSafeMode( const char *pszMode )
{
	return pszMode &&
		( !Q_stricmp( pszMode, "hub" ) ||
		  !Q_stricmp( pszMode, "prophunt" ) ||
		  !Q_stricmp( pszMode, "deathrun" ) ||
		  !Q_stricmp( pszMode, "fortwars" ) ||
		  !Q_stricmp( pszMode, "traitortown" ) );
}

static void OV_URLDecodeInPlace( char *pszValue )
{
	if ( !pszValue )
		return;

	char *pszRead = pszValue;
	char *pszWrite = pszValue;
	while ( *pszRead )
	{
		if ( pszRead[0] == '%' && isxdigit( pszRead[1] ) && isxdigit( pszRead[2] ) )
		{
			char szHex[3] = { pszRead[1], pszRead[2], '\0' };
			*pszWrite++ = (char)strtol( szHex, NULL, 16 );
			pszRead += 3;
			continue;
		}

		*pszWrite++ = ( pszRead[0] == '+' ) ? ' ' : pszRead[0];
		++pszRead;
	}
	*pszWrite = '\0';
}

static bool OV_ReadQueryValue( const char *pszUrl, const char *pszKey, char *pszOut, size_t nOut )
{
	if ( !pszUrl || !pszKey || !pszOut || nOut == 0 )
		return false;

	pszOut[0] = '\0';

	char szNeedle[64];
	Q_snprintf( szNeedle, sizeof( szNeedle ), "%s=", pszKey );

	const char *pszQuery = Q_strstr( pszUrl, "?" );
	if ( !pszQuery )
		return false;

	const char *pszCursor = pszQuery + 1;
	while ( pszCursor && pszCursor[0] )
	{
		if ( !Q_strnicmp( pszCursor, szNeedle, Q_strlen( szNeedle ) ) )
		{
			pszCursor += Q_strlen( szNeedle );
			const char *pszEnd = pszCursor;
			while ( pszEnd[0] && pszEnd[0] != '&' && pszEnd[0] != '#' )
				++pszEnd;

			const int nLen = MIN( (int)( pszEnd - pszCursor ), (int)nOut - 1 );
			if ( nLen <= 0 )
				return false;

			Q_strncpy( pszOut, pszCursor, nLen + 1 );
			pszOut[nLen] = '\0';
			OV_URLDecodeInPlace( pszOut );
			return true;
		}

		pszCursor = Q_strstr( pszCursor, "&" );
		if ( pszCursor )
			++pszCursor;
	}

	return false;
}

class IOpenVibeHTMLBridge
{
public:
	virtual bool OnOpenVibeHTMLStartRequest( const char *pszURL, const char *pszTarget, const char *pszPostData, bool bIsRedirect ) = 0;
};

class COpenVibeHTMLControl : public HTML
{
	DECLARE_CLASS_SIMPLE( COpenVibeHTMLControl, HTML );
public:
	COpenVibeHTMLControl( IOpenVibeHTMLBridge *pBridge, Panel *pParent, const char *pszName ) :
		BaseClass( pParent, pszName, true ),
		m_pBridge( pBridge )
	{
	}

	bool OnStartRequest( const char *pszURL, const char *pszTarget, const char *pszPostData, bool bIsRedirect ) OVERRIDE
	{
		return m_pBridge ? m_pBridge->OnOpenVibeHTMLStartRequest( pszURL, pszTarget, pszPostData, bIsRedirect ) : false;
	}

private:
	IOpenVibeHTMLBridge *m_pBridge;
};

class COpenVibeHTMLPanel : public Frame, public IOpenVibeHTMLBridge
{
	DECLARE_CLASS_SIMPLE( COpenVibeHTMLPanel, Frame );

public:
	COpenVibeHTMLPanel( VPANEL parent ) :
		BaseClass( NULL, "OpenVibeHTMLPanel" )
	{
		SetParent( parent );
		SetTitle( "OpenVibe: Source", false );
		SetTitleBarVisible( false );
		SetMinimizeButtonVisible( false );
		SetMaximizeButtonVisible( false );
		SetCloseButtonVisible( false );
		SetSizeable( false );
		SetMoveable( false );
		SetDeleteSelfOnClose( false );
		SetPaintBackgroundEnabled( true );
		SetBgColor( Color( 7, 8, 14, 255 ) );

		m_pHTML = new COpenVibeHTMLControl( this, this, "OpenVibeHTML" );
		m_pHTML->SetScrollbarsEnabled( false );
		m_pHTML->SetContextMenuEnabled( false );
		m_pHTML->NewWindowsOnly( false );

		MakeFullScreen();
		SetVisible( false );
	}

	void Open( const char *pszURL = NULL )
	{
		const char *pszTarget = ( pszURL && pszURL[0] ) ? pszURL : ov_menu_url.GetString();
		MakeFullScreen();
		SetVisible( true );
		MoveToFront();
		RequestFocus();
		m_pHTML->RequestFocus();
		m_pHTML->OpenURL( pszTarget, NULL, true );
		engine->ClientCmd_Unrestricted( "gameui_hide\n" );
	}

	void CloseMenu()
	{
		SetVisible( false );
		engine->ClientCmd_Unrestricted( "gameui_hide\n" );
	}

	void Reload()
	{
		if ( IsVisible() )
			m_pHTML->Refresh();
	}

	void RunJS( const char *pszScript )
	{
		if ( pszScript && pszScript[0] )
			m_pHTML->RunJavascript( pszScript );
	}

	void OnSizeChanged( int wide, int tall ) OVERRIDE
	{
		BaseClass::OnSizeChanged( wide, tall );
		if ( m_pHTML )
			m_pHTML->SetBounds( 0, 0, wide, tall );
	}

	void PerformLayout() OVERRIDE
	{
		BaseClass::PerformLayout();
		MakeFullScreen();
	}

	bool OnOpenVibeHTMLStartRequest( const char *pszURL, const char *pszTarget, const char *pszPostData, bool bIsRedirect ) OVERRIDE
	{
		if ( OV_URLStartsWith( pszURL, "openvibe://" ) )
		{
			HandleBridgeURL( pszURL );
			return false;
		}

		if ( !OV_IsAllowedWebURL( pszURL ) )
		{
			Warning( "[OV HTML] Blocked navigation to %s\n", pszURL ? pszURL : "<null>" );
			return false;
		}

		return true;
	}

private:
	void MakeFullScreen()
	{
		int sw = 0;
		int sh = 0;
		surface()->GetScreenSize( sw, sh );
		SetBounds( 0, 0, sw, sh );
		if ( m_pHTML )
			m_pHTML->SetBounds( 0, 0, sw, sh );
	}

	void HandleBridgeURL( const char *pszURL )
	{
		if ( OV_URLStartsWith( pszURL, "openvibe://join" ) )
		{
			char szMode[64];
			if ( OV_ReadQueryValue( pszURL, "mode", szMode, sizeof( szMode ) ) && OV_IsSafeMode( szMode ) )
			{
				CloseMenu();
				engine->ClientCmd_Unrestricted( VarArgs( "ov_join %s\n", szMode ) );
				return;
			}
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://close" ) )
		{
			CloseMenu();
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://reload" ) )
		{
			Reload();
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://external" ) )
		{
			char szUrl[512];
			if ( OV_ReadQueryValue( pszURL, "url", szUrl, sizeof( szUrl ) ) && OV_IsAllowedWebURL( szUrl ) )
				engine->ClientCmd_Unrestricted( VarArgs( "ov_open_url %s\n", szUrl ) );
			return;
		}

		Warning( "[OV HTML] Ignored bridge URL: %s\n", pszURL ? pszURL : "<null>" );
	}

	HTML *m_pHTML;
};

static COpenVibeHTMLPanel *s_pOpenVibeMenu = NULL;

static COpenVibeHTMLPanel *OV_GetHTMLMenu()
{
	if ( !s_pOpenVibeMenu )
		s_pOpenVibeMenu = new COpenVibeHTMLPanel( enginevgui->GetPanel( PANEL_GAMEUIDLL ) );

	return s_pOpenVibeMenu;
}

static void OV_OpenMenu_f( const CCommand &args )
{
	const char *pszURL = args.ArgC() >= 2 ? args[1] : NULL;
	OV_GetHTMLMenu()->Open( pszURL );
}

static void OV_CloseMenu_f( const CCommand &args )
{
	if ( s_pOpenVibeMenu )
		s_pOpenVibeMenu->CloseMenu();
}

static void OV_ReloadMenu_f( const CCommand &args )
{
	if ( s_pOpenVibeMenu )
		s_pOpenVibeMenu->Reload();
}

static void OV_MenuJS_f( const CCommand &args )
{
	if ( s_pOpenVibeMenu && args.ArgC() >= 2 )
		s_pOpenVibeMenu->RunJS( args.ArgS() );
}

void OpenVibe_OnClientModeInit()
{
	if ( ov_menu_auto_open.GetBool() )
		OV_GetHTMLMenu()->Open();
}

static ConCommand openvibe_menu_cmd(
	"openvibe_menu",
	OV_OpenMenu_f,
	"Open the OpenVibe embedded HTML menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_cmd(
	"ov_menu",
	OV_OpenMenu_f,
	"Open the OpenVibe embedded HTML menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_close_cmd(
	"ov_menu_close",
	OV_CloseMenu_f,
	"Close the OpenVibe embedded HTML menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_reload_cmd(
	"ov_menu_reload",
	OV_ReloadMenu_f,
	"Reload the OpenVibe embedded HTML menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_js_cmd(
	"ov_menu_js",
	OV_MenuJS_f,
	"Run JavaScript in the OpenVibe embedded HTML menu.",
	FCVAR_CLIENTDLL );

// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_BEGIN
static void OV_OpenMenuRoute( const char *pszRoute )
{
	char szBase[512];
	Q_strncpy( szBase, ov_menu_url.GetString(), sizeof( szBase ) );

	for ( int i = 0; szBase[i]; ++i )
	{
		if ( szBase[i] == '#' )
		{
			szBase[i] = '\0';
			break;
		}
	}

	const char *pszSafeRoute =
		( pszRoute && pszRoute[0] ) ? pszRoute : "portal";

	char szURL[768];
	Q_snprintf( szURL, sizeof( szURL ), "%s#%s", szBase, pszSafeRoute );

	OV_GetHTMLMenu()->Open( szURL );
}

static void OV_MenuMain_f( const CCommand &args ) { OV_OpenMenuRoute( "portal" ); }
static void OV_MenuServers_f( const CCommand &args ) { OV_OpenMenuRoute( "servers" ); }
static void OV_MenuLeaderboard_f( const CCommand &args ) { OV_OpenMenuRoute( "leaderboard" ); }
static void OV_MenuInventory_f( const CCommand &args ) { OV_OpenMenuRoute( "inventory" ); }
static void OV_MenuShop_f( const CCommand &args ) { OV_OpenMenuRoute( "shop" ); }
static void OV_MenuSettings_f( const CCommand &args ) { OV_OpenMenuRoute( "settings" ); }

static ConCommand ov_ui_cmd(
	"ov_ui",
	OV_MenuMain_f,
	"Open the synced OpenVibe HTML UI.",
	FCVAR_CLIENTDLL );

static ConCommand ov_main_menu_cmd(
	"ov_main_menu",
	OV_MenuMain_f,
	"Open the custom OpenVibe main menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_main_cmd(
	"ov_menu_main",
	OV_MenuMain_f,
	"Open the OpenVibe portal route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_servers_cmd(
	"ov_menu_servers",
	OV_MenuServers_f,
	"Open the OpenVibe server browser route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_leaderboard_cmd(
	"ov_menu_leaderboard",
	OV_MenuLeaderboard_f,
	"Open the OpenVibe leaderboard route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_inventory_cmd(
	"ov_menu_inventory",
	OV_MenuInventory_f,
	"Open the OpenVibe inventory route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_shop_cmd(
	"ov_menu_shop",
	OV_MenuShop_f,
	"Open the OpenVibe shop route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_settings_route_cmd(
	"ov_menu_settings",
	OV_MenuSettings_f,
	"Open the OpenVibe settings route.",
	FCVAR_CLIENTDLL );
// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_END

