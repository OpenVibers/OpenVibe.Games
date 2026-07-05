// OpenVibe Prop Hunt — client realm.
(function () {
  const TEAM_PROPS = 2, TEAM_HUNTERS = 3;
  const COLOR_HIDER = "#50e3a4", COLOR_SEEKER = "#ff7a5c"; // team colors (props green / hunters red)

  const GM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt (client)",
    Initialize() {
      OV.log("Prop Hunt client Initialize");
      GM.SetupHud();
    },

    // Prop Hunt GUI, coded in JS via the HUD library: round number + timer up
    // top, role banner (with hunter release countdown) top-left, hiders
    // remaining top-right.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "ph_round", type: "text", anchor: "top", bind: "ph_round", size: 20, hideWhenEmpty: true });
      HUD.Add({ id: "ph_time", type: "timer", anchor: "top", y: 26, bind: "ph_time", size: 18 });
      HUD.Add({ id: "ph_role", type: "text", anchor: "top-left", bind: "ph_role", size: 20, color: "#ffcf5c" });
      HUD.Add({ id: "ph_lock", type: "timer", anchor: "top-left", y: 26, bind: "ph_lock", size: 14, color: "#ff8a5c", hideWhenEmpty: true });
      HUD.Add({ id: "ph_hiders", type: "counter", anchor: "top-right", bind: "ph_hiders", size: 16, hideWhenEmpty: true });
    }
  };

  // Round number / timer / hiders-remaining ride the base HUD-state broadcast
  // (the server round loop extends buildHudState with propsAlive et al).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibePropHuntHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      HUD.SetMany({
        ph_round: state.round ? "ROUND " + state.round : "",
        ph_time: state.timeLeft | 0,
        ph_hiders: state.propsAlive != null ? "Hiders: " + state.propsAlive : ""
      });
      return undefined;
    });
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_PH_Role", function () {
      const teamId = net.ReadInt();
      const lockSecs = net.ReadInt();
      const role = teamId === TEAM_HUNTERS ? "HUNTER" : "PROP";
      const banner = teamId === TEAM_HUNTERS ? "SEEKER" : "HIDER";
      OV.log("[PH] You are a " + role + (teamId === TEAM_HUNTERS ? " (released in " + lockSecs + "s)" : " — hide!"));
      hook.Run("OVRoleAssigned", role, teamId, lockSecs);
      if (globalThis.HUD) {
        HUD.Set("ph_role", banner);
        HUD.Set("ph_lock", teamId === TEAM_HUNTERS ? lockSecs : 0);
        HUD.GetLayout().forEach(function (el) {
          if (el.id === "ph_role") el.color = teamId === TEAM_HUNTERS ? COLOR_SEEKER : COLOR_HIDER;
        });
        HUD.Flush(true);
      }
      if (OV.menuJS) {
        OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',' + (lockSecs | 0) + ')');
      }
    });
  }

  gamemode.set(GM);
})();
