(function () {
  // Round state: "idle" → "countdown" → "active" → "ended"
  // Override startRound() and endRound() in submode gamemodes for custom logic.
  // RoundStart and RoundEnd hooks fire at the appropriate transitions.

  const DEFAULT_ROUND_DURATION = 300; // 5 minutes
  const DEFAULT_COUNTDOWN = 10;       // 10-second warmup

  const GM = {
    mode: "base",
    name: "OpenVibe Base",

    // Round settings — override in submode
    roundDuration: DEFAULT_ROUND_DURATION,
    countdownDuration: DEFAULT_COUNTDOWN,

    // Round tracking (do not override)
    _roundState: "idle",   // "idle" | "countdown" | "active" | "ended"
    _roundNumber: 0,

    Initialize() {
      OV.log("Base Initialize fired");
    },

    MapInitialize(mapName) {
      OV.log(`Base MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source.");
    },

    PlayerSpawn(_ply) {},

    PlayerDeath(_victim, _attacker) {},

    PlayerDisconnected(ply) {
      if (ply && typeof OV.log === "function") OV.log(`${ply.name()} disconnected.`);
    },

    PlayerSay(_ply, _text) {
      return undefined;
    },

    // Called when the countdown timer ends — fires "RoundStart" and runs round timer.
    startRound() {
      this._roundNumber += 1;
      this._roundState = "active";
      OV.log(`[OV Round] RoundStart round=${this._roundNumber}`);
      hook.Run("RoundStart", this._roundNumber);
      OV.broadcast(`Round ${this._roundNumber} — begin!`);

      const roundDuration = this.roundDuration;
      const roundNumber = this._roundNumber;
      const self = this;
      timer.create(`ov_round_end_${roundNumber}`, roundDuration, 1, function () {
        if (self._roundState === "active" && self._roundNumber === roundNumber) {
          self.endRound("time");
        }
      });
    },

    // Called to end the current active round. reason: "time" | "win" | "loss" | "draw"
    endRound(reason) {
      if (this._roundState !== "active") return;
      this._roundState = "ended";
      OV.log(`[OV Round] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason || "time");
      OV.broadcast(`Round ${this._roundNumber} ended (${reason || "time"}).`);
      timer.remove(`ov_round_end_${this._roundNumber}`);
      this.scheduleRoundStart();
    },

    // Begin countdown then start round.
    scheduleRoundStart() {
      const players = OV.players ? OV.players() : [];
      if (players.length === 0) {
        // No players — wait and retry
        this._roundState = "idle";
        const self = this;
        timer.simple(5, function () { self.scheduleRoundStart(); });
        return;
      }

      this._roundState = "countdown";
      const cd = this.countdownDuration;
      OV.broadcast(`Next round in ${cd} seconds.`);
      const self = this;
      timer.simple(cd, function () {
        if (self._roundState === "countdown") {
          self.startRound();
        }
      });
    },

    Think() {}
  };

  gamemode.setBase(GM);
  gamemode.set(GM, { base: true });
})();
