// OpenVibe Fort Wars — client realm.
(function () {
  const GM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars (client)",
    Initialize() { OV.log("Fort Wars client Initialize"); }
  };

  if (globalThis.net && net.__openvibe) {
    net.Receive("OV_FW_Phase", function () {
      const phase = net.ReadString();
      const seconds = net.ReadInt();
      OV.log("[FW] Phase: " + phase + " (" + seconds + "s)");
      hook.Run("OVPhaseChanged", phase, seconds);
      if (OV.menuJS) OV.menuJS('window.OV&&OV.onPhase&&OV.onPhase("' + phase + '",' + (seconds | 0) + ')');
    });
  }

  gamemode.set(GM);
})();
