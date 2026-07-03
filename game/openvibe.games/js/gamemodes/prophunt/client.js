// OpenVibe Prop Hunt — client realm.
(function () {
  const TEAM_PROPS = 2, TEAM_HUNTERS = 3;

  const GM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt (client)",
    Initialize() { OV.log("Prop Hunt client Initialize"); }
  };

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_PH_Role", function () {
      const teamId = net.ReadInt();
      const lockSecs = net.ReadInt();
      const role = teamId === TEAM_HUNTERS ? "HUNTER" : "PROP";
      OV.log("[PH] You are a " + role + (teamId === TEAM_HUNTERS ? " (released in " + lockSecs + "s)" : " — hide!"));
      hook.Run("OVRoleAssigned", role, teamId, lockSecs);
      if (OV.menuJS) {
        OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',' + (lockSecs | 0) + ')');
      }
    });
  }

  gamemode.set(GM);
})();
