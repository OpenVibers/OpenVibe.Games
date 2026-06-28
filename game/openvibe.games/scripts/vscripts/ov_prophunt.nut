// ov_prophunt.nut
// OpenVibe: Source — Prop Hunt game mode.
//
// Phases:
//   WAITING  — fewer than MIN_PLAYERS connected; loop and wait.
//   PREP     — roles assigned; hunters are frozen for HIDE_TIME seconds.
//   HIDE     — props scatter; hunters cannot see/move.
//   HUNT     — hunters chase props; first team to eliminate the other wins.
//   ENDED    — brief end screen; currency awarded; map restarts.
//
// Team assignments:
//   OV_TEAM_A (2) = Props     — survive until time expires.
//   OV_TEAM_B (3) = Hunters   — eliminate all props before time expires.
//
// Sidecar protocol:
//   [OV] BOOT   serverId mode
//   [OV] HEARTBEAT serverId playerCount maxPlayers state
//   [OV] REWARD matchId serverId serverSecret steamId mode currency xp

DoIncludeScript("ov_shared", this)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

local SERVER_ID     = "local-prophunt-27016"
local SERVER_SECRET = "dev-secret"
local MODE          = "prophunt"
local MAX_PLAYERS   = 24
local MIN_PLAYERS   = 2
local HIDE_TIME     = 30.0    // seconds props have to hide
local HUNT_TIME     = 180.0   // seconds hunters have to find all props
local END_DELAY     = 8.0     // seconds before map restart after round ends
local HEARTBEAT_INTERVAL = 30.0

// Reward tables
local REWARD_PROP_SURVIVE   = 75   // currency for props that survive full hunt
local REWARD_PROP_PARTIAL   = 40   // props that survived but hunt ended by kill
local REWARD_HUNTER_WIN     = 60   // hunters when all props are killed
local REWARD_HUNTER_LOSS    = 20   // hunters when time expires
local REWARD_XP_BASE        = 80

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

local PHASE_WAITING = "waiting"
local PHASE_PREP    = "prep"
local PHASE_HIDE    = "hide"
local PHASE_HUNT    = "hunt"
local PHASE_ENDED   = "ended"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

local g_Phase           = PHASE_WAITING
local g_PhaseEnd        = 0.0
local g_MatchId         = ""
local g_PropsAtStart    = 0
local g_HuntersAtStart  = 0
local g_WinTeam         = ""  // "props" | "hunters"
local g_BootSent        = false
local g_NextHeartbeat   = 0.0
local g_RoundCount      = 0

// Tracks which props have survived the round (for partial rewards)
local g_PropsSurvived   = {}  // steamId → true/false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function PH_GetProps() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (NetProps.GetPropInt(all[i], "m_iTeamNum") == OV_TEAM_A) out.append(all[i])
    }
    return out
}

function PH_GetHunters() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (NetProps.GetPropInt(all[i], "m_iTeamNum") == OV_TEAM_B) out.append(all[i])
    }
    return out
}

function PH_PlayerLabel(player) {
    local name = player.GetPlayerName()
    return name + " (uid=" + player.GetUserID() + ")"
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function PH_StartPrep() {
    g_Phase     = PHASE_PREP
    g_PhaseEnd  = Time() + HIDE_TIME
    g_MatchId   = OV_GenMatchId(MODE)
    g_RoundCount++

    // Assign teams: first player → hunter, rest → props
    local all = OV_GetActivePlayers()
    OV_Shuffle(all)

    // At least one hunter; one prop minimum
    local hunterIdx = 0
    NetProps.SetPropInt(all[hunterIdx], "m_iTeamNum", OV_TEAM_B)

    for (local i = 1; i < all.len(); i++) {
        NetProps.SetPropInt(all[i], "m_iTeamNum", OV_TEAM_A)
    }

    g_PropsAtStart   = all.len() - 1
    g_HuntersAtStart = 1
    g_PropsSurvived  = {}

    // Log role assignments
    printl("[OV] PH PREP round=" + g_RoundCount + " matchId=" + g_MatchId)
    local hunter = all[hunterIdx]
    printl("[OV] PH hunter=" + PH_PlayerLabel(hunter))
    for (local i = 1; i < all.len(); i++) {
        printl("[OV] PH prop=" + PH_PlayerLabel(all[i]))
    }

    OV_ChatAll("[Prop Hunt] PREP — props have " + HIDE_TIME.tointeger() + "s to hide!")
    printl("[OV] PH phase=PREP hideTime=" + HIDE_TIME)
}

function PH_StartHide() {
    g_Phase    = PHASE_HIDE
    g_PhaseEnd = Time() + HIDE_TIME
    OV_ChatAll("[Prop Hunt] HIDE — hunters, get ready!")
    printl("[OV] PH phase=HIDE")
}

function PH_StartHunt() {
    g_Phase    = PHASE_HUNT
    g_PhaseEnd = Time() + HUNT_TIME
    OV_ChatAll("[Prop Hunt] HUNT — hunters are FREE! " + HUNT_TIME.tointeger() + "s remaining!")
    printl("[OV] PH phase=HUNT huntTime=" + HUNT_TIME)

    // Re-enable hunter damage (they were in prep/hide so combat was suppressed)
    // In a real implementation we'd toggle godmode flags here.
}

function PH_EndRound(winTeam) {
    if (g_Phase == PHASE_ENDED) return
    g_Phase   = PHASE_ENDED
    g_PhaseEnd = Time() + END_DELAY
    g_WinTeam = winTeam

    if (winTeam == "hunters") {
        OV_ChatAll("[Prop Hunt] HUNTERS WIN! All props eliminated.")
    } else {
        OV_ChatAll("[Prop Hunt] PROPS WIN! Time expired with survivors.")
    }

    // Emit rewards for all participants
    PH_EmitRewards(winTeam)

    printl("[OV] PH phase=ENDED winner=" + winTeam)
}

function PH_EmitRewards(winTeam) {
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p   = all[i]
        local uid = p.GetUserID().tostring()
        local team = NetProps.GetPropInt(p, "m_iTeamNum")

        local cur = 0
        local xp  = REWARD_XP_BASE

        if (team == OV_TEAM_A) {
            // Props
            local alive = (NetProps.GetPropInt(p, "m_lifeState") == OV_LIFE_ALIVE)
            if (winTeam == "props") {
                cur = alive ? REWARD_PROP_SURVIVE : REWARD_PROP_PARTIAL
            } else {
                cur = alive ? REWARD_PROP_PARTIAL : 10
            }
        } else if (team == OV_TEAM_B) {
            // Hunters
            cur = (winTeam == "hunters") ? REWARD_HUNTER_WIN : REWARD_HUNTER_LOSS
        }

        // [OV] REWARD matchId serverId serverSecret steamId mode currency xp
        // NOTE: steamId is approximated by uid here; the sidecar can map via player list.
        OV_Emit("REWARD", g_MatchId + " " + SERVER_ID + " " + SERVER_SECRET +
                          " " + uid + " " + MODE + " " + cur + " " + xp)
    }
}

function PH_ResetRound() {
    g_Phase      = PHASE_WAITING
    g_MatchId    = ""
    g_WinTeam    = ""
    g_PropsAtStart  = 0
    g_HuntersAtStart = 0
    g_PropsSurvived = {}
    printl("[OV] PH reset to WAITING")
}

// ---------------------------------------------------------------------------
// Win condition checks
// ---------------------------------------------------------------------------

function PH_CheckWinConditions() {
    if (g_Phase != PHASE_HUNT) return

    local aliveProps   = OV_CountAliveOnTeam(OV_TEAM_A)
    local aliveHunters = OV_CountAliveOnTeam(OV_TEAM_B)

    // All props dead → hunters win
    if (aliveProps == 0 && g_PropsAtStart > 0) {
        PH_EndRound("hunters")
        return
    }

    // All hunters dead → props win (shouldn't happen normally)
    if (aliveHunters == 0 && g_HuntersAtStart > 0) {
        PH_EndRound("props")
        return
    }

    // Time expired → props win
    if (Time() >= g_PhaseEnd) {
        PH_EndRound("props")
        return
    }
}

// ---------------------------------------------------------------------------
// Main think
// ---------------------------------------------------------------------------

function PHThink() {
    local now = Time()

    // Boot
    if (!g_BootSent) {
        OV_Emit("BOOT", SERVER_ID + " " + MODE)
        g_BootSent = true
    }

    // Heartbeat
    if (now >= g_NextHeartbeat) {
        local players = OV_GetActivePlayers()
        local cnt     = players.len()
        local state   = g_Phase == PHASE_WAITING ? "open" : "full"
        if (cnt >= MAX_PLAYERS) state = "full"
        OV_Emit("HEARTBEAT", SERVER_ID + " " + cnt + " " + MAX_PLAYERS + " " + state)
        g_NextHeartbeat = now + HEARTBEAT_INTERVAL
    }

    // Phase state machine
    if (g_Phase == PHASE_WAITING) {
        local cnt = OV_GetActivePlayers().len()
        if (cnt >= MIN_PLAYERS) {
            OV_ChatAll("[Prop Hunt] Enough players — starting in 5 seconds!")
            PH_StartPrep()
        }
        return 5.0

    } else if (g_Phase == PHASE_PREP) {
        if (now >= g_PhaseEnd) {
            PH_StartHide()
        }
        return 1.0

    } else if (g_Phase == PHASE_HIDE) {
        if (now >= g_PhaseEnd) {
            PH_StartHunt()
        }
        return 1.0

    } else if (g_Phase == PHASE_HUNT) {
        PH_CheckWinConditions()
        return 1.0

    } else if (g_Phase == PHASE_ENDED) {
        if (now >= g_PhaseEnd) {
            PH_ResetRound()
        }
        return 2.0
    }

    return 2.0
}

// ---------------------------------------------------------------------------
// Game event hooks
// ---------------------------------------------------------------------------

function OnGameEvent_player_death(params) {
    if (g_Phase != PHASE_HUNT) return
    local uid = params.userid
    local att = params.attacker
    printl("[OV] PH death uid=" + uid + " attacker=" + att)
    // Win check happens in think loop
}

function OnGameEvent_player_disconnect(params) {
    // If a team drops below threshold, end the round cleanly
    if (g_Phase == PHASE_HUNT || g_Phase == PHASE_HIDE || g_Phase == PHASE_PREP) {
        local cnt = OV_GetActivePlayers().len()
        if (cnt < MIN_PLAYERS) {
            OV_ChatAll("[Prop Hunt] Not enough players — round cancelled.")
            PH_ResetRound()
        }
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function PHInit() {
    printl("[OV] ov_prophunt.nut initialising")
    g_NextHeartbeat = Time() + 3.0
    OV_CreateThinkEnt("PHThink")
    printl("[OV] ov_prophunt.nut ready — server id: " + SERVER_ID)
}

PHInit()
