(function () {
  // Prop Hunt round state
  // Teams: PROPS (team 2) vs HUNTERS (team 3)
  // Phase 1: props scatter for HUNTER_LOCK_DURATION while hunters are locked.
  // Phase 2: hunters are released, full round timer runs.
  // Win conditions:
  //   - All props eliminated → hunters win
  //   - Timer runs out with ≥1 prop alive → props win

  const HUNTER_LOCK_DURATION = 20;  // seconds hunters wait at round start
  const ROUND_DURATION      = 180; // total round time in seconds

  const TEAM_PROPS    = 2;
  const TEAM_HUNTERS  = 3;

  let propsAlive   = 0;
  let huntersAlive = 0;
  let locked       = false;

  function countAlive() {
    const players = OV.players();
    propsAlive   = players.filter((p) => p.team() === TEAM_PROPS).length;
    huntersAlive = players.filter((p) => p.team() === TEAM_HUNTERS).length;
  }

  function assignTeams() {
    const players = OV.players();
    if (players.length === 0) return;

    // 1 hunter per 3 props, minimum 1 hunter
    const hunterCount = Math.max(1, Math.floor(players.length / 4));
    const shuffled = players.slice().sort(() => Math.random() - 0.5);

    shuffled.forEach(function (p, i) {
      const t = i < hunterCount ? TEAM_HUNTERS : TEAM_PROPS;
      p.setTeam(t);
      // Private role notification over the net library (client HUD shows it).
      if (globalThis.net && net.__openvibe) {
        try {
          net.Start("OV_PH_Role");
          net.WriteInt(t);
          net.WriteInt(HUNTER_LOCK_DURATION);
          net.Send(p);
        } catch (e) { /* transport not up */ }
      }
    });

    countAlive();
    OV.broadcast(`Teams set: ${propsAlive} props vs ${huntersAlive} hunters.`);
  }

  function registerCommands() {
    if (!globalThis.command) return;

    command.add("ph_status", "Show Prop Hunt status", function ({ ply, reply }) {
      const gm = gamemode.get();
      reply(ply, `Prop Hunt | round=${gm._roundNumber} state=${gm._roundState} props=${propsAlive} hunters=${huntersAlive} locked=${locked}`);
      return false;
    });

    command.add("disguise", "Disguise as an allowlisted prop", function ({ args, ply, reply }) {
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_prophunt_disguise ${choice}`);
      reply(ply, `Trying prop disguise: ${choice}`);
      return false;
    });
  }

  const GM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt",
    roundDuration: ROUND_DURATION,
    countdownDuration: 10,

    Initialize() {
      OV.log("Prop Hunt Initialize fired");
      registerCommands();
      if (globalThis.util && util.AddNetworkString) util.AddNetworkString("OV_PH_Role");
    },

    CreateTeams() {
      if (!globalThis.team) return;
      team.SetUp(0, "Unassigned", Color(200, 200, 200));
      team.SetUp(TEAM_PROPS, "Props", Color(80, 200, 120));
      team.SetUp(TEAM_HUNTERS, "Hunters", Color(220, 90, 60));
    },

    MapInitialize(mapName) {
      OV.log(`Prop Hunt MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Prop Hunt JS loaded. Try !ph_status or !disguise crate");
    },

    startRound() {
      this._roundNumber += 1;
      this._roundState = "active";
      this._roundEndsAt = OV.time() + ROUND_DURATION;
      locked = true;

      assignTeams();

      OV.log(`[PH] RoundStart round=${this._roundNumber}`);
      hook.Run("RoundStart", this._roundNumber);
      OV.broadcast(`Round ${this._roundNumber} — props, hide now! Hunters release in ${HUNTER_LOCK_DURATION}s.`);

      // Lock hunters, release after delay
      const self = this;
      const roundNum = this._roundNumber;
      timer.simple(HUNTER_LOCK_DURATION, function () {
        if (self._roundState !== "active" || self._roundNumber !== roundNum) return;
        locked = false;
        OV.broadcast("Hunters released! Find the props!");
      });

      // Full round timer
      timer.create(`ov_ph_round_end_${roundNum}`, ROUND_DURATION, 1, function () {
        if (self._roundState === "active" && self._roundNumber === roundNum) {
          if (propsAlive > 0) {
            self.endRound("props_win");
          } else {
            self.endRound("hunters_win");
          }
        }
      });

      this.broadcastHudState();
    },

    endRound(reason) {
      if (this._roundState !== "active") return;
      this._roundState = "ended";
      this._roundEndsAt = 0;
      locked = false;
      timer.remove(`ov_ph_round_end_${this._roundNumber}`);

      let msg;
      if (reason === "props_win") {
        msg = "Props survived! Props win!";
      } else if (reason === "hunters_win") {
        msg = "All props found! Hunters win!";
      } else {
        msg = `Round ${this._roundNumber} ended.`;
      }

      OV.log(`[PH] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason);
      OV.broadcast(msg);
      this.broadcastHudState();

      this.scheduleRoundStart();
    },

    PlayerDeath(victim, _attacker) {
      if (!victim || this._roundState !== "active") return;

      if (victim.team() === TEAM_PROPS) {
        propsAlive = Math.max(0, propsAlive - 1);
        this.broadcastHudState();
        if (propsAlive === 0) {
          this.endRound("hunters_win");
        } else {
          OV.broadcast(`A prop was found! ${propsAlive} prop(s) remaining.`);
        }
      } else if (victim.team() === TEAM_HUNTERS) {
        huntersAlive = Math.max(0, huntersAlive - 1);
        this.broadcastHudState();
      }
    },

    // Extend the base HUD snapshot with Prop Hunt live values; the client
    // binds these to its ph_* elements.
    buildHudState() {
      const s = gamemode.getBase().buildHudState.call(this);
      s.propsAlive = propsAlive;
      s.huntersAlive = huntersAlive;
      s.locked = locked;
      return s;
    },

    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibePropHuntSpawnTip", function (ply) {
    if (locked && ply.team() === TEAM_HUNTERS) {
      ply.chat("Wait — hunters are locked until props hide.");
      return;
    }
    if (ply.team() === TEAM_PROPS) {
      ply.chat("Hide! Use !disguise crate, !disguise barrel, or !disguise chair.");
    } else {
      ply.chat("Hunt the props down!");
    }
  });

  gamemode.set(GM);
})();
