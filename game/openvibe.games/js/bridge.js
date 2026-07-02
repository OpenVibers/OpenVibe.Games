// OpenVibe C++ <-> JS bridge bootstrap.
//
// The C++ core loader only loads a fixed list of files (hook, gamemode, bridge,
// command, timer). We use this always-loaded file to bootstrap the higher-level
// platform that the C++ list doesn't know about — the CommonJS module system
// (require/npm) and the addon loader — by reading and evaluating them through
// the OV.readFile file bridge. This keeps those systems as normal on-disk files
// that can be edited/hotloaded without rebuilding the game DLLs.
(function () {
  if (globalThis.OV && typeof OV.log === "function") {
    OV.log("bridge.js loaded");
  }

  if (!globalThis.OV || typeof OV.readFile !== "function") {
    // Older DLL without the file bridge — platform features unavailable.
    return;
  }

  function bootstrap(path) {
    try {
      var code = OV.readFile(path);
      if (code == null) { OV.warn("bridge: missing " + path); return; }
      // Global eval so the file's top-level (function(){...})() runs in global scope.
      (0, eval)(code + "\n//# sourceURL=" + path);
    } catch (e) {
      OV.error("bridge: failed to load " + path + ": " + (e && e.message ? e.message : e));
    }
  }

  bootstrap("js/core/module.js"); // defines globalThis.require
  bootstrap("js/core/addon.js");  // defines globalThis.Addon

  // NOTE: Addon.loadAll() is intentionally NOT called here. bridge.js loads
  // before command.js/timer.js in the C++ core order, so addons that register
  // commands or timers would find them missing. base/server.js (loaded after
  // all core files, in both realms) triggers Addon.loadAll() instead.
})();
