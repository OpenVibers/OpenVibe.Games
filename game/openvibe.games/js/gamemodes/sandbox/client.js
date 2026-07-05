// OpenVibe Sandbox — client realm.
(function () {
  OV.log("sandbox client.js running — realm server?=" + OV.isServer());

  // npm module usage on the CLIENT
  try {
    var leftpad = require("ov-leftpad");
    OV.log("client require('ov-leftpad')('9',4,'0')=" + leftpad("9", 4, "0"));
  } catch (e) { OV.error("client require failed: " + e.message); }

  const GM = {
    mode: "sandbox",
    name: "OpenVibe Sandbox (client)",

    Initialize() {
      OV.log("Sandbox client Initialize");
      GM.SetupHud();
    },

    // Sandbox GUI in JS: spawn hints up top, session prop counter top-right.
    SetupHud() {
      if (!globalThis.HUD) return;
      HUD.Add({ id: "sb_mode", type: "text", anchor: "top", bind: "sb_mode", size: 18, color: "#8ab8ff", hideWhenEmpty: true });
      HUD.Add({ id: "sb_hint", type: "text", anchor: "top", y: 24, text: "Q — spawn menu · C — cades · F10 — console", size: 13, color: "#b8c2d9" });
      HUD.Add({ id: "sb_props", type: "counter", anchor: "top-right", bind: "sb_props", size: 16, hideWhenEmpty: true });
      HUD.Set("sb_mode", "SANDBOX");
      HUD.Flush(true);
    }
  };

  // Prop count rides the base HUD-state broadcast (server buildHudState
  // extends it with propsSpawned).
  if (globalThis.hook) {
    hook.Add("OVHudState", "OpenVibeSandboxHud", function (state) {
      if (!globalThis.HUD || !state) return undefined;
      HUD.Set("sb_props", state.propsSpawned ? "Props: " + state.propsSpawned : "");
      return undefined;
    });
  }

  // server -> client net: receive a welcome the server pushes on spawn
  if (globalThis.net) {
    net.Receive("OV_Sandbox_Welcome", function (len) {
      var msg = net.ReadString();
      OV.log("CLIENT received OV_Sandbox_Welcome: " + msg);
    });
    OV.log("client net.Receive('OV_Sandbox_Welcome') ready");
  }

  // Q-menu spawn request: the GUI (or a keybind) triggers this; the server
  // validates the prop id — we never trust the client value there.
  if (globalThis.concommand) {
    concommand.Add("ov_qmenu_spawn", function (_ply, _cmd, args) {
      if (!globalThis.net) return;
      net.Start("OV_Sandbox_Spawn");
      net.WriteString(String(args[0] || "crate"));
      net.SendToServer();
    }, null, "Request a sandbox prop spawn from the server");
  }

  gamemode.set(GM);
})();
