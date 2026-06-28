// ov_hub.nut
// OpenVibe: Source — Hub server game script.
//
// The hub is a persistent social space.  Players can:
//   - Walk up to portal pads to travel to a minigame server.
//   - Visit the shop NPC to browse / buy cosmetics (handled by the web UI).
//   - Visit the inventory station to equip items.
//
// Server heartbeats are sent every 30 seconds so the backend knows the hub
// is alive and how many players are connected.
//
// This script does NOT manage rounds.  mp_timelimit 0 keeps the map running
// indefinitely.

DoIncludeScript("ov_shared", this)

// ---------------------------------------------------------------------------
// Configuration (override via convar or cfg)
// ---------------------------------------------------------------------------

local SERVER_ID     = "local-hub-27015"
local MODE          = "hub"
local MAX_PLAYERS   = 48
local HEARTBEAT_INTERVAL = 30.0

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

local g_NextHeartbeat   = 0.0
local g_BootSent        = false
local g_PlayerCount     = 0

// ---------------------------------------------------------------------------
// Think function
// ---------------------------------------------------------------------------

function HubThink() {
    local now = Time()

    // Boot registration (once)
    if (!g_BootSent) {
        OV_Emit("BOOT", SERVER_ID + " " + MODE)
        g_BootSent = true
    }

    // Periodic heartbeat
    if (now >= g_NextHeartbeat) {
        local players = OV_GetActivePlayers()
        g_PlayerCount = players.len()

        local state = "open"
        if (g_PlayerCount >= MAX_PLAYERS) state = "full"

        OV_Emit("HEARTBEAT", SERVER_ID + " " + g_PlayerCount + " " + MAX_PLAYERS + " " + state)
        g_NextHeartbeat = now + HEARTBEAT_INTERVAL
    }

    // Update portal labels with current server player counts
    // (In practice this would require HTTP — shown as commentary)

    return 5.0  // Check again in 5 seconds
}

// ---------------------------------------------------------------------------
// Player arrival / departure notifications
// ---------------------------------------------------------------------------

function OnGameEvent_player_team(params) {
    // Emitted when a player changes team.  In the hub every player is
    // assigned to team 2 (rebels) on spawn so they can move around.
    local uid  = params.userid
    local team = params.team
    if (team == OV_TEAM_A || team == OV_TEAM_B) {
        printl("[OV] HUB player uid=" + uid + " joined team " + team)
    }
}

function OnGameEvent_player_disconnect(params) {
    local name = params.name
    printl("[OV] HUB player disconnected: " + name)
}

// ---------------------------------------------------------------------------
// Portal pad interaction hints
// ---------------------------------------------------------------------------
// The map already has trigger_multiple → point_clientcommand → connect …
// These functions provide complementary console feedback.

function OnGameEvent_player_spawn(params) {
    local uid = params.userid
    local p = GetPlayerFromUserID(uid)
    if (p == null) return

    // Ensure every player is on team A (active) so they can play
    local team = NetProps.GetPropInt(p, "m_iTeamNum")
    if (team == OV_TEAM_UNASSIGNED || team == OV_TEAM_SPECTATOR) {
        OV_SetTeam(p, OV_TEAM_A)
    }

    // Welcome / orientation message
    printl("[OV] HUB welcome uid=" + uid + " name=" + p.GetPlayerName())
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function HubInit() {
    printl("[OV] ov_hub.nut initialising")
    g_NextHeartbeat = Time() + 2.0  // First heartbeat after 2 s
    OV_CreateThinkEnt("HubThink")
    printl("[OV] ov_hub.nut ready — server id: " + SERVER_ID)
}

HubInit()
