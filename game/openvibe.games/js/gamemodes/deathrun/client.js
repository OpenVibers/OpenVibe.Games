// OpenVibe Deathrun — client realm.
(function () {
  const TEAM_RUNNERS = 2, TEAM_ACTIVATORS = 3;

  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun (client)",
    Initialize() { OV.log("Deathrun client Initialize"); }
  };

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_DR_Role", function () {
      const teamId = net.ReadInt();
      const role = teamId === TEAM_ACTIVATORS ? "ACTIVATOR" : "RUNNER";
      OV.log("[DR] You are the " + role);
      hook.Run("OVRoleAssigned", role, teamId, 0);
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',0)');
    });
  }

  gamemode.set(GM);
})();
