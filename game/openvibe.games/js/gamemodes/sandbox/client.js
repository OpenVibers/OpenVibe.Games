// OpenVibe Sandbox — CLIENT realm (runs inside client.dll QuickJS now).
OV.log("sandbox client.js running — realm server?=" + OV.isServer());

// npm module usage on the CLIENT
try {
  var leftpad = require("ov-leftpad");
  OV.log("client require('ov-leftpad')('9',4,'0')=" + leftpad("9", 4, "0"));
} catch (e) { OV.error("client require failed: " + e.message); }

// server -> client net: receive a welcome the server pushes on spawn
if (globalThis.net) {
  net.Receive("OV_Sandbox_Welcome", function (len) {
    var msg = net.ReadString();
    OV.log("CLIENT received OV_Sandbox_Welcome: " + msg);
  });
  OV.log("client net.Receive('OV_Sandbox_Welcome') ready");
}

// client Initialize hook
if (globalThis.hook) {
  hook.Add("Initialize", "SandboxClientInit", function () {
    OV.log("client Initialize hook fired");
  });
}
