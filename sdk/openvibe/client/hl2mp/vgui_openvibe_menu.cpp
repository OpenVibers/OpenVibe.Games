// OpenVibe: Source VGUI portal panel.
//
// This is intentionally small and native.  The Electron launcher is still the
// rich desktop menu, while this panel gives the Source client an in-game
// OpenVibe-first menu that can replace the normal server-browser workflow.

#include "cbase.h"
#include "cdll_client_int.h"
#include "ienginevgui.h"

#include <vgui/IScheme.h>
#include <vgui/ISurface.h>
#include <vgui_controls/Button.h>
#include <vgui_controls/Frame.h>
#include <vgui_controls/Label.h>

// memdbgon must be the last include file in a .cpp file.
#include "tier0/memdbgon.h"

using namespace vgui;

class COpenVibeMenuPanel : public Frame
{
	DECLARE_CLASS_SIMPLE( COpenVibeMenuPanel, Frame );

public:
	COpenVibeMenuPanel( VPANEL parent ) :
		BaseClass( NULL, "OpenVibeMenuPanel" )
	{
		SetParent( parent );
		SetTitle( "OpenVibe: Source", true );
		SetSize( 760, 500 );
		SetMinimumSize( 640, 420 );
		SetSizeable( false );
		SetMoveable( true );
		SetDeleteSelfOnClose( false );
		SetBgColor( Color( 18, 20, 28, 245 ) );

		int sw = 0;
		int sh = 0;
		surface()->GetScreenSize( sw, sh );
		SetPos( ( sw - GetWide() ) / 2, ( sh - GetTall() ) / 2 );

		Label *pTitle = new Label( this, "OpenVibeTitle", "OpenVibe.Games" );
		pTitle->SetPos( 28, 36 );
		pTitle->SetSize( 420, 32 );
		pTitle->SetFgColor( Color( 0, 210, 255, 255 ) );

		Label *pSubtitle = new Label( this, "OpenVibeSubtitle", "Choose a hub or minigame server. Travel is routed through the OpenVibe backend." );
		pSubtitle->SetPos( 28, 70 );
		pSubtitle->SetSize( 680, 24 );
		pSubtitle->SetFgColor( Color( 220, 230, 240, 255 ) );

		AddModeButton( "Hub", "Social lobby, portals, NPCs, shops", "hub", 28, 120 );
		AddModeButton( "Prop Hunt", "Props disguise and hide from hunters", "prophunt", 390, 120 );
		AddModeButton( "Deathrun", "Runners survive traps and reach the finish", "deathrun", 28, 220 );
		AddModeButton( "Fort Wars", "Build phase, prop forts, combat phase", "fortwars", 390, 220 );
		AddModeButton( "Traitor Town", "Social deduction with traitors and innocents", "traitortown", 28, 320 );

		Button *pWebsite = new Button( this, "OpenWebsite", "Open openvibe.games", this, "website" );
		pWebsite->SetPos( 390, 320 );
		pWebsite->SetSize( 320, 44 );

		Button *pClose = new Button( this, "Close", "Close", this, "close" );
		pClose->SetPos( 590, 430 );
		pClose->SetSize( 120, 36 );
	}

	void OnCommand( const char *pszCommand ) OVERRIDE
	{
		if ( !Q_strncmp( pszCommand, "join:", 5 ) )
		{
			engine->ClientCmd_Unrestricted( VarArgs( "gameui_hide\nov_join %s\n", pszCommand + 5 ) );
			SetVisible( false );
			return;
		}

		if ( !Q_stricmp( pszCommand, "website" ) )
		{
			engine->ClientCmd_Unrestricted( "ov_open_url https://openvibe.games\n" );
			return;
		}

		if ( !Q_stricmp( pszCommand, "close" ) )
		{
			SetVisible( false );
			return;
		}

		BaseClass::OnCommand( pszCommand );
	}

private:
	void AddModeButton( const char *pszName, const char *pszDescription, const char *pszMode, int x, int y )
	{
		char szButtonName[64];
		char szCommand[64];
		char szDescriptionName[64];
		Q_snprintf( szButtonName, sizeof( szButtonName ), "%sButton", pszMode );
		Q_snprintf( szCommand, sizeof( szCommand ), "join:%s", pszMode );
		Q_snprintf( szDescriptionName, sizeof( szDescriptionName ), "%sDescription", pszMode );

		Button *pButton = new Button( this, szButtonName, pszName, this, szCommand );
		pButton->SetPos( x, y );
		pButton->SetSize( 320, 48 );

		Label *pDescription = new Label( this, szDescriptionName, pszDescription );
		pDescription->SetPos( x + 2, y + 52 );
		pDescription->SetSize( 320, 26 );
		pDescription->SetFgColor( Color( 185, 195, 205, 255 ) );
	}
};

static COpenVibeMenuPanel *s_pOpenVibeMenu = NULL;

static void OV_OpenMenu()
{
	if ( !s_pOpenVibeMenu )
	{
		s_pOpenVibeMenu = new COpenVibeMenuPanel( enginevgui->GetPanel( PANEL_GAMEUIDLL ) );
	}

	s_pOpenVibeMenu->SetVisible( true );
	s_pOpenVibeMenu->MoveToFront();
	s_pOpenVibeMenu->RequestFocus();
}

static void OV_OpenMenu_f( const CCommand &args )
{
	OV_OpenMenu();
}

static ConCommand openvibe_menu_cmd(
	"openvibe_menu",
	OV_OpenMenu_f,
	"Open the OpenVibe hub/minigame selection menu.",
	FCVAR_CLIENTDLL );

static ConCommand ov_menu_cmd(
	"ov_menu",
	OV_OpenMenu_f,
	"Open the OpenVibe hub/minigame selection menu.",
	FCVAR_CLIENTDLL );
