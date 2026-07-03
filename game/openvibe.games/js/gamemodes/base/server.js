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
    _roundEndsAt: 0,

    Initialize() {
      OV.log("Base Initialize fired");
    },

    // Define teams via team.SetUp here (submodes override).
    CreateTeams() {
      if (globalThis.team) {
        team.SetUp(0, "Unassigned", Color(200, 200, 200));
        team.SetUp(1, "Spectator", Color(150, 150, 150), false);
      }
    },

    MapInitialize(mapName) {
      OV.log(`Base MapInitialize: ${mapName}`);
      this.scheduleRoundStart();
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source.");
      this.broadcastHudState();
    },

    PlayerSpawn(ply) {
      hook.Run("PlayerLoadout", ply);
    },

    PlayerLoadout(_ply) {},

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
      this._roundEndsAt = OV.time() + this.roundDuration;
      OV.log(`[OV Round] RoundStart round=${this._roundNumber}`);
      hook.Run("RoundStart", this._roundNumber);
      OV.broadcast(`Round ${this._roundNumber} — begin!`);
      this.broadcastHudState();

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
      this._roundEndsAt = 0;
      OV.log(`[OV Round] RoundEnd round=${this._roundNumber} reason=${reason}`);
      hook.Run("RoundEnd", this._roundNumber, reason || "time");
      OV.broadcast(`Round ${this._roundNumber} ended (${reason || "time"}).`);
      this.broadcastHudState();
      timer.remove(`ov_round_end_${this._roundNumber}`);
      this.scheduleRoundStart();
    },

    // ---- HUD state replication (drives the HTML HUD overlay) ----
    // Broadcasts a compact snapshot over the net library; the client realm
    // forwards it into the GUI (window.OV.onHudState).
    buildHudState() {
      const teams = [];
      if (globalThis.team && team.GetAllTeams) {
        const all = team.GetAllTeams();
        for (const id in all) {
          teams.push({
            id: id | 0, name: all[id].name, color: all[id].color,
            score: all[id].score, players: team.NumPlayers(id | 0)
          });
        }
      }
      return {
        mode: this.mode, name: this.name,
        state: this._roundState, round: this._roundNumber,
        timeLeft: this._roundEndsAt ? Math.max(0, Math.round(this._roundEndsAt - OV.time())) : 0,
        players: (OV.players ? OV.players() : []).length,
        teams
      };
    },

    broadcastHudState() {
      if (!globalThis.net || !net.__openvibe) return;
      try {
        net.Start(globalThis.OVBase ? OVBase.HUD_NET : "OV_HudState");
        net.WriteTable(this.buildHudState());
        net.Broadcast();
      } catch (e) { /* net transport not up yet */ }
    },

    _startHudTicker() {
      const self = this;
      if (globalThis.timer && timer.create) {
        timer.create("ov_hud_state", 3, 0, function () { self.broadcastHudState(); });
      }
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

  // Base setup that must run for EVERY mode, even ones that override
  // GM.Initialize without calling up the chain (hook.Add'd hooks always run
  // before the GM method and cannot be shadowed by submodes).
  hook.Add("Initialize", "OpenVibeBaseSetup", function () {
    if (globalThis.util && util.AddNetworkString) util.AddNetworkString(globalThis.OVBase ? OVBase.HUD_NET : "OV_HudState");
    hook.Run("CreateTeams");
    const gm = gamemode.get();
    if (gm && typeof gm._startHudTicker === "function") gm._startHudTicker();
    return undefined;
  });

  // Load addons now that all core systems (require, hook, command, timer,
  // gamemode) are available. Runs in both realms; Addon.loadAll() picks the
  // right per-realm entry files via OV.isServer(). The active gamemode file
  // loads immediately after this, so addon hooks are registered first and can
  // override gamemode behavior — matching GMod's addon-over-gamemode ordering.
  try {
    if (globalThis.Addon && typeof Addon.loadAll === "function") {
      Addon.loadAll();
    }
  } catch (e) {
    if (globalThis.OV && OV.error) OV.error("base: addon load failed: " + (e && e.message ? e.message : e));
  }
})();
