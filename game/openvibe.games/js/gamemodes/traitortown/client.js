// OpenVibe Traitor Town — client realm.
(function () {
  const TEAM_TRAITOR = 3;

  const GM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town (client)",
    Initialize() {
      OV.log("Traitor Town client Initialize");
      if (globalThis.HUD) {
        HUD.Add({ id: "ttt_role", type: "text", anchor: "bottom-right", bind: "ttt_role", size: 20 });
      }
    }
  };

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_TTT_Role", function () {
      const teamId = net.ReadInt();
      const role = teamId === TEAM_TRAITOR ? "TRAITOR" : "INNOCENT";
      // Role stays local to this client — never broadcast.
      OV.log("[TTT] Your role: " + role);
      hook.Run("OVRoleAssigned", role, teamId, 0);
      if (globalThis.HUD) {
        HUD.Set("ttt_role", role);
        HUD.GetLayout().forEach(function (el) { if (el.id === "ttt_role") el.color = teamId === TEAM_TRAITOR ? "#ff5c5c" : "#5cff8a"; });
        HUD.Flush(true);
      }
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onRole&&OV.onRole("' + role + '",' + (teamId | 0) + ',0)');
    });
  }

  gamemode.set(GM);
})();
