// ov_shared.nut
// OpenVibe: Source — shared VScript utilities for all game modes.
// Include via:  DoIncludeScript("ov_shared", this)
//
// Sidecar protocol
// ----------------
// Lines printed to the SRCDS console that begin with "[OV] " are parsed
// by tools/ov-sidecar.mjs.  Format:
//   [OV] BOOT    serverId mode
//   [OV] HEARTBEAT serverId playerCount maxPlayers state
//   [OV] REWARD  matchId serverId serverSecret steamId mode currency xp
//   [OV] SAY     text          (broadcast chat)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

OV_TEAM_UNASSIGNED  <- 0
OV_TEAM_SPECTATOR   <- 1
OV_TEAM_A           <- 2   // Rebels / Runners / Props / Innocents
OV_TEAM_B           <- 3   // Combine / Activators / Hunters / Traitors/Detectives

OV_LIFE_ALIVE       <- 0
OV_LIFE_DYING       <- 1
OV_LIFE_DEAD        <- 2

// HUD channels (used by game_text entities named "ov_hud_N")
OV_HUD_ROUND        <- 1
OV_HUD_TIMER        <- 2
OV_HUD_SCORE        <- 3
OV_HUD_ROLE         <- 4

// ---------------------------------------------------------------------------
// Sidecar event emission
// ---------------------------------------------------------------------------

function OV_Emit(eventType, data) {
    printl("[OV] " + eventType + " " + data)
}

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------

// Returns array of all valid player handles (any team)
function OV_GetAllPlayers() {
    local out = []
    local max = MaxClients()
    for (local i = 1; i <= max; i++) {
        local p = PlayerInstanceFromIndex(i)
        if (p != null && p.IsValid()) {
            out.append(p)
        }
    }
    return out
}

// Returns players on team 2 or 3 (in-game, not spectators)
function OV_GetActivePlayers() {
    local out = []
    local max = MaxClients()
    for (local i = 1; i <= max; i++) {
        local p = PlayerInstanceFromIndex(i)
        if (p != null && p.IsValid()) {
            local team = NetProps.GetPropInt(p, "m_iTeamNum")
            if (team == OV_TEAM_A || team == OV_TEAM_B) {
                out.append(p)
            }
        }
    }
    return out
}

// Returns active players who are alive (m_lifeState == 0)
function OV_GetAlivePlayers() {
    local out = []
    local all = OV_GetActivePlayers()
    for (local i = 0; i < all.len(); i++) {
        local p = all[i]
        if (NetProps.GetPropInt(p, "m_lifeState") == OV_LIFE_ALIVE) {
            out.append(p)
        }
    }
    return out
}

// Count alive players on a specific team
function OV_CountAliveOnTeam(teamNum) {
    local count = 0
    local max = MaxClients()
    for (local i = 1; i <= max; i++) {
        local p = PlayerInstanceFromIndex(i)
        if (p != null && p.IsValid()) {
            local team = NetProps.GetPropInt(p, "m_iTeamNum")
            local life = NetProps.GetPropInt(p, "m_lifeState")
            if (team == teamNum && life == OV_LIFE_ALIVE) count++
        }
    }
    return count
}

// Count all (alive or dead) players on a specific team
function OV_CountOnTeam(teamNum) {
    local count = 0
    local max = MaxClients()
    for (local i = 1; i <= max; i++) {
        local p = PlayerInstanceFromIndex(i)
        if (p != null && p.IsValid()) {
            if (NetProps.GetPropInt(p, "m_iTeamNum") == teamNum) count++
        }
    }
    return count
}

// Assign a player to a team and respawn them
function OV_SetTeam(player, teamNum) {
    if (!player.IsValid()) return
    NetProps.SetPropInt(player, "m_iTeamNum", teamNum)
}

// Teleport player to a named info_target or info_player_deathmatch
function OV_TeleportToSpawn(player, spawnName) {
    local spawn = Entities.FindByName(null, spawnName)
    if (spawn == null) {
        // Fall back to any info_player_deathmatch
        spawn = Entities.FindByClassname(null, "info_player_deathmatch")
    }
    if (spawn == null) return
    player.SetOrigin(spawn.GetOrigin())
    player.SetAngles(spawn.GetAngles())
}

// Kill a player (remove from play, they'll respawn based on server settings)
function OV_KillPlayer(player) {
    if (!player.IsValid()) return
    if (NetProps.GetPropInt(player, "m_lifeState") == OV_LIFE_ALIVE) {
        NetProps.SetPropInt(player, "m_iHealth", 0)
        EntFireByHandle(player, "SetHealth", "0", 0, null, null)
    }
}

// Heal a player to full
function OV_HealFull(player) {
    if (!player.IsValid()) return
    local maxHp = NetProps.GetPropInt(player, "m_iMaxHealth")
    if (maxHp <= 0) maxHp = 100
    NetProps.SetPropInt(player, "m_iHealth", maxHp)
}

// ---------------------------------------------------------------------------
// Array shuffle (Fisher-Yates)
// ---------------------------------------------------------------------------

function OV_Shuffle(arr) {
    local n = arr.len()
    for (local i = n - 1; i > 0; i--) {
        local j = RandomInt(0, i)
        local tmp = arr[i]
        arr[i] = arr[j]
        arr[j] = tmp
    }
    return arr
}

// ---------------------------------------------------------------------------
// HUD messaging via game_text entities
// ---------------------------------------------------------------------------
// Maps must contain game_text entities named "ov_hud_1" through "ov_hud_4".
// The VScript fires their "Display" input to show text.
// Since we cannot change game_text message text at runtime without C++,
// we use printl for server-console logging and fire Display on named entities.

function OV_FireHud(channel) {
    local name = "ov_hud_" + channel.tostring()
    local gt = Entities.FindByName(null, name)
    if (gt != null) {
        EntFireByHandle(gt, "Display", "", 0, null, null)
    }
}

// Broadcast text to all via server say (shown in chat)
function OV_ChatAll(msg) {
    printl("[OV_SAY] " + msg)
    // EntFire to a game_text or point_broadcast for proper in-game message
    OV_FireHud(OV_HUD_ROUND)
}

// ---------------------------------------------------------------------------
// Match ID generation
// ---------------------------------------------------------------------------

function OV_GenMatchId(mode) {
    return mode + "_" + Time().tointeger().tostring()
}

// ---------------------------------------------------------------------------
// Think entity setup helper
// ---------------------------------------------------------------------------
// Creates a persistent info_target entity and attaches a think function to it.
// thinkFuncName must be a GLOBAL function that returns the desired think interval.

function OV_CreateThinkEnt(thinkFuncName) {
    local ent = Entities.CreateByClassname("info_target")
    if (ent == null || !ent.IsValid()) {
        printl("[OV] ERROR: could not create think entity for " + thinkFuncName)
        return null
    }
    ent.__KeyValueFromString("targetname", "ov_think_" + thinkFuncName)
    AddThinkToEnt(ent, thinkFuncName)
    printl("[OV] think entity created for " + thinkFuncName)
    return ent
}

// ---------------------------------------------------------------------------
// Numeric formatting helpers
// ---------------------------------------------------------------------------

function OV_SecondsToMMSS(secs) {
    local s = secs.tointeger()
    if (s < 0) s = 0
    local m = (s / 60).tointeger()
    local sec = s - m * 60
    local ss = sec.tostring()
    if (sec < 10) ss = "0" + ss
    return m.tostring() + ":" + ss
}

printl("[OV] ov_shared.nut loaded")
