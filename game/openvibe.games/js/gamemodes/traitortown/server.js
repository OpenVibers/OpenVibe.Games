(function () {
  // Traitor Town round state
  // Roles: INNOCENT (team 2) vs TRAITOR (team 3)
  // ~1 traitor per 4 players, minimum 1.
  // Win conditions:
  //   - All traitors dead → innocents win
  //   - All innocents dead → traitors win
  //   - Timer runs out with traitors alive → traitors win

  const ROUND_DURATION = 300; // 5 minutes

  const TEAM_INNOCENT = 2;
  const TEAM_TRAITOR  = 3;

  let innocentsAlive = 0;
  let traitorsAlive  = 0;
  let rolesAssigned  = false;

  // Devolved-style karma: everyone starts at 1000, teamkills cost 100,
  // surviving a round earns 5 back. Low karma is a social signal only (no
  // damage scaling yet — that needs the damage-info bridge).
  const KARMA_START = 1000, KARMA_TEAMKILL = 100, KARMA_ROUND_BONUS = 5;
  const karmaByUser = Object.create(null); // userId -> karma
  const detectiveByUser = Object.create(null); // userId -> true

  function karmaFor(ply) {
    const uid = typeof ply.userId === "function" ? ply.userId() : (typeof ply.UserID === "function" ? ply.UserID() : -1);
    if (karmaByUser[uid] == null) karmaByUser[uid] = KARMA_START;
    return { uid, karma: karmaByUser[uid] };
  }

  function pushRole(p) {
    if (!(globalThis.net && net.__openvibe)) return;
    const k = karmaFor(p);
    try {
      net.Start("OV_TTT_Role");
      net.WriteInt(p.team());
      net.WriteInt(detectiveByUser[k.uid] ? 1 : 0);
      net.WriteInt(k.karma);
      net.Send(p);
    } catch (e) { /* transport not up */ }
  }

  function pushKarma(p) {
    if (!(globalThis.net && net.__openvibe)) return;
    const k = karmaFor(p);
    try {
      net.Start("OV_TTT_Karma");
      net.WriteInt(k.karma);
      net.Send(p);
    } catch (e) { /* transport not up */ }
  }

  function assignRoles() {
    const players = OV.players();
    if (players.length < 2) return;

    rolesAssigned = false;
    for (const uid in detectiveByUser) delete detectiveByUser[uid];
    const shuffled = players.slice().sort(() => Math.random() - 0.5);
    const traitorCount = Math.max(1, Math.floor(shuffled.length / 4));

    shuffled.forEach(function (p, i) {
      p.setTeam(i < traitorCount ? TEAM_TRAITOR : TEAM_INNOCENT);
    });

    // One detective per 8 players once the lobby is big enough (>=5),
    // picked from the innocents — TTT semantics: a public innocent.
    const innocents = shuffled.filter((p) => p.team() === TEAM_INNOCENT);
    const detectiveCount = players.length >= 5 ? Math.max(1, Math.floor(players.length / 8)) : 0;
    innocents.slice(0, detectiveCount).forEach(function (p) {
      detectiveByUser[karmaFor(p).uid] = true;
    });

    innocentsAlive = shuffled.filter((p) => p.team() === TEAM_INNOCENT).length;
    traitorsAlive  = shuffled.filter((p) => p.team() === TEAM_TRAITOR).length;
    rolesAssigned  = true;

    // Tell everyone their role privately: chat for traitors + a net message
    // per player so the client HUD can render it.
    shuffled.forEach(function (p) {
      if (p.team() === TEAM_TRAITOR) p.chat("[TRAITOR] You are a traitor. Eliminate all innocents.");
      if (detectiveByUser[karmaFor(p).uid]) p.chat("[DETECTIVE] You are the detective. Find the traitors.");
      pushRole(p);
    });

    OV.broadcast(`Round ${gamemode.get()._roundNumber} — ${players.length} players. Find the traitor(s)!`);
  }

  function registerCommands() {
    if (!globalThis.command) return;

    command.add("ttt_status", "Show Traitor Town status", function ({ ply, reply }) {
      const gm = gamemode.get();
      reply(ply, `Traitor Town | round=${gm._roundNumber} state=${gm._roundState} innocents=${innocentsAlive} traitors=${traitorsAlive}`);
      return false;
    });

    command.add("role", "Show your current role", function ({ ply, reply }) {
      if (!ply || !rolesAssigned) {
        reply(ply, "Roles have not been assigned yet.");
        return false;
      }
      const role = ply.team() === TEAM_TRAITOR ? "TRAITOR" : "INNOCENT";
      reply(ply, `Your role: ${role}`);
      return false;
    });
  }

  const GM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town",
    roundDuration: ROUND_DURATION,
    countdownDuration: 15,

    Initialize() {
      OV.log("Traitor Town Initialize fired");
      registerCommands();
      if (globalThis.util && util.AddNetworkString) {
        util.AddNetworkString("OV_TTT_Role");
        util.AddNetworkString("OV_TTT_Karma");
      }
    },

    // Extend the base HUD-state broadcast with TTT-specific live values.
    buildHudState() {
      const s = gamemode.getBase().buildHudState.call(this);
      s.aliveInnocents = innocentsAlive;
      s.aliveTraitors = traitorsAlive;
      s.alive = innocentsAlive + traitorsAlive;
      s.rolesAssigned = rolesAssigned;
      return s;
    },

    CreateTeams() {
      if (!globalThis.team) return;
      team.SetUp(0, "Unassigned", Color(200, 200, 200));
      team.SetUp(TEAM_INNOCENT, "Innocents", Color(60, 180, 90));
      team.SetUp(TEAM_TRAITOR, "Traitors", Color(200, 40, 40));
    },

    MapInitialize(mapName) {
      OV.log(`Traitor Town MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Traitor Town JS loaded. Try !ttt_status or !role");
    },

    startRound() {
      this._roundNumber += 1;
      this._roundState = "active";
      this._roundEndsAt = OV.time() + ROUND_DURATION;
      rolesAssigned = false;
      innocentsAlive = 0;
      traitorsAlive = 0;

      assignRoles();

      OV.log(`[TTT] RoundStart round=${this._roundNumber} traitors=${traitorsAlive} innocents=${innocentsAlive}`);
      hook.Run("RoundStart", this._roundNumber);

      const self = this;
      const roundNum = this._roundNumber;
      timer.create(`ov_ttt_round_end_${roundNum}`, ROUND_DURATION, 1, function () {
        if (self._roundState === "active" && self._roundNumber === roundNum) {
          // Traitors win if still alive at time
          self.endRound(traitorsAlive > 0 ? "traitors_win" : "innocents_win");
        }
      });
    },

    endRound(reason) {
      if (this._roundState !== "active") return;
      this._roundState = "ended";
      this._roundEndsAt = 0;
      rolesAssigned = false;
      timer.remove(`ov_ttt_round_end_${this._roundNumber}`);

      const msg = reason === "traitors_win"  ? "Traitors win! The innocents never suspected a thing." :
                  reason === "innocents_win" ? "Innocents win! All traitors have been identified." :
                  `Round ${this._roundNumber} ended.`;

      OV.log(`[TTT] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason);
      OV.broadcast(msg);

      // Karma: everyone still standing earns a little back.
      OV.players().forEach(function (p) {
        const k = karmaFor(p);
        karmaByUser[k.uid] = Math.min(KARMA_START, k.karma + KARMA_ROUND_BONUS);
        pushKarma(p);
      });

      this.scheduleRoundStart();
    },

    PlayerDeath(victim, attacker) {
      if (!victim || this._roundState !== "active" || !rolesAssigned) return;

      // Teamkill karma penalty (self/world kills excluded).
      if (attacker && attacker !== victim &&
          typeof attacker.team === "function" && attacker.team() === victim.team()) {
        const k = karmaFor(attacker);
        karmaByUser[k.uid] = Math.max(0, k.karma - KARMA_TEAMKILL);
        if (typeof attacker.chat === "function") attacker.chat(`Teamkill! Karma is now ${karmaByUser[k.uid]}.`);
        pushKarma(attacker);
      }

      if (victim.team() === TEAM_INNOCENT) {
        innocentsAlive = Math.max(0, innocentsAlive - 1);
        OV.broadcast(`An innocent has died. ${innocentsAlive} innocent(s) remaining.`);
        if (innocentsAlive === 0) this.endRound("traitors_win");
      } else if (victim.team() === TEAM_TRAITOR) {
        traitorsAlive = Math.max(0, traitorsAlive - 1);
        OV.broadcast(`A traitor has been found! ${traitorsAlive} traitor(s) remaining.`);
        if (traitorsAlive === 0) this.endRound("innocents_win");
      }
    },

    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibeTraitorTownSpawnTip", function (ply) {
    if (rolesAssigned) {
      const role = ply.team() === TEAM_TRAITOR ? "TRAITOR" : "innocent";
      ply.chat(`Your role: ${role.toUpperCase()}. Type !role to check.`);
    } else {
      ply.chat("Watch the room. Someone here is lying. Type !role once the round starts.");
    }
  });

  gamemode.set(GM);
})();
