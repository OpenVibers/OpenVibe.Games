// OpenVibe Deathrun — client realm.
(function () {
  const TEAM_RUNNERS = 2, TEAM_ACTIVATORS = 3;
  const COLOR_RUNNER = "#5cb0ff", COLOR_DEATH = "#ff5c5c";

  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun (client)",
    Initialize() {
      OV.log("Deathrun client Initialize");
      GM.SetupHud();
    },

    // Deathrun GUI, coded in JS via the HUD library: role banner top-left,
    // round timer up top, runners-alive + map death counter top-right.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "dr_role", type: "text", anchor: "top-left", bind: "dr_role", size: 20, color: COLOR_RUNNER });
      HUD.Add({ id: "dr_time", type: "timer", anchor: "top", bind: "dr_time", size: 18 });
      HUD.Add({ id: "dr_runners", type: "counter", anchor: "top-right", bind: "dr_runners", size: 16, hideWhenEmpty: true });
      HUD.Add({ id: "dr_deaths", type: "counter", anchor: "top-right", y: 24, bind: "dr_deaths", size: 13, color: "#9fb4c7", hideWhenEmpty: true });
    }
  };

  // Timer / runners-alive / deaths-this-map ride the base HUD-state broadcast
  // (the server round loop extends buildHudState with them).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibeDeathrunHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      HUD.SetMany({
        dr_time: state.timeLeft | 0,
        dr_runners: state.runnersAlive != null ? "Runners: " + state.runnersAlive : "",
        dr_deaths: state.deathsThisMap != null ? "Deaths: " + state.deathsThisMap : ""
      });
      return undefined;
    });
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_DR_Role", function () {
      const teamId = net.ReadInt();
      const role = teamId === TEAM_ACTIVATORS ? "ACTIVATOR" : "RUNNER";
      const banner = teamId === TEAM_ACTIVATORS ? "DEATH" : "RUNNER";
      OV.log("[DR] You are the " + role);
      hook.Run("OVRoleAssigned", role, teamId, 0);
      if (globalThis.HUD) {
        HUD.Set("dr_role", banner);
        HUD.GetLayout().forEach(function (el) {
          if (el.id === "dr_role") el.color = teamId === TEAM_ACTIVATORS ? COLOR_DEATH : COLOR_RUNNER;
        });
        HUD.Flush(true);
      }
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',0)');
    });
  }

  gamemode.set(GM);
})();
