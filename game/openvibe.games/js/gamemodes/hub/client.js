// OpenVibe Hub — client realm.
(function () {
  const GM = {
    mode: "hub",
    name: "OpenVibe Hub (client)",

    Initialize() {
      OV.log("Hub client Initialize");
      GM.SetupHud();
    },

    // Minimal hub GUI, coded in JS via the HUD library. The devolved addon
    // owns the bottom-right corner (Bucks/Level) — never render those here.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "hub_title", type: "text", anchor: "top", text: "OPENVIBE HUB", size: 22, color: "#9fd0ff" });
      HUD.Add({ id: "hub_players", type: "text", anchor: "top", y: 30, bind: "hub_players", size: 14, color: "#9fb4c7", hideWhenEmpty: true });
      HUD.Add({ id: "hub_hint", type: "text", anchor: "bottom", text: "press C for cades — F10 console", size: 12, color: "#7c8ea0" });
    }
  };

  // Live values ride the base HUD-state broadcast (OV_HudState -> OVHudState).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibeHubHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      HUD.Set("hub_players", (state.players | 0) + " online");
      return undefined;
    });
  }

  gamemode.set(GM);
})();
