// OpenVibe concommand library — GMod concommand semantics.
// https://wiki.facepunch.com/gmod/concommand
//
// Realm-local registry. Server commands are dispatched from the
// "ConsoleCommand" hook (fed by the ov_js_cmd ConCommand and the runtime
// control server); client commands from the client runtime's /exec channel.
// RunConsoleCommand forwards to the engine through the bridge, with a
// blocklist so scripts can never trigger the client-realm eval commands.
(function () {
  if (globalThis.concommand && globalThis.concommand.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  var commands = Object.create(null); // lowercase name -> {fn, help}

  // Commands Lua/JS may never trigger programmatically (GMod Blocked_ConCommands
  // spirit): client-realm eval + engine-critical toggles.
  var BLOCKED = { js_run_cl: 1, js_openscript_cl: 1, ov_js_run_cl: 1, exec: 1, connect: 1, retry: 1, bind: 1, unbindall: 1, alias: 1, sv_cheats: 1 };

  function parseArgs(str) {
    var out = [];
    var rx = /"([^"]*)"|(\S+)/g, m;
    while ((m = rx.exec(str))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  var concommand = {
    __openvibe: true,
    Add: function (name, fn, autoComplete, helpText) {
      if (typeof fn !== "function") throw new Error("concommand.Add requires a callback");
      commands[String(name).toLowerCase()] = { fn: fn, help: helpText || "" };
    },
    Remove: function (name) { delete commands[String(name).toLowerCase()]; },
    GetTable: function () {
      var out = {};
      for (var k in commands) out[k] = commands[k].fn;
      return out;
    },
    Run: function (ply, cmd, args, argStr) {
      var entry = commands[String(cmd).toLowerCase()];
      if (!entry) return false;
      try { entry.fn(ply || null, String(cmd), args || [], argStr || ""); }
      catch (e) { OV && OV.error && OV.error("concommand '" + cmd + "': " + (e && e.stack ? e.stack : e)); }
      return true;
    },
    // Dispatch a raw console line ("name arg1 arg2 ...").
    Dispatch: function (ply, line) {
      line = String(line || "").trim();
      if (!line) return false;
      var space = line.indexOf(" ");
      var name = space < 0 ? line : line.slice(0, space);
      var argStr = space < 0 ? "" : line.slice(space + 1);
      return concommand.Run(ply, name, parseArgs(argStr), argStr);
    }
  };

  globalThis.concommand = concommand;

  globalThis.RunConsoleCommand = function (name) {
    name = String(name).toLowerCase();
    if (BLOCKED[name]) {
      OV && OV.warn && OV.warn("RunConsoleCommand: '" + name + "' is blocked");
      return;
    }
    var args = Array.prototype.slice.call(arguments, 1).map(String);
    var line = name + (args.length ? " " + args.map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }).join(" ") : "");
    if (concommand.Dispatch(null, line)) return; // JS-registered command
    if (OV && OV.serverCommand) OV.serverCommand(line); // engine (ov_*/say allowlist applies)
  };

  // Server realm: wire into the existing ConsoleCommand hook (ov_js_cmd text).
  if (globalThis.hook && typeof hook.Add === "function") {
    hook.Add("ConsoleCommand", "OpenVibeConCommandDispatch", function (text) {
      if (concommand.Dispatch(null, text)) return false; // handled
      return undefined;
    });
  }

  if (OV && OV.log) OV.log("concommand library ready");
})();
