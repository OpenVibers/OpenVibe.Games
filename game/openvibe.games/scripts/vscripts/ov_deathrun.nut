// ov_deathrun.nut
// OpenVibe: Source — Deathrun game mode.
//
// One player is the Activator (team B); everyone else is a Runner (team A).
// Runners attempt to traverse a trap-filled course.
// The Activator fires traps (via trigger_multiple entities in the map).
// Each trap trigger is named "trap_NN" and wired to a killing hazard.
//
// Phases:
//   WAITING   — waiting for MIN_PLAYERS.
//   STARTING  — brief countdown; teams assigned.
//   ACTIVE    — runners run, activator operates traps.
//   ENDED     — results shown; rewards emitted.
//
// Win conditions:
//   Runners win  → at least one runner reaches the finish (info_target "finish_line")
//                  OR time expires with any runner alive.
//   Activator wins → all runners are dead before time expires.

DoIncludeScript("ov_shared", this)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

local SERVER_ID      = "local-deathrun-27017"
local SERVER_SECRET  = "dev-secret"
local MODE           = "deathrun"
local MAX_PLAYERS    = 24
local MIN_PLAYERS    = 2
local ROUND_TIME     = 240.0   // 4 minutes for runners to finish
local START_DELAY    = 5.0
local END_DELAY      = 8.0
local HEARTBEAT_INTERVAL = 30.0

local REWARD_RUNNER_WIN   = 80
local REWARD_RUNNER_LOSS  = 25
local REWARD_ACTIVATOR_WIN  = 60
local REWARD_ACTIVATOR_LOSS = 30
local REWARD_XP_BASE      = 90

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

local PHASE_WAITING  = "waiting"
local PHASE_STARTING = "starting"
local PHASE_ACTIVE   = "active"
local PHASE_ENDED    = "ended"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

local g_Phase        = PHASE_WAITING
local g_PhaseEnd     = 0.0
local g_MatchId      = ""
local g_BootSent     = false
local g_NextHeartbeat= 0.0
local g_RoundCount   = 0
local g_WinTeam      = ""         // "runners" | "activator"
local g_ActivatorUid = -1
local g_RunnersAtStart = 0
local g_FinishedRunners = 0       // runners who reached finish

// Previous alive counts for detecting deaths during active phase
local g_PrevAliveRunners = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function DR_GetRunners() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (NetProps.GetPropInt(all[i], "m_iTeamNum") == OV_TEAM_A) out.append(all[i])
    }
    return out
}

function DR_GetActivator() {
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p = all[i]
        if (NetProps.GetPropInt(p, "m_iTeamNum") == OV_TEAM_B) return p
    }
    return null
}

function DR_RemainingTime() {
    local rem = g_PhaseEnd - Time()
    return rem < 0 ? 0 : rem
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function DR_StartRound() {
    g_Phase    = PHASE_STARTING
    g_PhaseEnd = Time() + START_DELAY
    g_MatchId  = OV_GenMatchId(MODE)
    g_RoundCount++
    g_FinishedRunners = 0
    g_WinTeam  = ""

    // Assign teams: one random activator
    local all = OV_GetActivePlayers()
    OV_Shuffle(all)

    NetProps.SetPropInt(all[0], "m_iTeamNum", OV_TEAM_B)
    g_ActivatorUid = all[0].GetUserID()

    for (local i = 1; i < all.len(); i++) {
        NetProps.SetPropInt(all[i], "m_iTeamNum", OV_TEAM_A)
    }

    g_RunnersAtStart = all.len() - 1
    g_PrevAliveRunners = g_RunnersAtStart

    OV_ChatAll("[Deathrun] " + all[0].GetPlayerName() + " is the ACTIVATOR! Round " + g_RoundCount)
    printl("[OV] DR STARTING round=" + g_RoundCount + " activator=" + g_ActivatorUid)
}

function DR_GoActive() {
    g_Phase    = PHASE_ACTIVE
    g_PhaseEnd = Time() + ROUND_TIME
    OV_ChatAll("[Deathrun] GO! Runners, reach the end! Time: " + ROUND_TIME.tointeger() + "s")
    printl("[OV] DR phase=ACTIVE roundTime=" + ROUND_TIME)
}

function DR_EndRound(winTeam) {
    if (g_Phase == PHASE_ENDED) return
    g_Phase   = PHASE_ENDED
    g_PhaseEnd = Time() + END_DELAY
    g_WinTeam = winTeam

    if (winTeam == "runners") {
        OV_ChatAll("[Deathrun] RUNNERS WIN! " + g_FinishedRunners + " made it to the end.")
    } else {
        OV_ChatAll("[Deathrun] ACTIVATOR WINS! All runners eliminated.")
    }

    DR_EmitRewards(winTeam)
    printl("[OV] DR phase=ENDED winner=" + winTeam)
}

function DR_EmitRewards(winTeam) {
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p    = all[i]
        local uid  = p.GetUserID().tostring()
        local team = NetProps.GetPropInt(p, "m_iTeamNum")

        local cur = 0
        local xp  = REWARD_XP_BASE

        if (team == OV_TEAM_A) {
            cur = (winTeam == "runners") ? REWARD_RUNNER_WIN : REWARD_RUNNER_LOSS
        } else {
            cur = (winTeam == "activator") ? REWARD_ACTIVATOR_WIN : REWARD_ACTIVATOR_LOSS
        }

        OV_Emit("REWARD", g_MatchId + " " + SERVER_ID + " " + SERVER_SECRET +
                          " " + uid + " " + MODE + " " + cur + " " + xp)
    }
}

function DR_Reset() {
    g_Phase        = PHASE_WAITING
    g_MatchId      = ""
    g_WinTeam      = ""
    g_ActivatorUid = -1
    g_RunnersAtStart = 0
    g_FinishedRunners = 0
    printl("[OV] DR reset to WAITING")
}

// ---------------------------------------------------------------------------
// Win conditions
// ---------------------------------------------------------------------------

function DR_CheckWin() {
    if (g_Phase != PHASE_ACTIVE) return

    local aliveRunners = OV_CountAliveOnTeam(OV_TEAM_A)
    local activator    = DR_GetActivator()
    local activatorAlive = (activator != null &&
                            NetProps.GetPropInt(activator, "m_lifeState") == OV_LIFE_ALIVE)

    // All runners dead → activator wins
    if (aliveRunners == 0 && g_RunnersAtStart > 0) {
        DR_EndRound("activator")
        return
    }

    // Activator dead → runners can proceed (optional: auto-win for runners)
    if (!activatorAlive) {
        OV_ChatAll("[Deathrun] Activator died! No more traps.")
    }

    // Time expired with any runner alive → runners win
    if (Time() >= g_PhaseEnd) {
        if (aliveRunners > 0) {
            DR_EndRound("runners")
        } else {
            DR_EndRound("activator")
        }
        return
    }

    // Update death chat if runners died since last check
    if (aliveRunners < g_PrevAliveRunners) {
        local dead = g_PrevAliveRunners - aliveRunners
        OV_ChatAll("[Deathrun] " + dead + " runner(s) eliminated! " +
                   aliveRunners + " remaining. " +
                   OV_SecondsToMMSS(DR_RemainingTime().tointeger()) + " left.")
        g_PrevAliveRunners = aliveRunners
    }
}

// ---------------------------------------------------------------------------
// Finish line detection
// The map should have a trigger_multiple named "finish_trigger" whose
// OnStartTouch fires "ov_finish_touch".
// ---------------------------------------------------------------------------

function OnFinishTouch(activator) {
    if (g_Phase != PHASE_ACTIVE) return
    if (activator == null || !activator.IsPlayer()) return
    local team = NetProps.GetPropInt(activator, "m_iTeamNum")
    if (team != OV_TEAM_A) return

    g_FinishedRunners++
    OV_ChatAll("[Deathrun] " + activator.GetPlayerName() + " FINISHED! (" + g_FinishedRunners + " total)")
    printl("[OV] DR finish uid=" + activator.GetUserID() + " finishedCount=" + g_FinishedRunners)

    // First finisher wins the round for runners
    if (g_FinishedRunners == 1) {
        DR_EndRound("runners")
    }
}

// ---------------------------------------------------------------------------
// Main think
// ---------------------------------------------------------------------------

function DRThink() {
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
        if (OV_GetActivePlayers().len() >= MIN_PLAYERS) {
            DR_StartRound()
        }
        return 5.0

    } else if (g_Phase == PHASE_STARTING) {
        if (now >= g_PhaseEnd) DR_GoActive()
        return 1.0

    } else if (g_Phase == PHASE_ACTIVE) {
        DR_CheckWin()
        return 1.0

    } else if (g_Phase == PHASE_ENDED) {
        if (now >= g_PhaseEnd) DR_Reset()
        return 2.0
    }

    return 2.0
}

// ---------------------------------------------------------------------------
// Game events
// ---------------------------------------------------------------------------

function OnGameEvent_player_death(params) {
    if (g_Phase == PHASE_ACTIVE) {
        local uid  = params.userid
        local team = -1
        local p = GetPlayerFromUserID(uid)
        if (p != null) team = NetProps.GetPropInt(p, "m_iTeamNum")
        printl("[OV] DR death uid=" + uid + " team=" + team)
    }
}

function OnGameEvent_player_disconnect(params) {
    if (g_Phase == PHASE_ACTIVE || g_Phase == PHASE_STARTING) {
        if (OV_GetActivePlayers().len() < MIN_PLAYERS) {
            OV_ChatAll("[Deathrun] Not enough players — round cancelled.")
            DR_Reset()
        }
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function DRInit() {
    printl("[OV] ov_deathrun.nut initialising")
    g_NextHeartbeat = Time() + 3.0
    OV_CreateThinkEnt("DRThink")
    printl("[OV] ov_deathrun.nut ready — server id: " + SERVER_ID)
}

DRInit()
