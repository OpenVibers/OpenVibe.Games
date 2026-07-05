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

  // ---- GMod-style console printing (lua print/Msg/PrintTable parity) ----
  // Works on BOTH backends: Node has console; the embedded QuickJS realm
  // doesn't, so js_run print(...) / console.log(...) used to throw there.
  function fmt(v, depth) {
    if (v === null) return "nil";
    if (v === undefined) return "nil";
    if (typeof v === "string") return v;
    if (typeof v === "function") return "function: " + (v.name || "anonymous");
    if (typeof v === "object") {
      try { return JSON.stringify(v, null, depth ? 2 : 0); } catch (e) { return String(v); }
    }
    return String(v);
  }
  function joinArgs(args) {
    var out = [];
    for (var i = 0; i < args.length; i++) out.push(fmt(args[i], false));
    return out.join("\t");
  }

  if (typeof globalThis.print !== "function") {
    globalThis.print = function () { OV && OV.log && OV.log(joinArgs(arguments)); };
  }
  if (typeof globalThis.Msg !== "function") {
    globalThis.Msg = function () { OV && OV.log && OV.log(joinArgs(arguments)); };
  }
  if (typeof globalThis.MsgN !== "function") globalThis.MsgN = globalThis.Msg;
  if (typeof globalThis.ErrorNoHalt !== "function") {
    globalThis.ErrorNoHalt = function () { OV && OV.warn && OV.warn(joinArgs(arguments)); };
  }
  // https://wiki.facepunch.com/gmod/Global.PrintTable
  if (typeof globalThis.PrintTable !== "function") {
    globalThis.PrintTable = function (tbl) {
      if (tbl == null || typeof tbl !== "object") { globalThis.print(tbl); return; }
      var text;
      try { text = JSON.stringify(tbl, function (k, v) { return typeof v === "function" ? "function: " + (v.name || "anonymous") : v; }, 2); }
      catch (e) { text = String(tbl); }
      String(text).split("\n").forEach(function (line) { OV && OV.log && OV.log(line); });
    };
  }
  // console shim for the embedded QuickJS backend (Node already has one).
  if (typeof globalThis.console === "undefined") {
    globalThis.console = {
      log: function () { OV && OV.log && OV.log(joinArgs(arguments)); },
      info: function () { OV && OV.log && OV.log(joinArgs(arguments)); },
      warn: function () { OV && OV.warn && OV.warn(joinArgs(arguments)); },
      error: function () { OV && OV.error && OV.error(joinArgs(arguments)); }
    };
  }
})();
