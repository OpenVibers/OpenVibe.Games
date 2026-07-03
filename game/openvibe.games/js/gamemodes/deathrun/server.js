(function () {
  // Deathrun round state
  // Teams: RUNNERS (team 2) vs ACTIVATORS (team 3)
  // One activator controls traps; all others are runners.
  // Win conditions:
  //   - All runners die → activator wins
  //   - Any runner reaches the finish (fires "DR_RunnerFinished") → runners win
  //   - Timer runs out with ≥1 runner alive → runners win

  const ROUND_DURATION = 240; // 4 minutes per round

  const TEAM_RUNNERS    = 2;
  const TEAM_ACTIVATORS = 3;

  let runnersAlive = 0;
  let activatorId  = null; // userId of the activator this round

  function assignTeams() {
    const players = OV.players();
    if (players.length === 0) return;

    const shuffled = players.slice().sort(() => Math.random() - 0.5);
    // Pick one activator (rotate by round number)
    const activatorIdx = (gamemode.get()._roundNumber - 1) % shuffled.length;
    shuffled.forEach(function (p, i) {
      if (i === activatorIdx) {
        p.setTeam(TEAM_ACTIVATORS);
        activatorId = p.userId();
      } else {
        p.setTeam(TEAM_RUNNERS);
      }
      if (globalThis.net && net.__openvibe) {
        try {
          net.Start("OV_DR_Role");
          net.WriteInt(p.team());
          net.Send(p);
        } catch (e) { /* transport not up */ }
      }
    });

    runnersAlive = players.filter((p) => p.team() === TEAM_RUNNERS).length;
    const activator = players.find((p) => p.userId() === activatorId);
    OV.broadcast(`Deathrun: ${runnersAlive} runner(s) vs activator ${activator ? activator.name() : "?"}.`);
  }

  function registerCommands() {
    if (!globalThis.command) return;
    command.add("dr_status", "Show Deathrun status", function ({ ply, reply }) {
      const gm = gamemode.get();
      reply(ply, `Deathrun | round=${gm._roundNumber} state=${gm._roundState} runners=${runnersAlive}`);
      return false;
    });
  }

  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun",
    roundDuration: ROUND_DURATION,
    countdownDuration: 10,

    Initialize() {
      OV.log("Deathrun Initialize fired");
      registerCommands();
      if (globalThis.util && util.AddNetworkString) util.AddNetworkString("OV_DR_Role");
    },

    CreateTeams() {
      if (!globalThis.team) return;
      team.SetUp(0, "Unassigned", Color(200, 200, 200));
      team.SetUp(TEAM_RUNNERS, "Runners", Color(80, 160, 240));
      team.SetUp(TEAM_ACTIVATORS, "Activator", Color(240, 80, 80));
    },

    MapInitialize(mapName) {
      OV.log(`Deathrun MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Deathrun JS loaded. Try !dr_status");
    },

    startRound() {
      this._roundNumber += 1;
      this._roundState = "active";
      this._roundEndsAt = OV.time() + ROUND_DURATION;
      activatorId = null;

      assignTeams();

      OV.log(`[DR] RoundStart round=${this._roundNumber}`);
      hook.Run("RoundStart", this._roundNumber);
      OV.broadcast(`Round ${this._roundNumber} — reach the end. Avoid traps. Trust nothing.`);

      const self = this;
      const roundNum = this._roundNumber;
      timer.create(`ov_dr_round_end_${roundNum}`, ROUND_DURATION, 1, function () {
        if (self._roundState === "active" && self._roundNumber === roundNum) {
          if (runnersAlive > 0) {
            self.endRound("runners_win");
          } else {
            self.endRound("activator_win");
          }
        }
      });
    },

    endRound(reason) {
      if (this._roundState !== "active") return;
      this._roundState = "ended";
      this._roundEndsAt = 0;
      timer.remove(`ov_dr_round_end_${this._roundNumber}`);

      let msg;
      if (reason === "runners_win") {
        msg = "Runners survived! Runners win!";
      } else if (reason === "activator_win") {
        msg = "All runners eliminated! Activator wins!";
      } else {
        msg = `Round ${this._roundNumber} ended.`;
      }

      OV.log(`[DR] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason);
      OV.broadcast(msg);

      this.scheduleRoundStart();
    },

    PlayerDeath(victim, _attacker) {
      if (!victim || this._roundState !== "active") return;
      if (victim.team() === TEAM_RUNNERS) {
        runnersAlive = Math.max(0, runnersAlive - 1);
        if (runnersAlive === 0) {
          this.endRound("activator_win");
        } else {
          OV.broadcast(`Runner down! ${runnersAlive} runner(s) remaining.`);
        }
      }
    },

    Think() {}
  };

  // Any runner reaching the finish fires DR_RunnerFinished
  hook.Add("DR_RunnerFinished", "OpenVibeDeathrunFinish", function (ply) {
    const gm = gamemode.get();
    if (gm && gm._roundState === "active") {
      OV.broadcast(`${ply ? ply.name() : "A runner"} reached the end!`);
      gm.endRound("runners_win");
    }
  });

  hook.Add("PlayerSpawn", "OpenVibeDeathrunSpawnTip", function (ply) {
    if (ply.team() === TEAM_RUNNERS) {
      ply.chat("Reach the end. Avoid traps. Trust nothing.");
    } else {
      ply.chat("Activate the traps! Stop the runners!");
    }
  });

  gamemode.set(GM);
})();
