// OpenVibe base gamemode — client realm.
// Receives the HUD state snapshots the server broadcasts and forwards them to
// the HTML GUI overlay (window.OV.onHudState) through the menu bridge.
(function () {
  const GM = {
    mode: "base",
    name: "OpenVibe Base (client)",

    Initialize() {
      OV.log("Base client Initialize");
      GM.SetupHud();
    },

    // The base in-game GUI, coded in JS via the HUD library. Submodes call
    // super + HUD.Add to extend it; the page renders the layout generically.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.SetLayout([
        { id: "round",  type: "text",    anchor: "top",    bind: "round", size: 22 },
        { id: "team",   type: "text",    anchor: "top",    y: 30, bind: "team", size: 14, color: "#9fb4c7" },
        { id: "timer",  type: "timer",   anchor: "top",    y: 52, bind: "timer", size: 18 },
        { id: "health", type: "bar",     anchor: "bottom-left", bind: "health", max: 100, color: "#39d98a" },
        { id: "score",  type: "counter", anchor: "top-right", bind: "score", size: 16, hideWhenEmpty: true }
      ]);
    }
  };

  // Map a server HUD-state snapshot onto the JS HUD's bound values.
  function applyHudState(state) {
    if (!globalThis.HUD || !state) return;
    HUD.SetMany({
      round:  state.round != null ? state.round : (state.phase || ""),
      team:   state.team || state.teamName || "",
      timer:  state.timer != null ? state.timer : (state.timeLeft || 0),
      health: state.health != null ? state.health : 100,
      score:  state.score != null ? state.score : ""
    });
    HUD.Flush(true);
  }

  function pushHudToGui(state) {
    if (!OV || typeof OV.menuJS !== "function") return;
    try {
      const json = JSON.stringify(state).replace(/[\\"']/g, function (c) { return "\\" + c; });
      OV.menuJS('window.OV&&OV.onHudState&&OV.onHudState(JSON.parse("' + json + '"))');
    } catch (e) { /* GUI push is best-effort */ }
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive(globalThis.OVBase ? OVBase.HUD_NET : "OV_HudState", function () {
      const state = net.ReadTable();
      if (globalThis.OVBase) OVBase.hudState = state;
      hook.Run("OVHudState", state);
      applyHudState(state);   // JS-defined HUD (HUD library)
      pushHudToGui(state);    // legacy fixed overlay (back-compat)
    });
  }

  // Client realm mirrors the base gamemode so submode client files can derive.
  gamemode.setBase(GM);
  gamemode.set(GM, { base: true });
})();
