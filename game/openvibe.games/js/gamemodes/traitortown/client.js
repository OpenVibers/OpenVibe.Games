// OpenVibe Traitor Town — client realm.
(function () {
  const TEAM_TRAITOR = 3;
  const COLOR_INNOCENT = "#5cff8a", COLOR_TRAITOR = "#ff5c5c", COLOR_DETECTIVE = "#5ca9ff";

  const GM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town (client)",
    Initialize() {
      OV.log("Traitor Town client Initialize");
      GM.SetupHud();
    },

    // TTT GUI in JS: role card + karma bottom-left (classic TTT placement),
    // round number/timer up top, alive counter top-right.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "ttt_role", type: "text", anchor: "bottom-left", bind: "ttt_role", size: 22, hideWhenEmpty: true });
      HUD.Add({ id: "ttt_karma", type: "text", anchor: "bottom-left", y: 30, bind: "ttt_karma", size: 13, color: "#b8c2d9", hideWhenEmpty: true });
      HUD.Add({ id: "ttt_round", type: "text", anchor: "top", bind: "ttt_round", size: 20, hideWhenEmpty: true });
      HUD.Add({ id: "ttt_time", type: "timer", anchor: "top", y: 26, bind: "ttt_time", size: 18 });
      HUD.Add({ id: "ttt_alive", type: "counter", anchor: "top-right", bind: "ttt_alive", size: 16, hideWhenEmpty: true });
    }
  };

  // Round/timer/alive ride the base HUD-state broadcast (server buildHudState
  // extends it with aliveInnocents/aliveTraitors/alive).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibeTraitorTownHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      HUD.SetMany({
        ttt_round: state.round ? "ROUND " + state.round : "",
        ttt_time: state.timeLeft | 0,
        ttt_alive: state.alive != null && state.rolesAssigned ? "Alive: " + state.alive : ""
      });
      return undefined;
    });
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_TTT_Role", function () {
      const teamId = net.ReadInt();
      const isDetective = (net.ReadInt() | 0) === 1;
      const karma = net.ReadInt() | 0;
      const role = teamId === TEAM_TRAITOR ? "TRAITOR" : (isDetective ? "DETECTIVE" : "INNOCENT");
      const color = teamId === TEAM_TRAITOR ? COLOR_TRAITOR : (isDetective ? COLOR_DETECTIVE : COLOR_INNOCENT);
      // Role stays local to this client — never broadcast.
      OV.log("[TTT] Your role: " + role + " (karma " + karma + ")");
      hook.Run("OVRoleAssigned", role, teamId, 0);
      if (globalThis.HUD) {
        HUD.Set("ttt_role", role);
        HUD.Set("ttt_karma", karma ? "Karma: " + karma : "");
        HUD.GetLayout().forEach(function (el) { if (el.id === "ttt_role") el.color = color; });
        HUD.Flush(true);
      }
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',0)');
    });

    net.Receive("OV_TTT_Karma", function () {
      const karma = net.ReadInt() | 0;
      if (globalThis.HUD) {
        HUD.Set("ttt_karma", "Karma: " + karma);
        HUD.Flush();
      }
    });
  }

  gamemode.set(GM);
})();
