// OpenVibe economy — client realm.
// Corner HUD (Bucks + Level) fed by "OVEcon_State", plus console commands:
//   ov_econ_inv      open the menu Inventory route (HTML GUI)
//   ov_econ_menu     toggle the cade quick menu (HTML GUI, bound to C)
//   ov_econ_refresh  ask the server to re-fetch + re-push economy state
//   ov_econ_cade <name>  buy/place a cade (server validates + charges)
(function () {
  var OV = globalThis.OV;
  var D = globalThis.OVEconomy;
  if (!D) { OV && OV.error && OV.error("[ov-econ] shared.js did not load; client disabled"); return; }

  function log(m) { if (OV && OV.log) OV.log("[ov-econ] " + m); }

  // ---- HUD: Bucks + Level in the bottom-right corner during gameplay ----
  if (globalThis.HUD && HUD.__openvibe) {
    HUD.Add({
      id: "dv_bucks", type: "counter", anchor: "bottom-right",
      x: 16, y: 44, bind: "dv_bucks", text: "Bucks",
      color: { r: 255, g: 200, b: 60 }, hideWhenEmpty: true
    });
    HUD.Add({
      id: "dv_level", type: "counter", anchor: "bottom-right",
      x: 16, y: 16, bind: "dv_level", text: "Level",
      color: { r: 120, g: 200, b: 255 }, hideWhenEmpty: true
    });
  }

  net.Receive(D.NET_STATE, function () {
    var st = net.ReadTable() || {};
    D.state = st;
    if (globalThis.HUD && HUD.__openvibe) {
      HUD.SetMany({ dv_bucks: st.bucks | 0, dv_level: st.lvl | 0 });
    }
    if (globalThis.hook) { try { hook.Run("OVEconStateUpdated", st); } catch (e) {} }
    log("state updated (bucks=" + (st.bucks | 0) + " lvl=" + (st.lvl | 0) + ")");
  });

  // ---- console commands (client realm) ----
  concommand.Add("ov_econ_refresh", function () {
    net.Start(D.NET_REFRESH);
    net.SendToServer();
  }, null, "Request an OpenVibe economy re-sync from the backend");

  // Open the HTML menu's inventory route. The engine client exposes
  // ov_menu_inventory (vgui_openvibe_menu.cpp: pause overlay in-game, full
  // shell at the main menu); OV.serverCommand forwards console lines to the
  // game DLL from the client runtime. Fallback: drive the page router
  // directly over the ov_menu_js bridge.
  concommand.Add("ov_econ_inv", function () {
    if (OV && typeof OV.serverCommand === "function") {
      OV.serverCommand("ov_menu_inventory");
    } else if (OV && typeof OV.menuJS === "function") {
      OV.menuJS('window.routeTo&&window.routeTo("inventory")');
    }
  }, null, "Open the OpenVibe inventory (menu route)");

  // Toggle the HTML cade/spawn quick menu (works in the menu panel and the
  // HUD overlay). Pushed script must stay semicolon-free — the engine's Cbuf
  // splits command lines on ';' — and OV.menuJS auto-chunks oversized pushes.
  concommand.Add("ov_econ_menu", function () {
    if (OV && typeof OV.menuJS === "function") {
      OV.menuJS("window.OVApp&&OVApp.toggleCadeMenu&&OVApp.toggleCadeMenu()");
    }
  }, null, "Toggle the OpenVibe cade quick menu (HTML GUI)");

  concommand.Add("ov_econ_cade", function (_ply, _cmd, args) {
    var name = args && args.length ? args.join(" ") : "";
    if (!name) { log("usage: ov_econ_cade <cade name>"); return; }
    net.Start(D.NET_CADE_BUY);
    net.WriteString(name);
    net.SendToServer();
  }, null, "Buy/place a cade by name");

  log("client loaded");
})();
