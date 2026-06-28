// ov_traitortown.nut
// OpenVibe: Source — Traitor Town (TTT-style) game mode.
//
// Roles:
//   Innocents  — OV_TEAM_A (team 2). Survive; identify and kill traitors.
//   Traitors   — OV_TEAM_B (team 3). Secretly eliminate all innocents.
//   Detective  — OV_TEAM_A but flagged in g_DetectiveUid.
//                Has special tools; can investigate corpses.
//
// Role counts:
//   Traitors  ≈ floor(playerCount * 0.15)  (min 1, max 3)
//   Detective = 1 (if playerCount >= 5)
//   Innocents = remainder
//
// Phases:
//   WAITING    — min players not met.
//   PREP       — roles assigned; 5 s grace.
//   ACTIVE     — main gameplay.
//   ENDED      — round over; rewards distributed.
//
// Win conditions:
//   Traitors win  → all innocents (including detective) dead.
//   Innocents win → all traitors dead before time expires.
//   Time draw     → nobody wins clearly → innocents win by default.

DoIncludeScript("ov_shared", this)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

local SERVER_ID      = "local-traitortown-27019"
local SERVER_SECRET  = "dev-secret"
local MODE           = "traitortown"
local MAX_PLAYERS    = 24
local MIN_PLAYERS    = 3
local PREP_TIME      = 8.0
local ROUND_TIME     = 360.0   // 6 minutes
local END_DELAY      = 10.0
local HEARTBEAT_INTERVAL = 30.0

local REWARD_WIN       = 90
local REWARD_LOSS      = 30
local REWARD_DETECTIVE = 20  // bonus for detective
local REWARD_XP_BASE   = 100

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

local PHASE_WAITING = "waiting"
local PHASE_PREP    = "prep"
local PHASE_ACTIVE  = "active"
local PHASE_ENDED   = "ended"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

local g_Phase         = PHASE_WAITING
local g_PhaseEnd      = 0.0
local g_MatchId       = ""
local g_BootSent      = false
local g_NextHeartbeat = 0.0
local g_RoundCount    = 0
local g_WinTeam       = ""   // "innocents" | "traitors"

// Role tracking (uid → role string)
local g_Roles         = {}   // uid → "innocent" | "traitor" | "detective"
local g_DetectiveUid  = -1
local g_TraitorCount  = 0
local g_InnocentCount = 0

// ---------------------------------------------------------------------------
// Role helpers
// ---------------------------------------------------------------------------

function TT_GetRole(player) {
    if (player == null || !player.IsValid()) return "none"
    local uid = player.GetUserID()
    if (uid in g_Roles) return g_Roles[uid]
    return "none"
}

function TT_IsTraitor(player) {
    return TT_GetRole(player) == "traitor"
}

function TT_IsInnocent(player) {
    local role = TT_GetRole(player)
    return role == "innocent" || role == "detective"
}

function TT_CountAliveTraitors() {
    local count = 0
    local all = OV_GetAlivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (TT_IsTraitor(all[i])) count++
    }
    return count
}

function TT_CountAliveInnocents() {
    local count = 0
    local all = OV_GetAlivePlayers()
    for (local i = 0; i < all.len(); i++) {
        if (TT_IsInnocent(all[i])) count++
    }
    return count
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function TT_AssignRoles() {
    local all = OV_GetActivePlayers()
    OV_Shuffle(all)

    local n = all.len()
    local numTraitors = (n * 0.15).tointeger()
    if (numTraitors < 1) numTraitors = 1
    if (numTraitors > 3) numTraitors = 3

    local hasDetective = (n >= 5)

    g_Roles        = {}
    g_DetectiveUid = -1
    g_TraitorCount = 0
    g_InnocentCount = 0

    local idx = 0

    // Assign traitors first
    for (local i = 0; i < numTraitors; i++) {
        local p   = all[idx++]
        local uid = p.GetUserID()
        g_Roles[uid] <- "traitor"
        g_TraitorCount++
        // Traitors stay on team B so the server knows their team,
        // but the client chat never reveals this to others.
        NetProps.SetPropInt(p, "m_iTeamNum", OV_TEAM_B)
        printl("[OV] TTT traitor uid=" + uid + " name=" + p.GetPlayerName())
    }

    // Assign detective
    if (hasDetective) {
        local p   = all[idx++]
        local uid = p.GetUserID()
        g_Roles[uid] <- "detective"
        g_DetectiveUid = uid
        NetProps.SetPropInt(p, "m_iTeamNum", OV_TEAM_A)
        printl("[OV] TTT detective uid=" + uid + " name=" + p.GetPlayerName())
    }

    // Assign innocents
    while (idx < all.len()) {
        local p   = all[idx++]
        local uid = p.GetUserID()
        g_Roles[uid] <- "innocent"
        g_InnocentCount++
        NetProps.SetPropInt(p, "m_iTeamNum", OV_TEAM_A)
    }
    if (hasDetective) g_InnocentCount++ // detective counted as innocent-side

    printl("[OV] TTT roles: traitors=" + g_TraitorCount +
           " innocents=" + g_InnocentCount +
           " detective=" + (hasDetective ? g_DetectiveUid.tostring() : "none"))
}

function TT_StartRound() {
    g_Phase    = PHASE_PREP
    g_PhaseEnd = Time() + PREP_TIME
    g_MatchId  = OV_GenMatchId(MODE)
    g_RoundCount++
    g_WinTeam  = ""

    TT_AssignRoles()

    OV_ChatAll("[Traitor Town] Round " + g_RoundCount + " — roles assigned! " +
               g_TraitorCount + " traitor(s) among us…")
    if (g_DetectiveUid >= 0) {
        OV_ChatAll("[Traitor Town] There is a DETECTIVE. Work together, innocents!")
    }
    printl("[OV] TTT PREP round=" + g_RoundCount)
}

function TT_GoActive() {
    g_Phase    = PHASE_ACTIVE
    g_PhaseEnd = Time() + ROUND_TIME
    OV_ChatAll("[Traitor Town] ROUND ACTIVE! " + ROUND_TIME.tointeger() + "s remaining.")
    printl("[OV] TTT phase=ACTIVE roundTime=" + ROUND_TIME)
}

function TT_EndRound(winTeam) {
    if (g_Phase == PHASE_ENDED) return
    g_Phase    = PHASE_ENDED
    g_PhaseEnd = Time() + END_DELAY
    g_WinTeam  = winTeam

    if (winTeam == "traitors") {
        OV_ChatAll("[Traitor Town] TRAITORS WIN! All innocents eliminated.")
    } else {
        OV_ChatAll("[Traitor Town] INNOCENTS WIN! Traitors exposed and eliminated.")
    }

    // Reveal all traitors at round end
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p = all[i]
        if (TT_IsTraitor(p)) {
            OV_ChatAll("[Traitor Town] TRAITOR: " + p.GetPlayerName())
        }
    }

    TT_EmitRewards(winTeam)
    printl("[OV] TTT phase=ENDED winner=" + winTeam)
}

function TT_EmitRewards(winTeam) {
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p   = all[i]
        local uid = p.GetUserID()
        local role = TT_GetRole(p)

        local cur = 0
        local xp  = REWARD_XP_BASE

        if (role == "traitor") {
            cur = (winTeam == "traitors") ? REWARD_WIN : REWARD_LOSS
        } else if (role == "detective") {
            cur = (winTeam == "innocents") ? REWARD_WIN + REWARD_DETECTIVE : REWARD_LOSS
            xp  = REWARD_XP_BASE + 20
        } else {
            cur = (winTeam == "innocents") ? REWARD_WIN : REWARD_LOSS
        }

        OV_Emit("REWARD", g_MatchId + " " + SERVER_ID + " " + SERVER_SECRET +
                          " " + uid.tostring() + " " + MODE + " " + cur + " " + xp)
    }
}

function TT_Reset() {
    g_Phase        = PHASE_WAITING
    g_MatchId      = ""
    g_WinTeam      = ""
    g_Roles        = {}
    g_DetectiveUid = -1
    g_TraitorCount = 0
    g_InnocentCount = 0
    printl("[OV] TTT reset to WAITING")
}

// ---------------------------------------------------------------------------
// Win condition check
// ---------------------------------------------------------------------------

function TT_CheckWin() {
    if (g_Phase != PHASE_ACTIVE) return

    local aliveT = TT_CountAliveTraitors()
    local aliveI = TT_CountAliveInnocents()

    // All traitors dead → innocents win
    if (aliveT == 0 && g_TraitorCount > 0) {
        TT_EndRound("innocents")
        return
    }

    // All innocents dead → traitors win
    if (aliveI == 0 && g_InnocentCount > 0) {
        TT_EndRound("traitors")
        return
    }

    // Time expired → innocents win by default
    if (Time() >= g_PhaseEnd) {
        OV_ChatAll("[Traitor Town] Time expired! " + aliveT + " traitor(s) survived.")
        TT_EndRound("innocents")
        return
    }
}

// ---------------------------------------------------------------------------
// Main think
// ---------------------------------------------------------------------------

function TTThink() {
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
        if (OV_GetActivePlayers().len() >= MIN_PLAYERS) TT_StartRound()
        return 5.0

    } else if (g_Phase == PHASE_PREP) {
        if (now >= g_PhaseEnd) TT_GoActive()
        return 1.0

    } else if (g_Phase == PHASE_ACTIVE) {
        TT_CheckWin()
        return 1.0

    } else if (g_Phase == PHASE_ENDED) {
        if (now >= g_PhaseEnd) TT_Reset()
        return 2.0
    }

    return 2.0
}

// ---------------------------------------------------------------------------
// Game events
// ---------------------------------------------------------------------------

function OnGameEvent_player_death(params) {
    if (g_Phase != PHASE_ACTIVE) return

    local uid = params.userid
    local att = params.attacker

    local dead = GetPlayerFromUserID(uid)
    local atk  = GetPlayerFromUserID(att)

    if (dead == null) return

    local deadRole = TT_GetRole(dead)
    printl("[OV] TTT death uid=" + uid + " role=" + deadRole + " attacker=" + att)

    // If a detective is killed, log it
    if (deadRole == "detective") {
        OV_ChatAll("[Traitor Town] The DETECTIVE has been killed!")
    }
}

function OnGameEvent_player_disconnect(params) {
    if (g_Phase == PHASE_ACTIVE || g_Phase == PHASE_PREP) {
        if (OV_GetActivePlayers().len() < MIN_PLAYERS) {
            OV_ChatAll("[Traitor Town] Not enough players — round cancelled.")
            TT_Reset()
        }
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function TTInit() {
    printl("[OV] ov_traitortown.nut initialising")
    g_NextHeartbeat = Time() + 3.0
    OV_CreateThinkEnt("TTThink")
    printl("[OV] ov_traitortown.nut ready — server id: " + SERVER_ID)
}

TTInit()
