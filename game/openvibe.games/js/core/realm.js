// OpenVibe realm globals — GMod States parity (SERVER / CLIENT).
// https://wiki.facepunch.com/gmod/States
//
// The menu realm (MENU) lives in the HTML GUI, not in this runtime.
(function () {
  var OV = globalThis.OV;
  var isServer = OV && typeof OV.isServer === "function" ? !!OV.isServer() : true;

  globalThis.SERVER = isServer;
  globalThis.CLIENT = !isServer;
  globalThis.MENU = false;

  // GMod-style validity check that also handles null/undefined and objects
  // exposing IsValid()/isValid().
  globalThis.IsValid = function (obj) {
    if (obj == null) return false;
    if (typeof obj.IsValid === "function") return !!obj.IsValid();
    if (typeof obj.isValid === "function") return !!obj.isValid();
    return true;
  };

  // CurTime parity — engine time via the bridge.
  if (!globalThis.CurTime) {
    globalThis.CurTime = function () { return OV && OV.time ? OV.time() : 0; };
  }
})();
