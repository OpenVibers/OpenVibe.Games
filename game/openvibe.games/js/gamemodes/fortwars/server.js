(function () {
  // Fort Wars round state
  // Phase 1 — BUILD (team 2 vs team 3 each build separately)
  // Phase 2 — FIGHT (teams attack each other's fort)
  // Win condition: last team with living players wins.

  const BUILD_DURATION = 60;  // 60 s build phase
  const FIGHT_DURATION = 180; // 3 min fight phase

  const TEAM_RED  = 2;
  const TEAM_BLUE = 3;

  let phase        = "build"; // "build" | "fight"
  let redAlive     = 0;
  let blueAlive    = 0;

  function assignTeams() {
    const players = OV.players();
    if (players.length === 0) return;
    const shuffled = players.slice().sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);
    shuffled.forEach(function (p, i) {
      p.setTeam(i < half ? TEAM_RED : TEAM_BLUE);
    });
    redAlive  = shuffled.filter((p) => p.team() === TEAM_RED).length;
    blueAlive = shuffled.filter((p) => p.team() === TEAM_BLUE).length;
    OV.broadcast(`Fort Wars: Red (${redAlive}) vs Blue (${blueAlive})`);
  }

  function registerCommands() {
    if (!globalThis.command) return;

    command.add("fw_status", "Show Fort Wars status", function ({ ply, reply }) {
      const gm = gamemode.get();
      reply(ply, `Fort Wars | round=${gm._roundNumber} phase=${phase} red=${redAlive} blue=${blueAlive}`);
      return false;
    });

    command.add("build", "Spawn a Fort Wars prop", function ({ args, ply, reply }) {
      if (phase !== "build") {
        reply(ply, "Build phase has ended!");
        return false;
      }
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_fortwars_spawn ${choice}`);
      reply(ply, `Placed: ${choice}`);
      return false;
    });
  }

  const GM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars",
    roundDuration: BUILD_DURATION + FIGHT_DURATION,
    countdownDuration: 10,

    Initialize() {
      OV.log("Fort Wars Initialize fired");
      registerCommands();
    },

    MapInitialize(mapName) {
      OV.log(`Fort Wars MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Fort Wars JS loaded. Try !fw_status or !build crate");
    },

    startRound() {
      this._roundNumber += 1;
      this._roundState = "active";
      phase = "build";

      assignTeams();

      OV.log(`[FW] RoundStart round=${this._roundNumber}`);
      hook.Run("RoundStart", this._roundNumber);
      OV.broadcast(`Round ${this._roundNumber} — BUILD PHASE! You have ${BUILD_DURATION}s to fortify!`);
      OV.serverCommand("ov_fortwars_build_enabled 1");

      const self = this;
      const roundNum = this._roundNumber;

      // Transition to fight phase
      timer.simple(BUILD_DURATION, function () {
        if (self._roundState !== "active" || self._roundNumber !== roundNum) return;
        phase = "fight";
        OV.broadcast("BUILD PHASE OVER! FIGHT!");
        OV.serverCommand("ov_fortwars_build_enabled 0");
        hook.Run("FW_FightPhaseStart", roundNum);
      });

      // End of round timer
      timer.create(`ov_fw_round_end_${roundNum}`, BUILD_DURATION + FIGHT_DURATION, 1, function () {
        if (self._roundState === "active" && self._roundNumber === roundNum) {
          if (redAlive > 0 && blueAlive === 0) {
            self.endRound("red_win");
          } else if (blueAlive > 0 && redAlive === 0) {
            self.endRound("blue_win");
          } else {
            self.endRound("draw");
          }
        }
      });
    },

    endRound(reason) {
      if (this._roundState !== "active") return;
      this._roundState = "ended";
      timer.remove(`ov_fw_round_end_${this._roundNumber}`);
      phase = "build";
      OV.serverCommand("ov_fortwars_build_enabled 1");

      const msg = reason === "red_win"  ? "Red team wins!" :
                  reason === "blue_win" ? "Blue team wins!" :
                  "Draw! Both teams survived.";

      OV.log(`[FW] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason);
      OV.broadcast(msg);

      this.scheduleRoundStart();
    },

    PlayerDeath(victim, _attacker) {
      if (!victim || this._roundState !== "active" || phase !== "fight") return;
      if (victim.team() === TEAM_RED)  redAlive  = Math.max(0, redAlive - 1);
      if (victim.team() === TEAM_BLUE) blueAlive = Math.max(0, blueAlive - 1);

      if (redAlive === 0 && blueAlive > 0) {
        this.endRound("blue_win");
      } else if (blueAlive === 0 && redAlive > 0) {
        this.endRound("red_win");
      } else if (redAlive === 0 && blueAlive === 0) {
        this.endRound("draw");
      }
    },

    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibeFortWarsSpawnTip", function (ply) {
    if (phase === "build") {
      ply.chat(`Build phase: use !build crate, !build pallet, or !build fence. (${BUILD_DURATION}s)`);
    } else {
      ply.chat("Fight phase — destroy the enemy fort!");
    }
  });

  gamemode.set(GM);
})();
