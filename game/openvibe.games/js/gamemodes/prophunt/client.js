// OpenVibe Prop Hunt — client realm.
(function () {
  const TEAM_PROPS = 2, TEAM_HUNTERS = 3;

  const GM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt (client)",
    Initialize() {
      OV.log("Prop Hunt client Initialize");
      // Prop Hunt extends the base HUD with its own JS-coded GUI: a role
      // badge and (for hunters) a release countdown.
      if (globalThis.HUD) {
        HUD.Add({ id: "ph_role", type: "text", anchor: "top-left", bind: "ph_role", size: 20, color: "#ffcf5c" });
        HUD.Add({ id: "ph_lock", type: "timer", anchor: "top-left", y: 26, bind: "ph_lock", size: 14, color: "#ff8a5c", hideWhenEmpty: true });
      }
    }
  };

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_PH_Role", function () {
      const teamId = net.ReadInt();
      const lockSecs = net.ReadInt();
      const role = teamId === TEAM_HUNTERS ? "HUNTER" : "PROP";
      OV.log("[PH] You are a " + role + (teamId === TEAM_HUNTERS ? " (released in " + lockSecs + "s)" : " — hide!"));
      hook.Run("OVRoleAssigned", role, teamId, lockSecs);
      if (globalThis.HUD) {
        HUD.Set("ph_role", role);
        HUD.Set("ph_lock", teamId === TEAM_HUNTERS ? lockSecs : 0);
        HUD.Flush(true);
      }
      if (OV.menuJS) {
        OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',' + (lockSecs | 0) + ')');
      }
    });
  }

  gamemode.set(GM);
})();
