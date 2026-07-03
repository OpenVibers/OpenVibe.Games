// OpenVibe base gamemode — client realm.
// Receives the HUD state snapshots the server broadcasts and forwards them to
// the HTML GUI overlay (window.OV.onHudState) through the menu bridge.
(function () {
  const GM = {
    mode: "base",
    name: "OpenVibe Base (client)",

    Initialize() {
      OV.log("Base client Initialize");
    }
  };

  function pushHudToGui(state) {
    if (!OV || typeof OV.menuJS !== "function") return;
    try {
      const json = JSON.stringify(state).replace(/[\\"']/g, function (c) { return "\\" + c; });
      // ov_menu_js -> panel RunJavascript. The GUI ignores it when no HUD view.
      OV.menuJS('window.OV&&OV.onHudState&&OV.onHudState(JSON.parse("' + json + '"))');
    } catch (e) { /* GUI push is best-effort */ }
  }

  if (globalThis.net && net.__openvibe) {
    net.Receive(globalThis.OVBase ? OVBase.HUD_NET : "OV_HudState", function () {
      const state = net.ReadTable();
      if (globalThis.OVBase) OVBase.hudState = state;
      hook.Run("OVHudState", state);
      pushHudToGui(state);
    });
  }

  // Client realm mirrors the base gamemode so submode client files can derive.
  gamemode.setBase(GM);
  gamemode.set(GM, { base: true });
})();
