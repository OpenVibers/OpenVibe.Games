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
    }
  };

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
