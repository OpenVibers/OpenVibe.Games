// OpenVibe Fort Wars — client realm.
(function () {
  const TEAM_RED = 2, TEAM_BLUE = 3;
  const COLOR_RED = "#ff6a5c", COLOR_BLUE = "#5c9dff";
  const COLOR_BUILD = "#ffcf5c", COLOR_FIGHT = "#ff5c5c";

  const GM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars (client)",
    Initialize() {
      OV.log("Fort Wars client Initialize");
      GM.SetupHud();
    },

    // Fort Wars GUI, coded in JS via the HUD library: phase banner + phase
    // countdown up top, team scores + own-team indicator top-right.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "fw_phase", type: "text", anchor: "top", bind: "fw_phase", size: 22, color: COLOR_BUILD, hideWhenEmpty: true });
      HUD.Add({ id: "fw_time", type: "timer", anchor: "top", y: 28, bind: "fw_time", size: 18 });
      HUD.Add({ id: "fw_score", type: "text", anchor: "top-right", bind: "fw_score", size: 16, hideWhenEmpty: true });
      HUD.Add({ id: "fw_team", type: "text", anchor: "top-right", y: 24, bind: "fw_team", size: 13, hideWhenEmpty: true });
    }
  };

  function setPhaseHud(phase, seconds) {
    if (!globalThis.HUD) return;
    const banner = String(phase || "").toUpperCase();
    HUD.Set("fw_phase", banner);
    if (seconds != null) HUD.Set("fw_time", seconds | 0);
    HUD.GetLayout().forEach(function (el) {
      if (el.id === "fw_phase") el.color = banner === "FIGHT" ? COLOR_FIGHT : COLOR_BUILD;
    });
  }

  // Scores + phase countdown ride the base HUD-state broadcast (the server
  // round loop extends buildHudState with phase/phaseTimeLeft/scores).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibeFortWarsHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      if (state.phase) setPhaseHud(state.phase, state.phaseTimeLeft);
      HUD.Set("fw_score", "RED " + (state.redScore | 0) + " : " + (state.blueScore | 0) + " BLU");
      return undefined;
    });
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_FW_Phase", function () {
      const phase = net.ReadString();
      const seconds = net.ReadInt();
      OV.log("[FW] Phase: " + phase + " (" + seconds + "s)");
      hook.Run("OVPhaseChanged", phase, seconds);
      setPhaseHud(phase, seconds);
      if (globalThis.HUD) HUD.Flush(true);
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onPhase&&OV.onPhase("' + phase + '",' + (seconds | 0) + ')');
    });

    // Private team assignment (your team indicator).
    net.Receive("OV_FW_Team", function () {
      const teamId = net.ReadInt();
      const label = teamId === TEAM_BLUE ? "BLUE TEAM" : "RED TEAM";
      OV.log("[FW] You are on " + label);
      hook.Run("OVRoleAssigned", label, teamId, 0);
      if (globalThis.HUD) {
        HUD.Set("fw_team", label);
        HUD.GetLayout().forEach(function (el) {
          if (el.id === "fw_team") el.color = teamId === TEAM_BLUE ? COLOR_BLUE : COLOR_RED;
        });
        HUD.Flush(true);
      }
    });
  }

  gamemode.set(GM);
})();
