// ov_fortwars.nut
// OpenVibe: Source — Fort Wars game mode.
//
// Two teams compete.  The round has two phases:
//   BUILD  — teams set up defences; combat damage is disabled (godmode).
//   COMBAT — full combat; objective is to eliminate the enemy team.
//
// Win conditions (combat phase):
//   • All players on a team are dead.
//   • Time expires → team with most kills wins.
//
// Map setup notes:
//   • Team A (OV_TEAM_A = 2) starts at spawn "fw_spawn_a".
//   • Team B (OV_TEAM_B = 3) starts at spawn "fw_spawn_b".
//   • A neutral centre area contains building materials (prop_physics).

DoIncludeScript("ov_shared", this)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

local SERVER_ID      = "local-fortwars-27018"
local SERVER_SECRET  = "dev-secret"
local MODE           = "fortwars"
local MAX_PLAYERS    = 32
local MIN_PLAYERS    = 2
local BUILD_TIME     = 180.0  // 3 minutes
local COMBAT_TIME    = 300.0  // 5 minutes
local START_DELAY    = 5.0
local END_DELAY      = 10.0
local HEARTBEAT_INTERVAL = 30.0

local REWARD_WIN    = 100
local REWARD_LOSS   = 40
local REWARD_DRAW   = 60
local REWARD_XP_BASE = 120

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

local PHASE_WAITING = "waiting"
local PHASE_STARTING= "starting"
local PHASE_BUILD   = "build"
local PHASE_COMBAT  = "combat"
local PHASE_ENDED   = "ended"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

local g_Phase        = PHASE_WAITING
local g_PhaseEnd     = 0.0
local g_MatchId      = ""
local g_BootSent     = false
local g_NextHeartbeat= 0.0
local g_RoundCount   = 0
local g_WinTeam      = ""   // "a" | "b" | "draw"
local g_KillsA       = 0
local g_KillsB       = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function FW_GetTeamA() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (NetProps.GetPropInt(all[i], "m_iTeamNum") == OV_TEAM_A) out.append(all[i])
    }
    return out
}

function FW_GetTeamB() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (NetProps.GetPropInt(all[i], "m_iTeamNum") == OV_TEAM_B) out.append(all[i])
    }
    return out
}

function FW_RemainingTime() {
    local r = g_PhaseEnd - Time()
    return r < 0 ? 0 : r
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function FW_AssignTeams() {
    local all = OV_GetActivePlayers()
    OV_Shuffle(all)

    local half = (all.len() / 2).tointeger()
    for (local i = 0; i < all.len(); i++) {
        local team = (i < half) ? OV_TEAM_A : OV_TEAM_B
        NetProps.SetPropInt(all[i], "m_iTeamNum", team)
    }

    printl("[OV] FW teams assigned: A=" + FW_GetTeamA().len() + " B=" + FW_GetTeamB().len())
}

function FW_StartRound() {
    g_Phase    = PHASE_STARTING
    g_PhaseEnd = Time() + START_DELAY
    g_MatchId  = OV_GenMatchId(MODE)
    g_RoundCount++
    g_KillsA   = 0
    g_KillsB   = 0
    g_WinTeam  = ""

    FW_AssignTeams()
    OV_ChatAll("[Fort Wars] Round " + g_RoundCount + " — teams assigned! BUILD phase in " +
               START_DELAY.tointeger() + "s")
    printl("[OV] FW STARTING round=" + g_RoundCount)
}

function FW_StartBuild() {
    g_Phase    = PHASE_BUILD
    g_PhaseEnd = Time() + BUILD_TIME
    OV_ChatAll("[Fort Wars] BUILD phase! " + BUILD_TIME.tointeger() + "s to fortify. NO COMBAT.")
    printl("[OV] FW phase=BUILD buildTime=" + BUILD_TIME)
    // In a full C++ implementation we'd toggle combat flags here.
    // With VScript only, we rely on map design to keep teams separated.
}

function FW_StartCombat() {
    g_Phase    = PHASE_COMBAT
    g_PhaseEnd = Time() + COMBAT_TIME
    OV_ChatAll("[Fort Wars] COMBAT! Eliminate the enemy team! " + COMBAT_TIME.tointeger() + "s left.")
    printl("[OV] FW phase=COMBAT combatTime=" + COMBAT_TIME)
}

function FW_EndRound(winTeam) {
    if (g_Phase == PHASE_ENDED) return
    g_Phase    = PHASE_ENDED
    g_PhaseEnd = Time() + END_DELAY
    g_WinTeam  = winTeam

    if (winTeam == "a") {
        OV_ChatAll("[Fort Wars] TEAM A WINS! " + g_KillsA + " kills vs " + g_KillsB)
    } else if (winTeam == "b") {
        OV_ChatAll("[Fort Wars] TEAM B WINS! " + g_KillsB + " kills vs " + g_KillsA)
    } else {
        OV_ChatAll("[Fort Wars] DRAW! A:" + g_KillsA + " B:" + g_KillsB)
    }

    FW_EmitRewards(winTeam)
    printl("[OV] FW phase=ENDED winner=" + winTeam)
}

function FW_EmitRewards(winTeam) {
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p    = all[i]
        local uid  = p.GetUserID().tostring()
        local team = NetProps.GetPropInt(p, "m_iTeamNum")

        local cur = REWARD_DRAW
        local xp  = REWARD_XP_BASE

        if (winTeam == "draw") {
            cur = REWARD_DRAW
        } else if (winTeam == "a" && team == OV_TEAM_A) {
            cur = REWARD_WIN
            xp  = REWARD_XP_BASE + 30
        } else if (winTeam == "b" && team == OV_TEAM_B) {
            cur = REWARD_WIN
            xp  = REWARD_XP_BASE + 30
        } else {
            cur = REWARD_LOSS
        }

        OV_Emit("REWARD", g_MatchId + " " + SERVER_ID + " " + SERVER_SECRET +
                          " " + uid + " " + MODE + " " + cur + " " + xp)
    }
}

function FW_Reset() {
    g_Phase   = PHASE_WAITING
    g_MatchId = ""
    g_WinTeam = ""
    g_KillsA  = 0
    g_KillsB  = 0
    printl("[OV] FW reset to WAITING")
}

// ---------------------------------------------------------------------------
// Win condition checks
// ---------------------------------------------------------------------------

function FW_CheckWin() {
    if (g_Phase != PHASE_COMBAT) return

    local aliveA = OV_CountAliveOnTeam(OV_TEAM_A)
    local aliveB = OV_CountAliveOnTeam(OV_TEAM_B)

    if (aliveA == 0 && aliveB == 0) {
        FW_EndRound("draw")
    } else if (aliveA == 0) {
        FW_EndRound("b")
    } else if (aliveB == 0) {
        FW_EndRound("a")
    } else if (Time() >= g_PhaseEnd) {
        // Time expired — compare kills
        if (g_KillsA > g_KillsB) {
            FW_EndRound("a")
        } else if (g_KillsB > g_KillsA) {
            FW_EndRound("b")
        } else {
            FW_EndRound("draw")
        }
    }
}

// ---------------------------------------------------------------------------
// Main think
// ---------------------------------------------------------------------------

function FWThink() {
    local now = Time()

    if (!g_BootSent) {
        OV_Emit("BOOT", SERVER_ID + " " + MODE)
        g_BootSent = true
    }

    if (now >= g_NextHeartbeat) {
        local cnt   = OV_GetActivePlayers().len()
        local state = (g_Phase == PHASE_WAITING) ? "open" : "full"
        if (cnt >= MAX_PLAYERS) state = "full"
        OV_Emit("HEARTBEAT", SERVER_ID + " " + cnt + " " + MAX_PLAYERS + " " + state)
        g_NextHeartbeat = now + HEARTBEAT_INTERVAL
    }

    if (g_Phase == PHASE_WAITING) {
        if (OV_GetActivePlayers().len() >= MIN_PLAYERS) FW_StartRound()
        return 5.0

    } else if (g_Phase == PHASE_STARTING) {
        if (now >= g_PhaseEnd) FW_StartBuild()
        return 1.0

    } else if (g_Phase == PHASE_BUILD) {
        local rem = FW_RemainingTime().tointeger()
        if (rem <= 10 && rem > 0) {
            OV_ChatAll("[Fort Wars] COMBAT starts in " + rem + "s!")
        }
        if (now >= g_PhaseEnd) FW_StartCombat()
        return 1.0

    } else if (g_Phase == PHASE_COMBAT) {
        FW_CheckWin()
        return 1.0

    } else if (g_Phase == PHASE_ENDED) {
        if (now >= g_PhaseEnd) FW_Reset()
        return 2.0
    }

    return 2.0
}

// ---------------------------------------------------------------------------
// Game events
// ---------------------------------------------------------------------------

function OnGameEvent_player_death(params) {
    if (g_Phase != PHASE_COMBAT) return

    local uid      = params.userid
    local attacker = params.attacker

    // Figure out teams and update kill counter
    local dead = GetPlayerFromUserID(uid)
    local atk  = GetPlayerFromUserID(attacker)

    if (dead != null && atk != null && uid != attacker) {
        local deadTeam = NetProps.GetPropInt(dead, "m_iTeamNum")
        local atkTeam  = NetProps.GetPropInt(atk,  "m_iTeamNum")

        if (atkTeam == OV_TEAM_A && deadTeam == OV_TEAM_B) g_KillsA++
        if (atkTeam == OV_TEAM_B && deadTeam == OV_TEAM_A) g_KillsB++

        printl("[OV] FW kill by uid=" + attacker + " on uid=" + uid +
               " score A=" + g_KillsA + " B=" + g_KillsB)
    }
}

function OnGameEvent_player_disconnect(params) {
    if (g_Phase == PHASE_BUILD || g_Phase == PHASE_COMBAT || g_Phase == PHASE_STARTING) {
        if (OV_GetActivePlayers().len() < MIN_PLAYERS) {
            OV_ChatAll("[Fort Wars] Not enough players — round cancelled.")
            FW_Reset()
        }
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function FWInit() {
    printl("[OV] ov_fortwars.nut initialising")
    g_NextHeartbeat = Time() + 3.0
    OV_CreateThinkEnt("FWThink")
    printl("[OV] ov_fortwars.nut ready — server id: " + SERVER_ID)
}

FWInit()
