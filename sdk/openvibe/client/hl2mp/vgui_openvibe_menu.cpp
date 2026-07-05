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

#include "tier1/convar.h"
#include "tier1/utlstring.h"
#include "tier1/utlvector.h"

#include <ctype.h>
#include <stdlib.h>

// memdbgon must be the last include file in a .cpp file.
#include "tier0/memdbgon.h"

using namespace vgui;

// OPENVIBE_HTML_READY_FORWARD_DECLS
// HandleBridgeURL() calls OpenVibe_OnHTMLReady() before its implementation later
// in this file, so Linux/GCC needs an explicit forward declaration.
void OpenVibe_OnHTMLReady();

// HandleBridgeURL() / OnThink() also use these before their definitions below.
static void OV_SanitiseJSString( char *pszOut, size_t nOut, const char *pszIn );
static void OV_InstallConsoleTap();
static void OV_ConsoleTapThink();


static ConVar ov_menu_url(
	"ov_menu_url",
	"http://127.0.0.1:3000/client/?embedded=1&shell=source#portal",
	FCVAR_ARCHIVE,
	"OpenVibe HTML menu URL." );

static ConVar ov_menu_auto_open(
	"ov_menu_auto_open",
	"1",
	FCVAR_ARCHIVE,
	"Automatically opens the OpenVibe HTML menu when the client UI initializes." );

static ConVar ov_hud_html(
	"ov_hud_html",
	"1",
	FCVAR_ARCHIVE,
	"Keep the HTML panel visible during gameplay as a transparent, input-transparent HUD overlay (gamemode JS GUIs render there)." );

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

// The OpenVibe HTML console replaces the stock Source console outright. When
// the panel is showing OUR OWN local UI (127.0.0.1/localhost origins) the
// bridge executes any console line, exactly like the real console. Remote
// origins (openvibe.games) stay restricted to the allowlist below.
static ConVar ov_console_unrestricted(
	"ov_console_unrestricted",
	"1",
	FCVAR_CLIENTDLL | FCVAR_ARCHIVE,
	"Allow the local OpenVibe HTML console to run any engine command (remote pages stay allowlisted)." );

static bool OV_IsLocalUIOrigin( const char *pszUrl )
{
	return OV_URLStartsWith( pszUrl, "http://127.0.0.1:" ) ||
		OV_URLStartsWith( pszUrl, "http://localhost:" );
}

// openvibe://cmd allowlist for NON-local origins: the first token decides.
// ov_* commands (which includes ov_npm and all OpenVibe dev commands) plus the
// GModJS script commands and a few stock engine commands the GUI console needs.
static bool OV_IsAllowedBridgeCommand( const char *pszCommand )
{
	if ( !pszCommand || !pszCommand[0] )
		return false;

	// No multi-command or newline smuggling through the bridge.
	if ( Q_strstr( pszCommand, ";" ) || Q_strstr( pszCommand, "\n" ) || Q_strstr( pszCommand, "\r" ) )
		return false;

	char szToken[64];
	int i = 0;
	while ( pszCommand[i] && pszCommand[i] != ' ' && i < (int)sizeof( szToken ) - 1 )
	{
		szToken[i] = pszCommand[i];
		++i;
	}
	szToken[i] = '\0';

	if ( !Q_strnicmp( szToken, "ov_", 3 ) )
		return true;

	static const char *s_AllowedBridgeCommands[] =
	{
		"js_run",
		"js_run_cl",
		"js_openscript",
		"js_openscript_cl",
		"ov_npm",
		"say",
		"connect",
		"disconnect",
		"retry",
		"status",
	};

	for ( int j = 0; j < ARRAYSIZE( s_AllowedBridgeCommands ); ++j )
	{
		if ( !Q_stricmp( szToken, s_AllowedBridgeCommands[j] ) )
			return true;
	}

	return false;
}

// openvibe://convar[_get] allowlist: OpenVibe client settings plus the stock
// game/video/audio convars the options route exposes.
static const char *s_OVAllowedBridgeConvars[] =
{
	"ov_menu_url",
	"ov_menu_auto_open",
	"ov_menu_allow_remote",
	"ov_api_url",
	"ov_client_js_enabled",
	"ov_js_backend",
	"volume",
	"snd_musicvolume",
	"mat_monitorgamma",
	"fov_desired",
	"sensitivity",
	"cl_ragdoll_collide",
};

static bool OV_IsAllowedBridgeConvar( const char *pszName )
{
	if ( !pszName || !pszName[0] )
		return false;

	for ( int i = 0; i < ARRAYSIZE( s_OVAllowedBridgeConvars ); ++i )
	{
		if ( !Q_stricmp( pszName, s_OVAllowedBridgeConvars[i] ) )
			return true;
	}

	return false;
}

static int __cdecl OV_SortCommandBaseByName( ConCommandBase * const *ppLeft, ConCommandBase * const *ppRight )
{
	return Q_stricmp( ( *ppLeft )->GetName(), ( *ppRight )->GetName() );
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

	// In-game HTML HUD: keep the panel visible during gameplay as a
	// transparent, input-transparent overlay routed to the page's #hud route
	// (pointer-events:none there). Gamemode JS GUIs — HUD.Add layouts pushed
	// via ov_menu_js — render here. The GameUI panel layer only draws while
	// GameUI is up, so HUD mode reparents into the client panel layer.
	void EnterHudMode()
	{
		m_bHudMode = true;
		SetPauseOverlay( true );
		SetParent( enginevgui->GetPanel( PANEL_CLIENTDLL ) );
		MakeFullScreen();
		if ( m_szCurrentURL[0] == '\0' )
		{
			Q_strncpy( m_szCurrentURL, ov_menu_url.GetString(), sizeof( m_szCurrentURL ) );
			m_pHTML->OpenURL( m_szCurrentURL, NULL, true );
		}
		RunJS(
			"document.documentElement.classList.remove('ov-pause-overlay');"
			"if(typeof window.routeTo==='function'){routeTo('hud');}" );
		SetVisible( true );
		// Gameplay keeps mouse + keys; the page is pointer-events:none in
		// HUD mode anyway.
		SetMouseInputEnabled( false );
		SetKeyBoardInputEnabled( false );
		m_pHTML->SetMouseInputEnabled( false );
		m_pHTML->SetKeyBoardInputEnabled( false );
	}

	// NOTE: no reparent here. The GameUI panel layer only paints while
	// GameUI is visible, and popup re-sorting lags a reparent by one GameUI
	// raise — which made the first ESC show nothing and the second show the
	// menu. In-game states (HUD + pause) stay on PANEL_CLIENTDLL (paints
	// during gameplay); only the out-of-level main menu uses PANEL_GAMEUIDLL.
	void LeaveHudMode()
	{
		if ( !m_bHudMode )
			return;
		m_bHudMode = false;
		SetMouseInputEnabled( true );
		SetKeyBoardInputEnabled( true );
		m_pHTML->SetMouseInputEnabled( true );
		m_pHTML->SetKeyBoardInputEnabled( true );
	}

	bool IsHudMode() const { return m_bHudMode; }

	// Re-assert the panel above a stock GameUI raise (disconnect/error
	// dialogs) without touching the loaded page. NEVER OpenURL here — this
	// runs from the keep-alive and a reload per tick is a reload loop.
	void EnsureOnTop()
	{
		LeaveHudMode();
		SetPauseOverlay( false );
		SetVisible( true );
		MoveToFront();
	}

	void Open( const char *pszURL = NULL )
	{
		LeaveHudMode();
		// Full shell: out of a level this must live in the GameUI layer;
		// in a level the client layer paints reliably (see LeaveHudMode).
		SetParent( enginevgui->GetPanel( engine->IsInGame() ? PANEL_CLIENTDLL : PANEL_GAMEUIDLL ) );
		SetPauseOverlay( false ); // full opaque shell (main menu / route open)
		const char *pszTarget = ( pszURL && pszURL[0] ) ? pszURL : ov_menu_url.GetString();
		Q_strncpy( m_szCurrentURL, pszTarget, sizeof( m_szCurrentURL ) );
		MakeFullScreen();
		SetVisible( true );
		MoveToFront();
		RequestFocus();
		m_pHTML->RequestFocus();
		m_pHTML->OpenURL( pszTarget, NULL, true );
		engine->ClientCmd_Unrestricted( "gameui_hide\n" );
	}

	// In-game pause menu: replaces the stock GameUI when ESC is pressed during
	// a level. Renders as a translucent, blurred overlay so the game shows
	// through behind it (the page adds the 'ov-pause-overlay' body class).
	void OpenPause()
	{
		LeaveHudMode();
		SetParent( enginevgui->GetPanel( PANEL_CLIENTDLL ) ); // in-game layer paints during gameplay
		SetPauseOverlay( true );
		MakeFullScreen();
		SetVisible( true );
		MoveToFront();
		RequestFocus();
		m_pHTML->RequestFocus();

		// The page persists across shows; load it once, then just route +
		// flag it. Fresh load also carries the flag via the query string.
		if ( m_szCurrentURL[0] == '\0' )
		{
			Q_strncpy( m_szCurrentURL, ov_menu_url.GetString(), sizeof( m_szCurrentURL ) );
			m_pHTML->OpenURL( m_szCurrentURL, NULL, true );
		}

		RunJS(
			"document.documentElement.classList.add('ov-pause-overlay');"
			"if(typeof window.routeTo==='function'){routeTo('portal');}"
			"else if(window.OpenVibeShell&&typeof window.OpenVibeShell.setRoute==='function')"
			"{window.OpenVibeShell.setRoute('portal');}" );

		engine->ClientCmd_Unrestricted( "gameui_hide\n" );
	}

	void CloseMenu( bool bForceHide = false )
	{
		// Out of a level this panel IS the main menu: hiding it would reveal
		// the stock GameUI menu sitting behind it. Fall back to the portal
		// route instead. Actually hiding is only for returning to gameplay,
		// or for a map load kicked off by openvibe://join (the engine's
		// loading screen needs to show).
		if ( !bForceHide && !engine->IsInGame() )
		{
			RunJS(
				"if(window.OpenVibeShell&&typeof window.OpenVibeShell.setRoute==='function')"
				"{window.OpenVibeShell.setRoute('portal');}" );
			SetVisible( true );
			MoveToFront();
			return;
		}

		// Returning to gameplay: stay up as the transparent HTML HUD overlay
		// instead of hiding (unless force-hidden for a map load).
		if ( !bForceHide && engine->IsInGame() && ov_hud_html.GetBool() )
		{
			EnterHudMode();
			engine->ClientCmd_Unrestricted( "gameui_hide\n" );
			return;
		}

		SetPauseOverlay( false );
		LeaveHudMode();
		SetVisible( false );
		engine->ClientCmd_Unrestricted( "gameui_hide\n" );
	}

	// Toggle translucent/blurred pause-overlay presentation. When on, the panel
	// stops painting its opaque background so the 3D game renders behind the
	// (semi-transparent, backdrop-blurred) HTML menu.
	void SetPauseOverlay( bool bOn )
	{
		m_bPauseOverlay = bOn;
		SetPaintBackgroundEnabled( !bOn );
		SetBgColor( bOn ? Color( 0, 0, 0, 0 ) : Color( 7, 8, 14, 255 ) );
		if ( !bOn )
			RunJS( "document.documentElement.classList.remove('ov-pause-overlay');" );
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

	void OnThink() OVERRIDE
	{
		BaseClass::OnThink();
		OV_ConsoleTapThink();
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

		// Track the page origin: the bridge grants full console powers only to
		// the local UI (see openvibe://cmd handling).
		Q_strncpy( m_szCurrentURL, pszURL, sizeof( m_szCurrentURL ) );
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
				CloseMenu( true ); // force-hide: the map load's screen takes over
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

		if ( OV_URLStartsWith( pszURL, "openvibe://auth/steam" ) )
		{
			// Web page requests Steam authentication; trigger the C++ auth flow.
			engine->ClientCmd_Unrestricted( "ov_auth_steam\n" );
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://ready" ) )
		{
			// Web page has loaded and exposed window.OV; push any stored session.
			OpenVibe_OnHTMLReady();
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://external" ) )
		{
			char szUrl[512];
			if ( OV_ReadQueryValue( pszURL, "url", szUrl, sizeof( szUrl ) ) && OV_IsAllowedWebURL( szUrl ) )
				engine->ClientCmd_Unrestricted( VarArgs( "ov_open_url %s\n", szUrl ) );
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://cmd" ) )
		{
			// GUI console -> engine command. This is the user's own console
			// replacement: pages served from the local UI run any command line
			// (like the stock console, incl. map/changelevel/cheats/binds);
			// remote pages stay restricted to the first-token allowlist.
			char szCmd[1024];
			if ( !OV_ReadQueryValue( pszURL, "c", szCmd, sizeof( szCmd ) ) )
				return;

			// Newlines never pass (one console line per bridge action).
			for ( char *p = szCmd; *p; ++p )
			{
				if ( *p == '\n' || *p == '\r' )
					*p = ' ';
			}

			const bool bLocalConsole = ov_console_unrestricted.GetBool() && OV_IsLocalUIOrigin( m_szCurrentURL );
			if ( !bLocalConsole && !OV_IsAllowedBridgeCommand( szCmd ) )
			{
				Warning( "[OV HTML] blocked bridge command from non-local page: %s\n", szCmd );
				return;
			}

			// Echo like the stock console so the command shows in the tap.
			Msg( "] %s\n", szCmd );
			engine->ClientCmd_Unrestricted( VarArgs( "%s\n", szCmd ) );
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://complete" ) )
		{
			// GUI console autocomplete: match the live engine command/convar
			// registry (and per-command argument completion), like the stock
			// console. Read-only metadata, but local UI pages only.
			char szPrefix[256];
			if ( OV_IsLocalUIOrigin( m_szCurrentURL ) &&
				 OV_ReadQueryValue( pszURL, "prefix", szPrefix, sizeof( szPrefix ) ) )
				PushCompletionsToPage( szPrefix );
			return;
		}

		// NOTE: convar_get must be checked before the "openvibe://convar" prefix.
		if ( OV_URLStartsWith( pszURL, "openvibe://convar_get" ) )
		{
			char szNames[512];
			if ( OV_ReadQueryValue( pszURL, "names", szNames, sizeof( szNames ) ) )
				PushConvarsToPage( szNames );
			return;
		}

		if ( OV_URLStartsWith( pszURL, "openvibe://convar" ) )
		{
			char szName[64];
			char szValue[256];
			if ( !OV_ReadQueryValue( pszURL, "name", szName, sizeof( szName ) ) ||
				 !OV_ReadQueryValue( pszURL, "value", szValue, sizeof( szValue ) ) )
				return;

			if ( !OV_IsAllowedBridgeConvar( szName ) )
			{
				Warning( "[OV HTML] blocked convar set: %s\n", szName );
				return;
			}

			ConVar *pVar = g_pCVar ? g_pCVar->FindVar( szName ) : NULL;
			if ( pVar )
				pVar->SetValue( szValue );
			else
				Warning( "[OV HTML] convar not found: %s\n", szName );
			return;
		}

		Warning( "[OV HTML] Ignored bridge URL: %s\n", pszURL ? pszURL : "<null>" );
	}

	// openvibe://convar_get — push allowlisted convar values back into the page
	// as window.OV.onConvars({name: "value", ...}).
	void PushConvarsToPage( char *pszNamesCsv )
	{
		char szScript[4096];
		Q_strncpy( szScript,
			"if(typeof window.OV==='object'&&typeof window.OV.onConvars==='function')"
			"{window.OV.onConvars({", sizeof( szScript ) );

		bool bFirst = true;
		for ( char *pszName = strtok( pszNamesCsv, "," ); pszName; pszName = strtok( NULL, "," ) )
		{
			while ( *pszName == ' ' )
				++pszName;

			// Allowlisted names are literal matches of s_OVAllowedBridgeConvars,
			// so they are safe to embed; values still go through the sanitiser.
			if ( !*pszName || !OV_IsAllowedBridgeConvar( pszName ) )
				continue;

			ConVar *pVar = g_pCVar ? g_pCVar->FindVar( pszName ) : NULL;
			if ( !pVar )
				continue;

			char szValue[256];
			OV_SanitiseJSString( szValue, sizeof( szValue ), pVar->GetString() );

			char szPair[384];
			Q_snprintf( szPair, sizeof( szPair ), "%s'%s':'%s'", bFirst ? "" : ",", pszName, szValue );
			Q_strncat( szScript, szPair, sizeof( szScript ), COPY_ALL_CHARACTERS );
			bFirst = false;
		}

		Q_strncat( szScript, "});}", sizeof( szScript ), COPY_ALL_CHARACTERS );
		RunJS( szScript );
	}

	// openvibe://complete — push live console autocomplete matches back into
	// the page as window.OV.onEngineComplete(prefix, [[name, hint, kind], …])
	// with kind 'cmd' | 'cvar' (name completion) or 'line' (a full command
	// line from the command's own argument autocomplete, e.g. "map gm_x").
	void PushCompletionsToPage( const char *pszPrefixRaw )
	{
		while ( *pszPrefixRaw == ' ' )
			++pszPrefixRaw;

		char szPrefix[256];
		Q_strncpy( szPrefix, pszPrefixRaw, sizeof( szPrefix ) );

		char szSafePrefix[256];
		OV_SanitiseJSString( szSafePrefix, sizeof( szSafePrefix ), szPrefix );

		char szScript[12288];
		Q_snprintf( szScript, sizeof( szScript ),
			"if(typeof window.OV==='object'&&typeof window.OV.onEngineComplete==='function')"
			"{window.OV.onEngineComplete('%s',[", szSafePrefix );

		const int nMaxItems = 20;
		int nItems = 0;

		const char *pszSpace = Q_strstr( szPrefix, " " );
		if ( pszSpace )
		{
			// Argument completion: ask the command itself (map, changelevel,
			// exec, … implement AutoCompleteSuggest and return full lines).
			char szToken[128];
			const int nTok = MIN( (int)( pszSpace - szPrefix ), (int)sizeof( szToken ) - 1 );
			Q_strncpy( szToken, szPrefix, nTok + 1 );

			ConCommand *pCmd = g_pCVar ? g_pCVar->FindCommand( szToken ) : NULL;
			CUtlVector< CUtlString > matches;
			if ( pCmd && pCmd->CanAutoComplete() )
				pCmd->AutoCompleteSuggest( szPrefix, matches );

			for ( int i = 0; i < matches.Count() && nItems < nMaxItems; ++i )
			{
				char szLine[256];
				OV_SanitiseJSString( szLine, sizeof( szLine ), matches[i].Get() );

				char szItem[320];
				Q_snprintf( szItem, sizeof( szItem ), "%s['%s','','line']", nItems ? "," : "", szLine );
				Q_strncat( szScript, szItem, sizeof( szScript ), COPY_ALL_CHARACTERS );
				++nItems;
			}
		}
		else if ( szPrefix[0] )
		{
			// Name completion across the full command/convar registry.
			CUtlVector< ConCommandBase * > found;
			const int nPrefixLen = Q_strlen( szPrefix );
			for ( ConCommandBase *pBase = g_pCVar ? g_pCVar->GetCommands() : NULL; pBase; pBase = pBase->GetNext() )
			{
				if ( pBase->IsFlagSet( FCVAR_HIDDEN ) || pBase->IsFlagSet( FCVAR_DEVELOPMENTONLY ) )
					continue;
				if ( Q_strnicmp( pBase->GetName(), szPrefix, nPrefixLen ) )
					continue;
				found.AddToTail( pBase );
				if ( found.Count() >= 256 )
					break;
			}
			found.Sort( OV_SortCommandBaseByName );

			for ( int i = 0; i < found.Count() && nItems < nMaxItems; ++i )
			{
				ConCommandBase *pBase = found[i];

				char szHint[160];
				if ( !pBase->IsCommand() )
				{
					ConVar *pVar = static_cast< ConVar * >( pBase );
					Q_snprintf( szHint, sizeof( szHint ), "= %s - %s",
						pVar->GetString(), pBase->GetHelpText() ? pBase->GetHelpText() : "" );
				}
				else
				{
					Q_strncpy( szHint, pBase->GetHelpText() ? pBase->GetHelpText() : "", sizeof( szHint ) );
				}

				char szName[128];
				char szSafeHint[160];
				OV_SanitiseJSString( szName, sizeof( szName ), pBase->GetName() );
				OV_SanitiseJSString( szSafeHint, sizeof( szSafeHint ), szHint );

				char szItem[384];
				Q_snprintf( szItem, sizeof( szItem ), "%s['%s','%s','%s']",
					nItems ? "," : "", szName, szSafeHint, pBase->IsCommand() ? "cmd" : "cvar" );
				Q_strncat( szScript, szItem, sizeof( szScript ), COPY_ALL_CHARACTERS );
				++nItems;
			}
		}

		Q_strncat( szScript, "]);}", sizeof( szScript ), COPY_ALL_CHARACTERS );
		RunJS( szScript );
	}

	HTML *m_pHTML;
	char m_szCurrentURL[512] = {};
	bool m_bPauseOverlay = false;
	bool m_bHudMode = false;
};

static COpenVibeHTMLPanel *s_pOpenVibeMenu = NULL;

static COpenVibeHTMLPanel *OV_GetHTMLMenu()
{
	if ( !s_pOpenVibeMenu )
	{
		s_pOpenVibeMenu = new COpenVibeHTMLPanel( enginevgui->GetPanel( PANEL_GAMEUIDLL ) );
		OV_InstallConsoleTap();
	}

	return s_pOpenVibeMenu;
}

// OPENVIBE_CONSOLE_SPEW_TAP_BEGIN
//
// Mirrors engine console output into the HTML GUI console route. The chained
// tier0 spew hook records EVERY line into a ring buffer from client-mode init
// (so the GUI console gets full history, replacing the stock Source console);
// the panel's OnThink drains the backlog into window.OV.onConsoleLine([...])
// while visible, at most every 0.15s and 24 lines per flush. When the console
// runs hot the oldest unsent lines fall out of the ring (never blocks).

#define OV_CONSOLE_RING_LINES 400
#define OV_CONSOLE_FLUSH_MAX  24

static SpewOutputFunc_t s_PrevSpewFunc = NULL;
static bool s_bConsoleTapInstalled = false;
static bool s_bInConsoleTap = false; // reentrancy: a Msg inside RunJS must not recurse
static char s_ConsoleRing[OV_CONSOLE_RING_LINES][480];
static int64 s_nRingWritten = 0; // total lines ever written
static int64 s_nRingSent = 0;    // total lines ever flushed to the panel
static float s_flNextConsoleFlush = 0.0f;

static SpewRetval_t OV_ConsoleTapSpewFunc( SpewType_t spewType, const tchar *pMsg )
{
	// Always forward to the previous spew func first.
	SpewRetval_t ret = s_PrevSpewFunc ? s_PrevSpewFunc( spewType, pMsg ) : SPEW_CONTINUE;

	if ( !s_bInConsoleTap && pMsg && pMsg[0] )
	{
		s_bInConsoleTap = true;

		char *pszLine = s_ConsoleRing[s_nRingWritten % OV_CONSOLE_RING_LINES];
		int nWritten = 0;
		// Tag warnings/errors so the GUI can color them.
		if ( spewType == SPEW_WARNING || spewType == SPEW_ASSERT || spewType == SPEW_ERROR )
		{
			const char *pszTag = ( spewType == SPEW_WARNING ) ? "[warning] " : "[error] ";
			for ( const char *t = pszTag; *t && nWritten < (int)sizeof( s_ConsoleRing[0] ) - 1; ++t )
				pszLine[nWritten++] = *t;
		}
		for ( const char *p = pMsg; *p && nWritten < (int)sizeof( s_ConsoleRing[0] ) - 1; ++p )
			pszLine[nWritten++] = ( *p == '\n' || *p == '\r' ) ? ' ' : *p;
		while ( nWritten > 0 && pszLine[nWritten - 1] == ' ' )
			--nWritten;
		pszLine[nWritten] = '\0';

		if ( nWritten > 0 )
			++s_nRingWritten;

		s_bInConsoleTap = false;
	}

	return ret;
}

static void OV_InstallConsoleTap()
{
	if ( s_bConsoleTapInstalled )
		return;

	s_bConsoleTapInstalled = true;
	s_PrevSpewFunc = GetSpewOutputFunc();
	SpewOutputFunc( OV_ConsoleTapSpewFunc );
}

// Called from COpenVibeHTMLPanel::OnThink (i.e. only while the panel is visible).
static void OV_ConsoleTapThink()
{
	if ( !s_pOpenVibeMenu || s_nRingSent >= s_nRingWritten )
		return;

	const float flNow = Plat_FloatTime();
	if ( flNow < s_flNextConsoleFlush )
		return;
	s_flNextConsoleFlush = flNow + 0.15f;

	// If the writer lapped us, skip the lines the ring no longer holds.
	if ( s_nRingWritten - s_nRingSent > OV_CONSOLE_RING_LINES )
		s_nRingSent = s_nRingWritten - OV_CONSOLE_RING_LINES;

	char szScript[16384];
	Q_strncpy( szScript,
		"if(typeof window.OV==='object'&&typeof window.OV.onConsoleLine==='function')"
		"{window.OV.onConsoleLine([", sizeof( szScript ) );

	int nBatch = 0;
	while ( s_nRingSent < s_nRingWritten && nBatch < OV_CONSOLE_FLUSH_MAX )
	{
		char szLine[480];
		OV_SanitiseJSString( szLine, sizeof( szLine ), s_ConsoleRing[s_nRingSent % OV_CONSOLE_RING_LINES] );
		++s_nRingSent;

		if ( nBatch > 0 )
			Q_strncat( szScript, ",", sizeof( szScript ), COPY_ALL_CHARACTERS );
		Q_strncat( szScript, "'", sizeof( szScript ), COPY_ALL_CHARACTERS );
		Q_strncat( szScript, szLine, sizeof( szScript ), COPY_ALL_CHARACTERS );
		Q_strncat( szScript, "'", sizeof( szScript ), COPY_ALL_CHARACTERS );
		++nBatch;
	}

	Q_strncat( szScript, "]);}", sizeof( szScript ), COPY_ALL_CHARACTERS );

	// RunJS can itself Msg(); the guard keeps that spew out of the batch.
	s_bInConsoleTap = true;
	s_pOpenVibeMenu->RunJS( szScript );
	s_bInConsoleTap = false;
}

// Second consumer of the console ring: the client JS bridge drains lines and
// forwards them to the Node runtime, whose SSE log stream feeds the GUI
// console in EVERY host (launcher included). Returns false when caught up.
bool OpenVibe_DrainConsoleLine( int64 *pnCursor, char *pszOut, int nOutLen )
{
	if ( !pnCursor || !pszOut || nOutLen <= 0 )
		return false;

	if ( *pnCursor >= s_nRingWritten )
		return false;

	if ( s_nRingWritten - *pnCursor > OV_CONSOLE_RING_LINES )
		*pnCursor = s_nRingWritten - OV_CONSOLE_RING_LINES;

	Q_strncpy( pszOut, s_ConsoleRing[*pnCursor % OV_CONSOLE_RING_LINES], nOutLen );
	++( *pnCursor );
	return true;
}

// The OpenVibe HTML menu fully replaces the stock GameUI menu — both the main
// menu (out of a level) and the in-game pause menu (ESC during a level).
void OpenVibe_MenuKeepAlive()
{
	if ( !ov_menu_auto_open.GetBool() )
		return;

	// In-game: the engine opens the stock GameUI pause menu on ESC. Detect it
	// every frame (cheap bool) and instantly replace it with our translucent
	// pause overlay — no throttle, so there is no visible stock-menu flash.
	if ( engine->IsInGame() )
	{
		// CRITICAL: do nothing during the connect/signon handshake. The
		// loading screen is itself GameUI, so IsGameUIVisible() is true while
		// IsInGame() has already flipped true mid-signon; hiding it / opening
		// our panel then aborts the connection (client drops before spawning).
		// Only intercept once the level is fully drawn and we have a player.
		if ( engine->IsDrawingLoadingImage() || !engine->IsConnected() )
			return;

		const bool bStockUIVisible = enginevgui && enginevgui->IsGameUIVisible();
		// The HUD overlay is "visible" but is not a menu — ESC over it must
		// still swap the stock GameUI for our pause overlay.
		const bool bOursMenuVisible = s_pOpenVibeMenu && s_pOpenVibeMenu->IsVisible() && !s_pOpenVibeMenu->IsHudMode();
		if ( bStockUIVisible )
		{
			if ( !bOursMenuVisible )
			{
				// ESC from gameplay: replace the stock pause menu with ours.
				OV_GetHTMLMenu()->OpenPause();
			}
			else
			{
				// ESC while OUR menu is open re-raises stock GameUI over it
				// (that's how the leaked stock menu screenshot happens) —
				// treat it as "close": back to gameplay + HUD overlay.
				s_pOpenVibeMenu->CloseMenu();
			}
			return;
		}

		// Gameplay with no menus up: keep the transparent HTML HUD overlay
		// alive (first spawn after a map load, or after a force-hide).
		if ( !bStockUIVisible && ov_hud_html.GetBool() &&
			 ( !s_pOpenVibeMenu || !s_pOpenVibeMenu->IsVisible() ) )
		{
			OV_GetHTMLMenu()->EnterHudMode();
		}
		return;
	}

	// Out of a level: keep our menu covering the stock main menu. After a
	// connection error ("Connection failed after 4 retries") the engine
	// raises stock GameUI OVER our still-visible panel, so checking only
	// our own visibility left the stock menu on top — re-front whenever the
	// stock UI is up, and (throttled) re-open if we somehow got hidden.
	static float s_flNextCheck = 0.0f;
	const float flNow = Plat_FloatTime();
	if ( flNow < s_flNextCheck )
		return;
	s_flNextCheck = flNow + 0.5f;

	if ( !s_pOpenVibeMenu || !s_pOpenVibeMenu->IsVisible() )
	{
		OV_GetHTMLMenu()->Open();
	}
	else if ( enginevgui && enginevgui->IsGameUIVisible() )
	{
		// Ours is visible but the stock menu was raised above it (error
		// dialog path): re-front WITHOUT reloading the page — calling
		// Open() here re-OpenURL'd every tick and the menu reload-looped
		// while the engine's error dialog kept GameUI visible.
		s_pOpenVibeMenu->EnsureOnTop();
	}
}
// OPENVIBE_CONSOLE_SPEW_TAP_END

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
	// Install the console tap immediately so the GUI console has full history
	// from process start, even before the panel is first opened.
	OV_InstallConsoleTap();

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

	COpenVibeHTMLPanel *pMenu = OV_GetHTMLMenu();

	// In a level, any route opens as the translucent pause overlay so the game
	// stays visible behind it; at the main menu it is the full opaque shell.
	if ( engine->IsInGame() )
	{
		pMenu->OpenPause();
		char szScript[256];
		Q_snprintf( szScript, sizeof( szScript ),
			"if(window.OpenVibeShell&&typeof window.OpenVibeShell.setRoute==='function')"
			"{window.OpenVibeShell.setRoute('%s');}", pszSafeRoute );
		pMenu->RunJS( szScript );
		return;
	}

	pMenu->Open( szURL );
}

static void OV_MenuMain_f( const CCommand &args ) { OV_OpenMenuRoute( "portal" ); }
static void OV_MenuServers_f( const CCommand &args ) { OV_OpenMenuRoute( "servers" ); }
static void OV_MenuLeaderboard_f( const CCommand &args ) { OV_OpenMenuRoute( "leaderboard" ); }
static void OV_MenuInventory_f( const CCommand &args ) { OV_OpenMenuRoute( "inventory" ); }
static void OV_MenuShop_f( const CCommand &args ) { OV_OpenMenuRoute( "shop" ); }
static void OV_MenuSettings_f( const CCommand &args ) { OV_OpenMenuRoute( "settings" ); }
static void OV_MenuConsole_f( const CCommand &args ) { OV_OpenMenuRoute( "console" ); }
static void OV_MenuOptions_f( const CCommand &args ) { OV_OpenMenuRoute( "options" ); }

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

static ConCommand ov_menu_console_cmd(
	"ov_menu_console",
	OV_MenuConsole_f,
	"Open the OpenVibe console route.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_options_cmd(
	"ov_menu_options",
	OV_MenuOptions_f,
	"Open the OpenVibe options route.",
	FCVAR_CLIENTDLL );

// The OpenVibe console replaces the stock Source console: bind your console
// key to ov_console (cfg/openvibe_client_default.cfg does this) and it
// toggles the HTML console route.
static void OV_ConsoleToggle_f( const CCommand &args )
{
	COpenVibeHTMLPanel *pMenu = OV_GetHTMLMenu();

	// In HUD mode the panel is "visible" but is NOT an open menu — the
	// console key must open the pause menu on the console route, not
	// silently route the input-transparent overlay (which just made the
	// HUD vanish on the first press).
	if ( pMenu->IsVisible() && !pMenu->IsHudMode() )
	{
		if ( engine->IsInGame() )
		{
			// In a level: if the pause overlay is already on the console,
			// the console key returns to gameplay; otherwise switch to it.
			pMenu->RunJS(
				"if((location.hash||'').indexOf('console')>=0){window.location.href='openvibe://close';}"
				"else if(window.OpenVibeShell&&typeof window.OpenVibeShell.setRoute==='function')"
				"{window.OpenVibeShell.setRoute('console');}" );
			return;
		}

		// At the main menu the panel must never hide (the stock GameUI menu
		// sits behind it) — flip between the console and portal routes.
		pMenu->RunJS(
			"if(window.OpenVibeShell&&typeof window.OpenVibeShell.setRoute==='function')"
			"{window.OpenVibeShell.setRoute(((location.hash||'').indexOf('console')>=0)?'portal':'console');}" );
		return;
	}

	OV_OpenMenuRoute( "console" );
}

static ConCommand ov_console_cmd(
	"ov_console",
	OV_ConsoleToggle_f,
	"Toggle the OpenVibe HTML console (replacement for the stock console).",
	FCVAR_CLIENTDLL );
// OPENVIBE_UNIFIED_UI_ROUTE_COMMANDS_END

// OPENVIBE_STEAM_AUTH_BRIDGE_BEGIN

// Forward declaration: implemented in openvibe_client.cpp.
extern const char *OpenVibe_GetSessionToken();

// Sanitise a string for safe embedding in a JS single-quoted literal:
// strip characters that could break out of the string context.
static void OV_SanitiseJSString( char *pszOut, size_t nOut, const char *pszIn )
{
	if ( !pszIn || !pszOut || nOut == 0 )
	{
		if ( pszOut && nOut ) pszOut[0] = '\0';
		return;
	}

	size_t nWritten = 0;
	for ( const char *p = pszIn; *p && nWritten < nOut - 1; ++p )
	{
		unsigned char c = (unsigned char)*p;
		// Skip control chars, quotes, backslash, and angle brackets.
		if ( c < 32 || c == '\'' || c == '"' || c == '\\' || c == '<' || c == '>' )
			continue;
		pszOut[nWritten++] = *p;
	}
	pszOut[nWritten] = '\0';
}

// Called by COpenVibeSteamAuthClient after Steam ticket validation completes.
// Injects the result into the HTML page via RunJS.
void OpenVibe_NotifyHTMLSteamAuth( bool bSuccess, const char *pszToken, const char *pszSteamId, const char *pszDisplayName, const char *pszError )
{
	COpenVibeHTMLPanel *pMenu = s_pOpenVibeMenu;
	if ( !pMenu )
		return;

	char szToken[2048];
	char szSteamId[64];
	char szDisplayName[256];
	char szError[128];

	OV_SanitiseJSString( szToken,       sizeof( szToken ),       pszToken       ? pszToken       : "" );
	OV_SanitiseJSString( szSteamId,     sizeof( szSteamId ),     pszSteamId     ? pszSteamId     : "" );
	OV_SanitiseJSString( szDisplayName, sizeof( szDisplayName ), pszDisplayName ? pszDisplayName : "" );
	OV_SanitiseJSString( szError,       sizeof( szError ),       ( pszError && pszError[0] ) ? pszError : "steam_auth_failed" );

	char szScript[4096];
	if ( bSuccess )
	{
		Q_snprintf( szScript, sizeof( szScript ),
			"if(typeof window.OV==='object'&&typeof window.OV.onSteamAuthResult==='function')"
			"{window.OV.onSteamAuthResult({authenticated:true,sessionToken:'%s',steamId:'%s',displayName:'%s'});}",
			szToken, szSteamId, szDisplayName );
	}
	else
	{
		Q_snprintf( szScript, sizeof( szScript ),
			"if(typeof window.OV==='object'&&typeof window.OV.onSteamAuthResult==='function')"
			"{window.OV.onSteamAuthResult({authenticated:false,error:'%s'});}", szError );
	}

	pMenu->RunJS( szScript );
}

// Called when the web page navigates to openvibe://ready.
// Pushes any stored session token into the page so it can skip the auth screen.
void OpenVibe_OnHTMLReady()
{
	COpenVibeHTMLPanel *pMenu = s_pOpenVibeMenu;
	if ( !pMenu )
		return;

	const char *pszToken = OpenVibe_GetSessionToken();
	if ( !pszToken || !pszToken[0] )
		return;

	char szToken[2048];
	OV_SanitiseJSString( szToken, sizeof( szToken ), pszToken );

	char szScript[3072];
	Q_snprintf( szScript, sizeof( szScript ),
		"if(typeof window.OV==='object'&&typeof window.OV.onSteamAuthResult==='function')"
		"{window.OV.onSteamAuthResult({authenticated:true,sessionToken:'%s',steamId:'',displayName:''});}", szToken );

	pMenu->RunJS( szScript );
}

// OPENVIBE_STEAM_AUTH_BRIDGE_END
